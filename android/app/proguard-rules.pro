# Media3 의 추출기/해독기는 이름으로 찾아 쓰는 부분이 있어 남겨 둔다.
-keep class androidx.media3.** { *; }
-dontwarn androidx.media3.**

# ML Kit 모델 바인딩.
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**
