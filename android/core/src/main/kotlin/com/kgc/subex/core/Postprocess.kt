package com.kgc.subex.core

/**
 * 추출된 자막을 다듬는다. 파이썬판(subex/postprocess.py)과 같은 규칙이다.
 */
object Postprocess {

    /** ASS/SSA 의 스타일 지시자와 줄바꿈 태그. */
    private val ASS_OVERRIDE = Regex("""\{\\[^}]*}""")
    private val ASS_NEWLINE = Regex("""\\[Nnh]""")

    /** 제어문자와 눈에 보이지 않는 공백. */
    private val JUNK = Regex("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u200B\\uFEFF]")
    private val SPACES = Regex("[ \\t]+")

    fun cleanText(source: String, stripStyling: Boolean = true): String {
        var text = source
        if (stripStyling) {
            text = ASS_OVERRIDE.replace(text, "")
            text = ASS_NEWLINE.replace(text, "\n")
        }
        text = JUNK.replace(text, "").replace(' ', ' ')

        return text.split('\n')
            .map { SPACES.replace(it, " ").trim() }
            .filter { it.isNotEmpty() }
            .joinToString("\n")
    }

    /**
     * 빈 자막 제거 → 시간 보정 → 겹침 정리 → 연속 중복 병합.
     *
     * 이미지 자막은 같은 문장을 여러 화면으로 나눠 표시하는 경우가 흔해서,
     * 글자가 똑같고 시간이 맞닿아 있으면 한 덩어리로 합친다.
     */
    fun tidy(
        cues: List<Cue>,
        stripStyling: Boolean = true,
        minDurationMs: Long = 200,
        mergeRepeats: Boolean = true,
    ): List<Cue> {
        val cleaned = ArrayList<Cue>(cues.size)
        for (cue in cues) {
            val text = cleanText(cue.text, stripStyling)
            if (text.isEmpty()) continue
            val start = maxOf(0L, cue.startMs)
            cleaned += Cue(start, maxOf(cue.endMs, start + minDurationMs), text)
        }
        cleaned.sortWith(compareBy({ it.startMs }, { it.endMs }))

        val merged = ArrayList<Cue>(cleaned.size)
        for (original in cleaned) {
            var cue = original
            if (merged.isNotEmpty()) {
                val previous = merged.last()
                if (mergeRepeats && previous.text == cue.text && cue.startMs - previous.endMs <= 250) {
                    merged[merged.size - 1] = previous.copy(endMs = maxOf(previous.endMs, cue.endMs))
                    continue
                }
                if (cue.startMs < previous.endMs) {
                    // 앞 자막을 잘라 겹침을 없앤다. 그래도 남으면 시작을 밀어낸다.
                    if (previous.startMs < cue.startMs) {
                        merged[merged.size - 1] = previous.copy(endMs = cue.startMs)
                    } else {
                        val start = previous.endMs
                        cue = cue.copy(startMs = start, endMs = maxOf(cue.endMs, start + minDurationMs))
                    }
                }
            }
            merged += cue
        }
        return merged.filter { it.endMs > it.startMs }
    }
}
