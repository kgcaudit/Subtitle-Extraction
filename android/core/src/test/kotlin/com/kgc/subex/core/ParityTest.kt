package com.kgc.subex.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 파이썬판과 결과가 같은지 대조한다.
 *
 * 기준 파일 `parity.txt` 는 실제 영상으로 검증을 끝낸 파이썬 구현이 만든
 * 정답지다(`python3 tests/make_parity_golden.py` 로 다시 만들 수 있다).
 * 두 구현이 갈라지면 이 테스트가 먼저 알려 준다.
 */
class ParityTest {

    private data class Case(val name: String, val note: String, val input: String, val expected: String)

    private fun loadCases(): List<Case> {
        val raw = requireNotNull(javaClass.getResourceAsStream("/parity.txt")) {
            "parity.txt 가 없습니다. python3 tests/make_parity_golden.py 를 먼저 실행하세요."
        }.bufferedReader(Charsets.UTF_8).readText()

        val cases = mutableListOf<Case>()
        var name = ""
        var note = ""
        val input = StringBuilder()
        val expected = StringBuilder()
        var section = ""

        for (line in raw.split('\n')) {
            when {
                line.startsWith("$MARKER case ") -> {
                    name = line.removePrefix("$MARKER case ")
                    input.setLength(0)
                    expected.setLength(0)
                    section = ""
                }
                line.startsWith("$MARKER note ") -> note = line.removePrefix("$MARKER note ")
                line == "$MARKER input" -> section = "input"
                line == "$MARKER expected" -> section = "expected"
                line == "$MARKER end" -> {
                    cases += Case(name, note, input.toString(), expected.toString())
                    section = ""
                }
                else -> when (section) {
                    "input" -> input.append(line).append('\n')
                    "expected" -> expected.append(line).append('\n')
                }
            }
        }
        return cases
    }

    @Test
    fun goldenFileHasCases() {
        assertTrue(loadCases().size >= 10, "대조할 경우가 너무 적습니다")
    }

    @Test
    fun matchesPythonImplementation() {
        val failures = mutableListOf<String>()
        for (case in loadCases()) {
            val actual = Srt.render(Postprocess.tidy(Srt.parse(case.input)))
            if (actual != case.expected) {
                failures += buildString {
                    append("[").append(case.name).append("] ").append(case.note).append('\n')
                    append("  파이썬: ").append(case.expected.replace("\n", "\\n")).append('\n')
                    append("  코틀린: ").append(actual.replace("\n", "\\n"))
                }
            }
        }
        assertEquals(emptyList(), failures, "파이썬판과 결과가 다릅니다:\n" + failures.joinToString("\n"))
    }

    private companion object {
        const val MARKER = "========"
    }
}
