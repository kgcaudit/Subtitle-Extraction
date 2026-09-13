package com.kgc.subex.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.media.MediaFormat
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.text.Cue as Media3Cue
import androidx.media3.common.util.MediaFormatUtil
import androidx.media3.extractor.text.CuesWithTiming
import androidx.media3.extractor.text.DefaultSubtitleParserFactory
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.inspector.MediaExtractorCompat
import com.kgc.subex.core.SubtitleTrackInfo
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** 아직 글자가 되기 전의 자막 한 덩어리. */
sealed interface RawCue {
    val startMs: Long
    val endMs: Long

    data class Text(override val startMs: Long, override val endMs: Long, val text: String) : RawCue

    data class Image(override val startMs: Long, override val endMs: Long, val bitmap: Bitmap) : RawCue
}

/**
 * 영상 컨테이너에서 자막을 꺼낸다.
 *
 * 컨테이너 해체와 자막 해독은 Media3 가 전부 해 준다. PGS·VobSub·DVB 해독기가
 * 안드로이드 Bitmap 을 그대로 내주므로, 그림 자막은 그 비트맵을 문자 인식에 넘기면 된다.
 *
 * 시각 처리에 주의할 점이 하나 있다. PGS 해독기는 자기 시각을 모른다고 알려 온다
 * (startTimeUs = TIME_UNSET). 그림 자막의 시각은 컨테이너가 들고 있기 때문이다.
 * 그래서 시작은 샘플의 표시 시각을 쓰고, 끝은 해독기가 알려 주면 그걸,
 * 아니면 다음 자막이 나타나는 시각을 쓴다. 파이썬판과 같은 규칙이다.
 */
class SubtitleReader(private val context: Context) {

    /** 파일 안의 자막 트랙 목록. */
    fun listTracks(uri: Uri): List<SubtitleTrackInfo> {
        val extractor = open(uri)
        try {
            val tracks = mutableListOf<SubtitleTrackInfo>()
            var subtitleIndex = 0
            for (index in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(index)
                val mimeType = format.getString(MediaFormat.KEY_MIME) ?: continue
                if (!mimeType.startsWith("text/") && !mimeType.isSubtitleApplicationType()) continue

                tracks += SubtitleTrackInfo(
                    trackIndex = index,
                    subtitleIndex = subtitleIndex++,
                    mimeType = mimeType,
                    language = format.stringOrNull(MediaFormat.KEY_LANGUAGE),
                    label = null,
                    isDefault = format.intOrZero(MediaFormat.KEY_IS_DEFAULT) == 1,
                    isForced = format.intOrZero(KEY_IS_FORCED_SUBTITLE) == 1,
                )
            }
            return tracks
        } finally {
            extractor.release()
        }
    }

    /**
     * 트랙 하나의 자막을 전부 읽는다.
     *
     * @param onProgress 읽은 개수를 알려 준다. 전체 개수는 미리 알 수 없다.
     */
    fun readCues(uri: Uri, track: SubtitleTrackInfo, onProgress: (Int) -> Unit = {}): List<RawCue> {
        val extractor = open(uri)
        try {
            val mediaFormat = extractor.getTrackFormat(track.trackIndex)
            val parser = DefaultSubtitleParserFactory()
                .create(MediaFormatUtil.createFormatFromMediaFormat(mediaFormat))
            extractor.selectTrack(track.trackIndex)

            val pending = mutableListOf<PendingCue>()
            var buffer = ByteBuffer.allocate(INITIAL_BUFFER_BYTES)

            while (true) {
                val sampleSize = extractor.sampleSize
                if (sampleSize > buffer.capacity()) {
                    buffer = ByteBuffer.allocate(sampleSize.toInt().coerceAtMost(MAX_BUFFER_BYTES))
                }
                buffer.clear()
                val read = extractor.readSampleData(buffer, 0)
                if (read < 0) break

                val startMs = extractor.sampleTime / 1000
                val data = ByteArray(read)
                buffer.position(0)
                buffer.get(data, 0, read)

                parser.parse(data, 0, read, SubtitleParser.OutputOptions.allCues()) { cues ->
                    pending += toPending(startMs, cues)
                }
                onProgress(pending.size)
                extractor.advance()
            }
            parser.reset()
            return resolveEndTimes(pending)
        } finally {
            extractor.release()
        }
    }

    // --- 내부 구현 ---------------------------------------------------------

    /** 끝 시각이 아직 정해지지 않았을 수 있는 상태. */
    private class PendingCue(
        val startMs: Long,
        val declaredEndMs: Long?,
        val text: String?,
        val bitmap: Bitmap?,
    )

    private fun open(uri: Uri): MediaExtractorCompat {
        val extractor = MediaExtractorCompat(context)
        extractor.setDataSource(context, uri, null)
        return extractor
    }

    private fun toPending(sampleStartMs: Long, cues: CuesWithTiming): PendingCue {
        // 해독기가 시각을 알려 주면 그쪽이 더 정확하다(예: VobSub 은 제어 명령에 들어 있다).
        val startMs = if (cues.startTimeUs != C.TIME_UNSET) cues.startTimeUs / 1000 else sampleStartMs
        val endMs = if (cues.durationUs != C.TIME_UNSET) startMs + cues.durationUs / 1000 else null

        val bitmap = composite(cues.cues)
        val text = cues.cues.mapNotNull { it.text?.toString() }
            .filter { it.isNotBlank() }
            .joinToString("\n")
            .takeIf { it.isNotEmpty() }

        return PendingCue(startMs, endMs, text, bitmap)
    }

    /**
     * 끝 시각이 없는 자막은 다음 자막이 나타날 때 사라진다고 본다.
     *
     * 그림 자막에서 내용이 비어 있는 덩어리는 '화면 지우기' 신호다. 그 자체가
     * 자막은 아니고, 앞 자막의 끝 시각 노릇만 한다.
     */
    private fun resolveEndTimes(pending: List<PendingCue>): List<RawCue> {
        val result = mutableListOf<RawCue>()
        for ((index, cue) in pending.withIndex()) {
            if (cue.text == null && cue.bitmap == null) continue

            val nextStart = pending.asSequence().drop(index + 1).firstOrNull()?.startMs
            val endMs = cue.declaredEndMs
                ?: nextStart
                ?: (cue.startMs + DANGLING_DURATION_MS)

            if (endMs <= cue.startMs) continue
            result += when {
                cue.bitmap != null -> RawCue.Image(cue.startMs, endMs, cue.bitmap)
                else -> RawCue.Text(cue.startMs, endMs, cue.text!!)
            }
        }
        return result
    }

    /**
     * 한 덩어리에 그림 조각이 여럿이면(보통 두 줄짜리 자막) 원래 배치대로 합친다.
     *
     * Media3 는 조각의 위치를 화면 대비 비율로 알려 주므로, 조각 크기와 비율로
     * 원래 화면 크기를 되짚은 다음 그 좌표에 얹는다. 화면 전체를 만들면 메모리가
     * 아까우니 조각들을 감싸는 최소 범위만 만든다.
     */
    private fun composite(cues: List<Media3Cue>): Bitmap? {
        val pieces = cues.filter { it.bitmap != null }
        if (pieces.isEmpty()) return null
        if (pieces.size == 1) return pieces[0].bitmap

        var planeWidth = 0
        var planeHeight = 0
        for (piece in pieces) {
            val bitmap = piece.bitmap ?: continue
            if (piece.size > 0f) planeWidth = max(planeWidth, (bitmap.width / piece.size).roundToInt())
            if (piece.bitmapHeight > 0f) {
                planeHeight = max(planeHeight, (bitmap.height / piece.bitmapHeight).roundToInt())
            }
        }
        if (planeWidth <= 0 || planeHeight <= 0) return stackVertically(pieces.mapNotNull { it.bitmap })

        data class Placed(val bitmap: Bitmap, val x: Int, val y: Int)

        val placed = pieces.mapNotNull { piece ->
            val bitmap = piece.bitmap ?: return@mapNotNull null
            val x = if (piece.position != Media3Cue.DIMEN_UNSET) (piece.position * planeWidth).roundToInt() else 0
            val y = if (piece.line != Media3Cue.DIMEN_UNSET) (piece.line * planeHeight).roundToInt() else 0
            Placed(bitmap, x, y)
        }
        if (placed.isEmpty()) return null

        val left = placed.minOf { it.x }
        val top = placed.minOf { it.y }
        val right = placed.maxOf { it.x + it.bitmap.width }
        val bottom = placed.maxOf { it.y + it.bitmap.height }
        val width = (right - left).coerceIn(1, MAX_CANVAS_SIDE)
        val height = (bottom - top).coerceIn(1, MAX_CANVAS_SIDE)

        val canvasBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(canvasBitmap)
        for (item in placed) {
            canvas.drawBitmap(item.bitmap, (item.x - left).toFloat(), (item.y - top).toFloat(), null)
        }
        return canvasBitmap
    }

    /** 배치 정보를 못 믿을 때의 대비책: 읽는 순서대로 세로로 쌓는다. */
    private fun stackVertically(bitmaps: List<Bitmap>): Bitmap? {
        if (bitmaps.isEmpty()) return null
        val width = min(bitmaps.maxOf { it.width }, MAX_CANVAS_SIDE)
        val height = min(bitmaps.sumOf { it.height + STACK_GAP_PX }, MAX_CANVAS_SIDE)
        val result = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        var offsetY = 0
        for (bitmap in bitmaps) {
            canvas.drawBitmap(bitmap, ((width - bitmap.width) / 2).toFloat(), offsetY.toFloat(), null)
            offsetY += bitmap.height + STACK_GAP_PX
        }
        return result
    }

    /**
     * 자막 트랙으로 볼지 판단한다.
     *
     * 다룰 수 있는 형식뿐 아니라 '자막처럼 보이는데 못 다루는' 형식도 목록에는
     * 올린다. 그래야 사용자가 자막이 있다는 사실 자체는 알 수 있다.
     */
    private fun String.isSubtitleApplicationType(): Boolean =
        this in SubtitleTrackInfo.SUPPORTED_MIME_TYPES ||
            (startsWith("application/") && (contains("sub") || contains("pgs") || contains("teletext")))

    // MediaFormat.containsKey 와 기본값을 받는 getter 는 Android 10(API 29)부터다.
    // 그 이전 기기에서는 없는 열쇠를 물으면 예외가 나므로 직접 감싼다.
    private fun MediaFormat.stringOrNull(key: String): String? = try {
        getString(key)?.takeIf { it.isNotBlank() && it != "und" }
    } catch (_: RuntimeException) {
        null
    }

    private fun MediaFormat.intOrZero(key: String): Int = try {
        getInteger(key)
    } catch (_: RuntimeException) {
        0
    }

    private companion object {
        /** MediaFormat.KEY_IS_FORCED_SUBTITLE 은 API 21 부터라 문자열로 직접 쓴다. */
        const val KEY_IS_FORCED_SUBTITLE = "is-forced-subtitle"

        const val INITIAL_BUFFER_BYTES = 256 * 1024
        const val MAX_BUFFER_BYTES = 8 * 1024 * 1024
        const val MAX_CANVAS_SIDE = 4096
        const val STACK_GAP_PX = 8
        const val DANGLING_DURATION_MS = 3_000L
    }
}
