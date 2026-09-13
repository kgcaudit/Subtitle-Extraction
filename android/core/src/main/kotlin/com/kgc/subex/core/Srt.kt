package com.kgc.subex.core

/**
 * SRT 자막의 직렬화와 파싱.
 *
 * 파이썬판(subex/srt.py)과 같은 규칙을 따른다. 두 구현이 같은 영상에서 같은
 * 결과를 내야 안드로이드 결과를 파이썬판으로 대조할 수 있기 때문이다.
 */
object Srt {

    /** 밀리초를 `HH:MM:SS,mmm` 으로. 음수는 0 으로 눌러 준다. */
    fun formatTimestamp(millis: Long): String {
        val value = if (millis < 0) 0 else millis
        val hours = value / 3_600_000
        val minutes = value / 60_000 % 60
        val seconds = value / 1_000 % 60
        val fraction = value % 1_000
        return "%02d:%02d:%02d,%03d".format(hours, minutes, seconds, fraction)
    }

    fun render(cues: List<Cue>): String = buildString {
        cues.forEachIndexed { index, cue ->
            if (index > 0) append('\n')
            append(index + 1).append('\n')
            append(formatTimestamp(cue.startMs))
            append(" --> ")
            append(formatTimestamp(cue.endMs)).append('\n')
            append(cue.text).append('\n')
        }
    }

    private val TIMECODE = Regex(
        """(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})\s*-->\s*(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})"""
    )

    private fun toMillis(hours: String, minutes: String, seconds: String, fraction: String): Long =
        ((hours.toLong() * 60 + minutes.toLong()) * 60 + seconds.toLong()) * 1000 +
            fraction.padEnd(3, '0').toLong()

    /**
     * SRT 문서를 읽는다.
     *
     * 번호 줄이 없거나 어긋나 있어도 타임코드 줄을 기준으로 자른다. 본문 마지막
     * 줄이 숫자로 끝나는 경우(`... English 2026`)를 다음 큐의 번호로 잘못 지우지
     * 않도록, '그 줄 전체가 숫자일 때'만 번호 줄로 보고 걷어낸다.
     */
    fun parse(source: String): List<Cue> {
        val text = source.removePrefix("﻿").replace("\r\n", "\n").replace("\r", "\n")
        val matches = TIMECODE.findAll(text).toList()
        val cues = ArrayList<Cue>(matches.size)

        matches.forEachIndexed { position, match ->
            val bodyStart = text.indexOf('\n', match.range.last + 1)
            if (bodyStart < 0) return@forEachIndexed

            val hasNext = position + 1 < matches.size
            val bodyEnd = if (hasNext) {
                // 다음 타임코드가 있는 '줄의 시작'까지가 이번 큐의 몫이다.
                text.lastIndexOf('\n', matches[position + 1].range.first) + 1
            } else {
                text.length
            }
            if (bodyEnd <= bodyStart) return@forEachIndexed

            val lines = text.substring(bodyStart + 1, bodyEnd).split('\n').toMutableList()
            while (lines.isNotEmpty() && lines.last().isBlank()) lines.removeAt(lines.size - 1)
            if (hasNext && lines.isNotEmpty() && lines.last().trim().isNumeric()) {
                lines.removeAt(lines.size - 1)
            }
            while (lines.isNotEmpty() && lines.last().isBlank()) lines.removeAt(lines.size - 1)

            val body = lines.joinToString("\n").trim()
            if (body.isNotEmpty()) {
                val values = match.groupValues
                cues += Cue(
                    toMillis(values[1], values[2], values[3], values[4]),
                    toMillis(values[5], values[6], values[7], values[8]),
                    body,
                )
            }
        }
        return cues
    }

    private fun String.isNumeric(): Boolean = isNotEmpty() && all { it.isDigit() }
}
