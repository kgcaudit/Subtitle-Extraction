package com.kgc.subex.core

import kotlin.test.Test
import kotlin.test.assertEquals

/** 파이썬판 tests/test_postprocess.py 와 같은 내용을 검사한다. */
class PostprocessTest {

    @Test
    fun stripsAssOverrides() {
        assertEquals("위쪽\n아래쪽", Postprocess.cleanText("""{\an8}위쪽\N아래쪽"""))
    }

    @Test
    fun keepsStylingWhenAsked() {
        val source = """{\i1}기울임"""
        assertEquals(source, Postprocess.cleanText(source, stripStyling = false))
    }

    @Test
    fun collapsesWhitespaceAndDropsBlankLines() {
        assertEquals("두 칸\n다음 줄", Postprocess.cleanText("  두   칸  \n\n  다음 줄 "))
    }

    @Test
    fun dropsEmptyAndEnforcesMinimumDuration() {
        val cues = Postprocess.tidy(listOf(Cue(0, 100, "   "), Cue(1000, 1050, "짧다")))
        assertEquals(listOf(Cue(1000, 1200, "짧다")), cues)
    }

    @Test
    fun mergesRepeatedText() {
        val cues = Postprocess.tidy(listOf(Cue(1000, 2000, "같은 말"), Cue(2100, 3000, "같은 말")))
        assertEquals(listOf(Cue(1000, 3000, "같은 말")), cues)
    }

    @Test
    fun resolvesOverlap() {
        val cues = Postprocess.tidy(listOf(Cue(1000, 4000, "앞"), Cue(2500, 5000, "뒤")))
        assertEquals(2500, cues[0].endMs)
        assertEquals(2500, cues[1].startMs)
    }

    @Test
    fun sortsByTime() {
        val cues = Postprocess.tidy(listOf(Cue(5000, 6000, "나중"), Cue(1000, 2000, "먼저")))
        assertEquals(listOf("먼저", "나중"), cues.map { it.text })
    }
}
