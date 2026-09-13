package com.kgc.subex.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.kgc.subex.ExtractionResult
import com.kgc.subex.UiState
import com.kgc.subex.core.SubtitleTrackInfo
import com.kgc.subex.core.TrackKind

/**
 * 화면 전체를 목록 하나로 그린다. 스크롤되는 것을 겹쳐 놓으면 높이 계산이
 * 어긋나 터지기 때문에, 바깥에 따로 스크롤을 두지 않는다.
 */
@Composable
fun SubexScreen(
    state: UiState,
    onPickVideo: () -> Unit,
    onToggleTrack: (Int) -> Unit,
    onExtract: () -> Unit,
    onPickFolder: () -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 16.dp),
    ) {
        item {
            Text("영상 자막 추출", style = MaterialTheme.typography.headlineSmall)
        }

        item {
            Button(onClick = onPickVideo, enabled = !state.isBusy, modifier = Modifier.fillMaxWidth()) {
                Text(if (state.hasVideo) "다른 영상 고르기" else "영상 고르기")
            }
        }

        if (state.hasVideo) {
            item { Text(state.videoName, style = MaterialTheme.typography.titleMedium) }
        }

        state.error?.let { message ->
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        message,
                        modifier = Modifier.padding(12.dp),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }

        if (state.statusLine.isNotEmpty()) {
            item { Text(state.statusLine, style = MaterialTheme.typography.bodyMedium) }
        }

        if (state.isBusy) {
            item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
        }

        if (state.tracks.isNotEmpty()) {
            item {
                HorizontalDivider()
                Text("자막 트랙", style = MaterialTheme.typography.titleSmall)
            }
            items(state.tracks, key = { "track-${it.subtitleIndex}" }) { track ->
                TrackRow(
                    track = track,
                    checked = track.subtitleIndex in state.selected,
                    enabled = track.isSupported && !state.isBusy,
                    onToggle = { onToggleTrack(track.subtitleIndex) },
                )
            }
            item {
                Button(
                    onClick = onExtract,
                    enabled = state.canExtract,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("선택한 자막 추출")
                }
            }
        }

        if (state.results.isNotEmpty()) {
            item {
                HorizontalDivider()
                Text("결과", style = MaterialTheme.typography.titleSmall)
            }
            items(state.results, key = { "result-${it.fileName}" }) { result -> ResultCard(result) }
            item {
                OutlinedButton(
                    onClick = onPickFolder,
                    enabled = !state.isBusy,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("저장할 폴더 고르기")
                }
            }
            state.savedTo?.let { saved ->
                item { Text("저장됨: $saved", style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

@Composable
private fun TrackRow(
    track: SubtitleTrackInfo,
    checked: Boolean,
    enabled: Boolean,
    onToggle: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Checkbox(checked = checked, onCheckedChange = { onToggle() }, enabled = enabled)
        Column(modifier = Modifier.weight(1f)) {
            Text(track.describe(), style = MaterialTheme.typography.bodyMedium)
            Text(
                when {
                    !track.isSupported -> "지원하지 않는 형식이라 건너뜁니다"
                    track.kind == TrackKind.BITMAP -> "그림 자막 — 문자 인식을 거칩니다 (시간이 걸립니다)"
                    else -> "글자 자막 — 바로 변환됩니다"
                },
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun ResultCard(result: ExtractionResult) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(result.fileName, style = MaterialTheme.typography.titleSmall)
            Text("${result.cues.size}줄", style = MaterialTheme.typography.bodySmall)
            // 결과가 맞는지 눈으로 바로 확인할 수 있게 앞부분을 보여 준다.
            val preview = result.cues.take(3).joinToString("\n") { it.text }
            if (preview.isNotEmpty()) {
                Text(
                    preview,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                )
            }
        }
    }
}
