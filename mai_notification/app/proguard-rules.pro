# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.

# Keep JS bridge methods for WebView
-keepclassmembers class com.yuzuki.mai_notification.MaiWebBridge {
    public *;
}
-keep class com.yuzuki.mai_notification.MaiWebBridge { *; }
-keep class com.yuzuki.mai_notification.FcmRegistrar { *; }

# Keep data models (Gson serialization)
-keep class com.yuzuki.mai_notification.data.model.** { *; }
-keep class com.yuzuki.mai_notification.data.NotificationSettingsResponse { *; }
-keep class com.yuzuki.mai_notification.data.OshiUpdateRequest { *; }
-keep class com.yuzuki.mai_notification.data.OshiUpdateResponse { *; }

# Gson
-keepattributes Signature
-keepattributes *Annotation*
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken

# Retrofit
-keepattributes Exceptions
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keepclassmembers,allowshrinking,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}
-dontwarn org.codehaus.mojo.animal_sniffer.IgnoreJRERequirement
-dontwarn javax.annotation.**
-dontwarn kotlin.Unit
-dontwarn retrofit2.KotlinExtensions
-dontwarn retrofit2.KotlinExtensions$*
-if interface * { @retrofit2.http.* <methods>; }
-keep,allowobfuscation interface <1>

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# OkHttp SSE (if present)
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Coil
-keep class coil.** { *; }

# Firebase / Google Play services
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**

# Keep line numbers for crash reports
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
