package com.kgc.subex.ocr

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
import com.kgc.subex.core.RecognizedLine
import com.kgc.subex.core.TextLayout
import kotlinx.coroutines.tasks.await
import java.io.Closeable

/**
 * 한국어 문자 인식.
 *
 * ML Kit 의 한국어 인식기는 라틴 문자도 함께 읽으므로 한글·영문이 섞인 자막도
 * 한 번에 처리된다. 모델을 앱에 담아 두어 인터넷 없이 첫 실행부터 동작한다.
 */
class KoreanOcr : Closeable {

    private val recognizer = TextRecognition.getClient(KoreanTextRecognizerOptions.Builder().build())

    /**
     * 비트맵 한 장에서 글자를 읽는다.
     *
     * 인식기가 내놓는 조각은 순서도 줄 구분도 보장되지 않아서, 위치를 보고
     * 다시 줄을 세운다(core 의 TextLayout — 기기 없이 검증해 둔 부분).
     */
    suspend fun recognize(bitmap: Bitmap): String {
        val result = recognizer.process(InputImage.fromBitmap(bitmap, 0)).await()

        val lines = result.textBlocks
            .flatMap { block -> block.lines }
            .mapNotNull { line ->
                val box = line.boundingBox ?: return@mapNotNull null
                RecognizedLine(
                    text = line.text,
                    left = box.left,
                    top = box.top,
                    bottom = box.bottom,
                )
            }
        return TextLayout.assemble(lines)
    }

    override fun close() {
        recognizer.close()
    }
}
