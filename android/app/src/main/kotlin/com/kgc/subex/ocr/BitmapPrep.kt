package com.kgc.subex.ocr

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color

/**
 * 자막 비트맵을 문자 인식기가 좋아하는 모양(흰 바탕 + 검은 글자)으로 바꾼다.
 *
 * 파이썬판 subex/bitmap.py 의 prepare_for_ocr 을 그대로 옮긴 것이다. 자막 비트맵은
 * 대개 '밝은 글자 + 어두운 테두리 + 투명 배경'이다. 검은 배경에 합성하면 글자만
 * 밝게 남고, 그 상태를 반전시키면 테두리와 배경이 둘 다 흰색으로 뭉개지면서
 * 글자만 검게 남는다.
 */
object BitmapPrep {

    /** 반전 결과가 이 밝기보다 어두우면 원본이 '어두운 글자 + 밝은 박스'였다고 본다. */
    private const val DARK_RESULT_THRESHOLD = 110

    fun prepare(source: Bitmap, scale: Int = 2, marginPx: Int = 16): Bitmap {
        val cropped = cropToContent(source) ?: source
        val width = cropped.width
        val height = cropped.height
        val pixels = IntArray(width * height)
        cropped.getPixels(pixels, 0, width, 0, 0, width, height)

        var total = 0L
        val gray = IntArray(pixels.size)
        for (index in pixels.indices) {
            val pixel = pixels[index]
            val alpha = (pixel ushr 24) and 0xFF
            // 검은 배경에 알파 합성한 뒤 밝기를 구한다.
            val red = ((pixel ushr 16) and 0xFF) * alpha / 255
            val green = ((pixel ushr 8) and 0xFF) * alpha / 255
            val blue = (pixel and 0xFF) * alpha / 255
            val luma = (red * 299 + green * 587 + blue * 114) / 1000
            val inverted = 255 - luma
            gray[index] = inverted
            total += inverted
        }

        val mean = if (gray.isEmpty()) 255 else (total / gray.size).toInt()
        val flipAgain = mean < DARK_RESULT_THRESHOLD
        for (index in gray.indices) {
            val value = if (flipAgain) 255 - gray[index] else gray[index]
            gray[index] = Color.rgb(value, value, value)
        }

        var result = Bitmap.createBitmap(gray, width, height, Bitmap.Config.ARGB_8888)
        if (scale > 1) {
            result = Bitmap.createScaledBitmap(result, width * scale, height * scale, true)
        }

        // 인식기는 글자가 가장자리에 붙어 있으면 잘 못 읽는다. 흰 여백을 둘러 준다.
        val padded = Bitmap.createBitmap(
            result.width + marginPx * 2,
            result.height + marginPx * 2,
            Bitmap.Config.ARGB_8888,
        )
        val canvas = Canvas(padded)
        canvas.drawColor(Color.WHITE)
        canvas.drawBitmap(result, marginPx.toFloat(), marginPx.toFloat(), null)
        return padded
    }

    /** 완전히 투명한 가장자리를 잘라낸다. 파이썬판의 Image.getbbox 와 같은 일. */
    fun cropToContent(source: Bitmap): Bitmap? {
        val width = source.width
        val height = source.height
        if (width <= 0 || height <= 0) return null

        val pixels = IntArray(width * height)
        source.getPixels(pixels, 0, width, 0, 0, width, height)

        var left = width
        var top = height
        var right = -1
        var bottom = -1
        for (y in 0 until height) {
            val rowStart = y * width
            for (x in 0 until width) {
                if ((pixels[rowStart + x] ushr 24) == 0) continue
                if (x < left) left = x
                if (x > right) right = x
                if (y < top) top = y
                if (y > bottom) bottom = y
            }
        }
        if (right < left || bottom < top) return null
        if (left == 0 && top == 0 && right == width - 1 && bottom == height - 1) return source
        return Bitmap.createBitmap(source, left, top, right - left + 1, bottom - top + 1)
    }
}
