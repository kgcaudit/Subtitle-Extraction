package com.kgc.subex.core

/** 자막이 글자로 들어 있는지, 그림으로 들어 있는지. */
enum class TrackKind { TEXT, BITMAP }

/**
 * 영상 안의 자막 트랙 하나에 대한 설명.
 *
 * 안드로이드 의존성을 일부러 넣지 않았다. 그래야 파일 이름 규칙 같은 걸
 * 기기 없이 단위 테스트로 확인할 수 있다.
 */
data class SubtitleTrackInfo(
    val trackIndex: Int,          // 컨테이너 전체 기준 트랙 번호
    val subtitleIndex: Int,       // 자막들 사이에서의 순번 (0부터)
    val mimeType: String,
    val language: String? = null,
    val label: String? = null,
    val isDefault: Boolean = false,
    val isForced: Boolean = false,
) {
    val kind: TrackKind
        get() = if (mimeType in BITMAP_MIME_TYPES) TrackKind.BITMAP else TrackKind.TEXT

    val isSupported: Boolean get() = mimeType in SUPPORTED_MIME_TYPES

    /** 사람이 읽는 형식 이름. */
    val formatName: String get() = FORMAT_NAMES[mimeType] ?: mimeType

    /** 출력 파일 이름에 붙일 꼬리표. 파이썬판 SubtitleTrack.slug() 와 같은 규칙. */
    fun slug(): String = buildList {
        add(language?.takeIf { it.isNotBlank() && it != "und" } ?: "und")
        if (isForced) add("forced")
    }.joinToString(".")

    /** `영화이름.kor.forced.srt` 형태의 기본 출력 이름. */
    fun outputFileName(videoName: String): String {
        val stem = videoName.substringBeforeLast('.', videoName)
        return "$stem.${slug()}.srt"
    }

    fun describe(): String = buildString {
        append('#').append(subtitleIndex).append("  ")
        append(language ?: "und").append("  ")
        append(formatName)
        label?.let { append("  '").append(it).append('\'') }
        val flags = buildList {
            if (isDefault) add("default")
            if (isForced) add("forced")
        }
        if (flags.isNotEmpty()) append("  [").append(flags.joinToString(",")).append(']')
    }

    companion object {
        const val MIME_PGS = "application/pgs"
        const val MIME_VOBSUB = "application/vobsub"
        const val MIME_DVBSUBS = "application/dvbsubs"
        const val MIME_SUBRIP = "application/x-subrip"
        const val MIME_SSA = "text/x-ssa"
        const val MIME_VTT = "text/vtt"
        const val MIME_TTML = "application/ttml+xml"
        const val MIME_TX3G = "application/x-quicktime-tx3g"

        /** 그림으로 들어 있어 문자 인식을 거쳐야 하는 형식. */
        val BITMAP_MIME_TYPES = setOf(MIME_PGS, MIME_VOBSUB, MIME_DVBSUBS)

        /** Media3 의 DefaultSubtitleParserFactory 가 다룰 수 있는 형식. */
        val SUPPORTED_MIME_TYPES = setOf(
            MIME_PGS, MIME_VOBSUB, MIME_DVBSUBS,
            MIME_SUBRIP, MIME_SSA, MIME_VTT, MIME_TTML, MIME_TX3G,
        )

        private val FORMAT_NAMES = mapOf(
            MIME_PGS to "PGS (블루레이 이미지 자막)",
            MIME_VOBSUB to "VobSub (DVD 이미지 자막)",
            MIME_DVBSUBS to "DVB 이미지 자막 (방송)",
            MIME_SUBRIP to "SubRip",
            MIME_SSA to "ASS/SSA",
            MIME_VTT to "WebVTT",
            MIME_TTML to "TTML",
            MIME_TX3G to "MP4 타임드 텍스트",
        )
    }
}
