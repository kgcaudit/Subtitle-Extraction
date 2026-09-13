package com.kgc.subex

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kgc.subex.core.SubtitleTrackInfo
import com.kgc.subex.io.SrtFiles
import com.kgc.subex.media.SubtitleReader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.system.measureTimeMillis

/** 화면에 그릴 상태 전부. */
data class UiState(
    val videoUri: Uri? = null,
    val videoName: String = "",
    val tracks: List<SubtitleTrackInfo> = emptyList(),
    val selected: Set<Int> = emptySet(),      // subtitleIndex 기준
    val isBusy: Boolean = false,
    val statusLine: String = "",
    val results: List<ExtractionResult> = emptyList(),
    val savedTo: String? = null,
    val error: String? = null,
) {
    val hasVideo: Boolean get() = videoUri != null
    val canExtract: Boolean get() = hasVideo && selected.isNotEmpty() && !isBusy
}

class SubexViewModel(application: Application) : AndroidViewModel(application) {

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    fun openVideo(uri: Uri) {
        viewModelScope.launch {
            _state.update { UiState(isBusy = true, statusLine = "자막 트랙을 찾는 중…") }
            try {
                val context = getApplication<Application>()
                val name = withContext(Dispatchers.IO) { SrtFiles.displayName(context, uri) }
                val tracks = withContext(Dispatchers.IO) { SubtitleReader(context).listTracks(uri) }

                _state.value = UiState(
                    videoUri = uri,
                    videoName = name,
                    tracks = tracks,
                    // 다룰 수 있는 트랙은 기본으로 전부 선택해 둔다.
                    selected = tracks.filter { it.isSupported }.map { it.subtitleIndex }.toSet(),
                    statusLine = when {
                        tracks.isEmpty() ->
                            "자막 트랙이 없습니다. 화면에 새겨진(번인) 자막이거나 음성만 있는 영상일 수 있습니다."
                        else -> "자막 트랙 ${tracks.size}개를 찾았습니다."
                    },
                )
            } catch (error: Throwable) {
                _state.value = UiState(error = "파일을 열지 못했습니다: ${error.message}")
            }
        }
    }

    fun toggleTrack(subtitleIndex: Int) {
        _state.update { current ->
            val selected = current.selected.toMutableSet()
            if (!selected.add(subtitleIndex)) selected.remove(subtitleIndex)
            current.copy(selected = selected, savedTo = null)
        }
    }

    fun extract() {
        val current = _state.value
        val uri = current.videoUri ?: return

        viewModelScope.launch {
            _state.update { it.copy(isBusy = true, results = emptyList(), savedTo = null, error = null) }
            val engine = ExtractionEngine(getApplication())
            val results = mutableListOf<ExtractionResult>()

            try {
                for (track in current.tracks.filter { it.subtitleIndex in current.selected }) {
                    if (!track.isSupported) continue

                    val label = "트랙 #${track.subtitleIndex} (${track.formatName})"
                    val elapsed = measureTimeMillis {
                        val result = engine.extract(uri, current.videoName, track) { progress ->
                            _state.update { it.copy(statusLine = describe(label, progress)) }
                        }
                        if (result.cues.isNotEmpty()) results += result
                    }
                    _state.update {
                        it.copy(statusLine = "$label 완료 (${elapsed / 1000.0}초)", results = results.toList())
                    }
                }

                _state.update {
                    it.copy(
                        isBusy = false,
                        results = results.toList(),
                        statusLine = if (results.isEmpty()) {
                            "추출된 자막이 없습니다."
                        } else {
                            "${results.size}개 자막을 만들었습니다. 저장할 폴더를 고르세요."
                        },
                    )
                }
            } catch (error: Throwable) {
                _state.update {
                    it.copy(isBusy = false, error = "추출 중 문제가 생겼습니다: ${error.message}")
                }
            }
        }
    }

    fun saveAll(treeUri: Uri) {
        val results = _state.value.results
        if (results.isEmpty()) return

        viewModelScope.launch {
            _state.update { it.copy(isBusy = true, statusLine = "저장하는 중…", error = null) }
            try {
                val context = getApplication<Application>()
                val names = withContext(Dispatchers.IO) {
                    results.map { SrtFiles.writeToTree(context, treeUri, it.fileName, it.srtText) }
                }
                _state.update {
                    it.copy(
                        isBusy = false,
                        savedTo = names.joinToString(", "),
                        statusLine = "${names.size}개 파일을 저장했습니다.",
                    )
                }
            } catch (error: Throwable) {
                _state.update {
                    it.copy(isBusy = false, error = "저장하지 못했습니다: ${error.message}")
                }
            }
        }
    }

    fun dismissError() = _state.update { it.copy(error = null) }

    private fun describe(label: String, progress: Progress): String = when (progress) {
        is Progress.Reading -> "$label — 자막 읽는 중 ${progress.cueCount}개"
        is Progress.Recognizing ->
            "$label — 문자 인식 ${progress.done}/${progress.total}" +
                if (progress.total > 0) " (${progress.done * 100 / progress.total}%)" else ""
        Progress.Finishing -> "$label — 다듬는 중…"
    }
}
