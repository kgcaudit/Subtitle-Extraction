package com.kgc.subex.io

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.documentfile.provider.DocumentFile

/**
 * 파일 읽기·쓰기. 전부 저장소 접근 프레임워크(SAF)를 거치므로 저장소 권한이 필요 없다.
 * 사용자가 직접 고른 영상과 사용자가 직접 고른 폴더에만 접근한다.
 */
object SrtFiles {

    /** 고른 파일의 표시 이름. 못 알아내면 Uri 의 마지막 조각으로 대신한다. */
    fun displayName(context: Context, uri: Uri): String {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (column >= 0 && cursor.moveToFirst()) {
                    cursor.getString(column)?.takeIf { it.isNotBlank() }?.let { return it }
                }
            }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "video"
    }

    /**
     * 사용자가 고른 폴더에 SRT 를 쓴다. 같은 이름이 이미 있으면 지우고 새로 만든다.
     *
     * @return 실제로 저장된 파일 이름
     */
    fun writeToTree(context: Context, treeUri: Uri, fileName: String, text: String): String {
        val directory = DocumentFile.fromTreeUri(context, treeUri)
            ?: error("폴더를 열 수 없습니다. 다시 선택해 주세요.")

        directory.findFile(fileName)?.delete()
        val target = directory.createFile(MIME_SRT, fileName)
            ?: error("'$fileName' 을(를) 만들 수 없습니다.")

        context.contentResolver.openOutputStream(target.uri)?.use { stream ->
            stream.write(text.toByteArray(Charsets.UTF_8))
        } ?: error("'$fileName' 에 쓸 수 없습니다.")

        return target.name ?: fileName
    }

    /** 단일 파일로 저장할 때(사용자가 이름과 위치를 직접 고른 경우). */
    fun writeToDocument(context: Context, documentUri: Uri, text: String) {
        context.contentResolver.openOutputStream(documentUri, "wt")?.use { stream ->
            stream.write(text.toByteArray(Charsets.UTF_8))
        } ?: error("파일에 쓸 수 없습니다.")
    }

    const val MIME_SRT = "application/x-subrip"
}
