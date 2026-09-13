// core 는 안드로이드 의존성이 전혀 없는 순수 코틀린 라이브러리다.
// 독립된 빌드로 둔 덕분에 안드로이드 SDK 없이도 `gradle test` 로 검증할 수 있다.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "subex-core"
