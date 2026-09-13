plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.kgc.subex"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.kgc.subex"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        // Media3 의 추출기 API 는 아직 Unstable 로 표시돼 있다. 재생이 아니라
        // 자막만 뽑는 용도라 이 표면을 쓰는 게 맞아서 통째로 열어 둔다.
        freeCompilerArgs += "-opt-in=androidx.media3.common.util.UnstableApi"
    }

    buildFeatures {
        compose = true
    }

    sourceSets["main"].java.srcDir("src/main/kotlin")

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

// 버전은 Android Studio 가 더 새 것을 제안하면 올려도 된다.
val media3Version = "1.9.0"

dependencies {
    implementation("com.kgc.subex:core")

    // 컨테이너 해체 + 자막 해독. MediaExtractorCompat 은 1.9.0 의 inspector 모듈에 있다.
    implementation("androidx.media3:media3-inspector:$media3Version")
    implementation("androidx.media3:media3-extractor:$media3Version")
    implementation("androidx.media3:media3-common:$media3Version")

    // 한국어 문자 인식. 모델을 앱에 담아(bundled) 첫 실행부터 인터넷 없이 동작한다.
    implementation("com.google.mlkit:text-recognition-korean:16.0.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.documentfile:documentfile:1.0.1")

    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.compose.ui:ui-tooling-preview")
}
