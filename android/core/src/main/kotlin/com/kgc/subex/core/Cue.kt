package com.kgc.subex.core

/** 자막 한 덩어리. 시각 단위는 밀리초. */
data class Cue(
    val startMs: Long,
    val endMs: Long,
    val text: String,
) {
    val durationMs: Long get() = endMs - startMs
}
