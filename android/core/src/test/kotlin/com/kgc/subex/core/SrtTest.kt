package com.kgc.subex.core

import kotlin.test.Test
import kotlin.test.assertEquals

/** 파이썬판 tests/test_srt.py 와 같은 내용을 검사한다. */
class SrtTest {

    @Test
    fun formatsTimestamps() {
        assertEquals("00:00:00,000", Srt.formatTimestamp(0))
        assertEquals("00:00:00,001", Srt.formatTimestamp(1))
        assertEquals("01:01:01,234", Srt.formatTimestamp(3_661_234))
        assertEquals("00:00:00,000", Srt.formatTimestamp(-5))
    }

    @Test
    fun parsesAndRendersRoundTrip() {
        val source = """
            1
            00:00:01,000 --> 00:00:04,000
            Hello
            world

            2
            00:00:05,500 --> 00:00:08,000
            안녕하세요
        """.trimIndent()

        val cues = Srt.parse(source)
        assertEquals(
            listOf(Cue(1000, 4000, "Hello\nworld"), Cue(5500, 8000, "안녕하세요")),
            cues,
        )
        assertEquals(cues, Srt.parse(Srt.render(cues)))
    }

    @Test
    fun toleratesBomCrlfAndDotSeparator() {
        val source = "﻿1\r\n00:00:01.500 --> 00:00:02.5\r\n점 구분자\r\n"
        assertEquals(listOf(Cue(1500, 2500, "점 구분자")), Srt.parse(source))
    }

    @Test
    fun ignoresEmptyBodies() {
        val source = "1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\n내용\n"
        assertEquals(listOf(Cue(3000, 4000, "내용")), Srt.parse(source))
    }

    @Test
    fun keepsTextEndingWithDigits() {
        // 본문 마지막 줄이 숫자로 끝나도 다음 큐의 번호로 오인하면 안 된다.
        val source = (
            "1\n00:00:01,000 --> 00:00:02,000\nMixed 한글 and English 2026\n\n" +
                "2\n00:00:03,000 --> 00:00:04,000\n2026\n\n" +
                "3\n00:00:05,000 --> 00:00:06,000\n끝\n"
            )
        assertEquals(
            listOf("Mixed 한글 and English 2026", "2026", "끝"),
            Srt.parse(source).map { it.text },
        )
    }

    @Test
    fun rendersNumbersSequentially() {
        val rendered = Srt.render(listOf(Cue(0, 1000, "가"), Cue(2000, 3000, "나")))
        assertEquals(
            "1\n00:00:00,000 --> 00:00:01,000\n가\n\n2\n00:00:02,000 --> 00:00:03,000\n나\n",
            rendered,
        )
    }
}
