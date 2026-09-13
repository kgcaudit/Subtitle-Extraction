package com.kgc.subex.core

/** 문자 인식이 찾아낸 글자 한 조각과 그 위치. */
data class RecognizedLine(
    val text: String,
    val left: Int,
    val top: Int,
    val bottom: Int,
) {
    val height: Int get() = bottom - top
    val centerY: Int get() = (top + bottom) / 2
}

/**
 * 문자 인식 결과를 자막 한 덩어리의 글자로 조립한다.
 *
 * 인식기는 한 줄을 여러 조각으로 쪼개 내놓기도 하고, 순서도 보장하지 않는다.
 * 그래서 세로 위치가 비슷한 것끼리 한 줄로 묶고, 줄 안에서는 왼쪽부터,
 * 줄끼리는 위에서 아래로 세운다.
 *
 * 안드로이드 의존성이 없으므로 기기 없이 단위 테스트로 확인할 수 있다.
 */
object TextLayout {

    /** 두 조각을 같은 줄로 볼지 정하는 기준: 글자 높이의 이 비율만큼 어긋나도 같은 줄. */
    private const val SAME_LINE_TOLERANCE = 0.6

    fun assemble(lines: List<RecognizedLine>): String {
        val usable = lines.filter { it.text.isNotBlank() }
        if (usable.isEmpty()) return ""

        val medianHeight = usable.map { it.height }
            .sorted()[usable.size / 2]
            .coerceAtLeast(1)
        val tolerance = (medianHeight * SAME_LINE_TOLERANCE).toInt().coerceAtLeast(1)

        val rows = mutableListOf<MutableList<RecognizedLine>>()
        for (line in usable.sortedBy { it.centerY }) {
            val row = rows.lastOrNull()
            if (row != null && line.centerY - row.last().centerY <= tolerance) {
                row += line
            } else {
                rows += mutableListOf(line)
            }
        }

        return rows.joinToString("\n") { row ->
            row.sortedBy { it.left }.joinToString(" ") { it.text.trim() }
        }
    }
}
