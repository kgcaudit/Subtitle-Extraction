package com.kgc.subex

import android.content.Context
import android.net.Uri
import com.kgc.subex.core.Cue
import com.kgc.subex.core.Postprocess
import com.kgc.subex.core.Srt
import com.kgc.subex.core.SubtitleTrackInfo
import com.kgc.subex.core.TrackKind
import com.kgc.subex.media.RawCue
import com.kgc.subex.media.SubtitleReader
import com.kgc.subex.ocr.BitmapPrep
import com.kgc.subex.ocr.KoreanOcr
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 추출이 어디까지 진행됐는지. */
sealed interface Progress {
    data class Reading(val cueCount: Int) : Progress
    data class Recognizing(val done: Int, val total: Int) : Progress
    data object Finishing : Progress
}

/** 트랙 하나의 추출 결과. */
data class ExtractionResult(
    val track: SubtitleTrackInfo,
    val cues: List<Cue>,
    val fileName: String,
) {
    val srtText: String get() = Srt.render(cues)
}

/**
 * 트랙 하나를 SRT 까지 끌고 가는 전체 흐름.
 *
 *   자막 트랙 ─ 글자 자막 ─────────────────────────┐
 *              └ 그림 자막 ─ 전처리 ─ 문자 인식 ──┴─ 다듬기 ─ SRT
 *
 * 다듬는 규칙(빈 줄 제거·겹침 정리·중복 병합)은 core 에 있고, 파이썬판과
 * 같은 결과를 내는지 대조 테스트로 확인돼 있다.
 */
class ExtractionEngine(private val context: Context) {

    suspend fun extract(
        uri: Uri,
        videoName: String,
        track: SubtitleTrackInfo,
        onProgress: (Progress) -> Unit = {},
    ): ExtractionResult = withContext(Dispatchers.Default) {
        val reader = SubtitleReader(context)
        val rawCues = reader.readCues(uri, track) { count -> onProgress(Progress.Reading(count)) }

        val cues = when (track.kind) {
            TrackKind.TEXT -> rawCues.mapNotNull { raw ->
                (raw as? RawCue.Text)?.let { Cue(it.startMs, it.endMs, it.text) }
            }

            TrackKind.BITMAP -> recognize(rawCues, onProgress)
        }

        onProgress(Progress.Finishing)
        // 글자 자막에는 ASS 스타일 태그가 섞여 있을 수 있지만, 문자 인식 결과에는
        // 있을 리가 없다. 괜히 지우려다 본문을 건드리지 않도록 구분한다.
        val tidied = Postprocess.tidy(cues, stripStyling = track.kind == TrackKind.TEXT)

        ExtractionResult(track, tidied, track.outputFileName(videoName))
    }

    private suspend fun recognize(rawCues: List<RawCue>, onProgress: (Progress) -> Unit): List<Cue> {
        val images = rawCues.filterIsInstance<RawCue.Image>()
        if (images.isEmpty()) return emptyList()

        onProgress(Progress.Recognizing(0, images.size))
        return KoreanOcr().use { ocr ->
            images.mapIndexed { index, image ->
                val prepared = BitmapPrep.prepare(image.bitmap)
                val text = ocr.recognize(prepared)
                prepared.recycle()
                onProgress(Progress.Recognizing(index + 1, images.size))
                Cue(image.startMs, image.endMs, text)
            }
        }
    }
}
