package com.kgc.subex

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kgc.subex.ui.SubexScreen

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sharedVideo = intent?.takeIf { it.action == Intent.ACTION_SEND }?.extraStream()

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    SubexApp(sharedVideo)
                }
            }
        }
    }

    private fun Intent.extraStream(): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            getParcelableExtra(Intent.EXTRA_STREAM)
        }
}

@Composable
private fun SubexApp(sharedVideo: Uri?) {
    val viewModel: SubexViewModel = viewModel()
    val state by viewModel.state.collectAsState()

    // 영상 고르기. MKV 처럼 기기가 형식을 모르는 파일도 있어서 */* 도 함께 허용한다.
    val pickVideo = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri -> uri?.let(viewModel::openVideo) }

    val pickFolder = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { uri -> uri?.let(viewModel::saveAll) }

    // 다른 앱에서 '공유'로 넘어온 영상이 있으면 한 번만 자동으로 연다.
    LaunchedEffect(sharedVideo) {
        if (sharedVideo != null) viewModel.openVideo(sharedVideo)
    }

    Scaffold { innerPadding ->
        SubexScreen(
            state = state,
            onPickVideo = { pickVideo.launch(arrayOf("video/*", "*/*")) },
            onToggleTrack = viewModel::toggleTrack,
            onExtract = viewModel::extract,
            onPickFolder = { pickFolder.launch(null) },
            modifier = Modifier.padding(innerPadding),
        )
    }
}
