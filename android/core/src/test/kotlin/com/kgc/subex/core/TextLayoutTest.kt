package com.kgc.subex.core

import kotlin.test.Test
import kotlin.test.assertEquals

class TextLayoutTest {

    private fun line(text: String, left: Int, top: Int, height: Int = 40) =
        RecognizedLine(text, left, top, top + height)

    @Test
    fun emptyInputGivesEmptyText() {
        assertEquals("", TextLayout.assemble(emptyList()))
        assertEquals("", TextLayout.assemble(listOf(line("   ", 0, 0))))
    }

    @Test
    fun singleLinePassesThrough() {
        assertEquals("안녕하세요", TextLayout.assemble(listOf(line("안녕하세요", 10, 100))))
    }

    @Test
    fun stacksTwoRowsTopToBottom() {
        val recognized = listOf(
            line("아래쪽 대사", 10, 160),
            line("위쪽 대사", 10, 100),
        )
        assertEquals("위쪽 대사\n아래쪽 대사", TextLayout.assemble(recognized))
    }

    @Test
    fun joinsPiecesOfTheSameRowLeftToRight() {
        // 인식기가 한 줄을 세 조각으로 쪼갠 경우. 세로 위치가 살짝 어긋나도 한 줄.
        val recognized = listOf(
            line("and English", 220, 102),
            line("Mixed", 10, 100),
            line("한글", 130, 101),
        )
        assertEquals("Mixed 한글 and English", TextLayout.assemble(recognized))
    }

    @Test
    fun keepsRowsApartWhenVerticallyDistinct() {
        val recognized = listOf(
            line("첫째 줄", 10, 100, height = 40),
            line("둘째 줄", 10, 150, height = 40),
            line("셋째 줄", 10, 200, height = 40),
        )
        assertEquals("첫째 줄\n둘째 줄\n셋째 줄", TextLayout.assemble(recognized))
    }

    @Test
    fun trimsEachPiece() {
        val recognized = listOf(line("  앞뒤 공백  ", 10, 100))
        assertEquals("앞뒤 공백", TextLayout.assemble(recognized))
    }

    @Test
    fun ignoresBlankPiecesWhenMeasuring() {
        val recognized = listOf(
            line("", 0, 0, height = 500),
            line("실제 글자", 10, 100, height = 40),
        )
        assertEquals("실제 글자", TextLayout.assemble(recognized))
    }
}
