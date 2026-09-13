package com.kgc.subex.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SubtitleTrackInfoTest {

    private fun track(mime: String, language: String? = "kor", forced: Boolean = false) =
        SubtitleTrackInfo(
            trackIndex = 2,
            subtitleIndex = 1,
            mimeType = mime,
            language = language,
            isForced = forced,
        )

    @Test
    fun classifiesBitmapAndTextFormats() {
        assertEquals(TrackKind.BITMAP, track(SubtitleTrackInfo.MIME_PGS).kind)
        assertEquals(TrackKind.BITMAP, track(SubtitleTrackInfo.MIME_VOBSUB).kind)
        assertEquals(TrackKind.BITMAP, track(SubtitleTrackInfo.MIME_DVBSUBS).kind)
        assertEquals(TrackKind.TEXT, track(SubtitleTrackInfo.MIME_SUBRIP).kind)
        assertEquals(TrackKind.TEXT, track(SubtitleTrackInfo.MIME_SSA).kind)
    }

    @Test
    fun marksUnknownFormatsUnsupported() {
        assertTrue(track(SubtitleTrackInfo.MIME_PGS).isSupported)
        assertFalse(track("application/x-unknown-subs").isSupported)
    }

    @Test
    fun buildsOutputFileName() {
        assertEquals("movie.kor.srt", track(SubtitleTrackInfo.MIME_PGS).outputFileName("movie.mkv"))
        assertEquals(
            "movie.kor.forced.srt",
            track(SubtitleTrackInfo.MIME_PGS, forced = true).outputFileName("movie.mkv"),
        )
        assertEquals(
            "movie.und.srt",
            track(SubtitleTrackInfo.MIME_PGS, language = null).outputFileName("movie.mkv"),
        )
    }

    @Test
    fun handlesNamesWithoutExtensionAndWithDots() {
        assertEquals("clip.kor.srt", track(SubtitleTrackInfo.MIME_SUBRIP).outputFileName("clip"))
        assertEquals(
            "a.b.c.kor.srt",
            track(SubtitleTrackInfo.MIME_SUBRIP).outputFileName("a.b.c.mp4"),
        )
    }

    @Test
    fun describesTrackForTheTrackList() {
        val described = track(SubtitleTrackInfo.MIME_PGS, forced = true).describe()
        assertTrue("PGS" in described, described)
        assertTrue("forced" in described, described)
        assertTrue(described.startsWith("#1"), described)
    }
}
