pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "subex-android"

// core 는 안드로이드 의존성이 없는 별도 빌드다. 안드로이드 SDK 없이도
// `cd core && gradle test` 로 검증할 수 있게 일부러 분리해 두었다.
includeBuild("core")

include(":app")
