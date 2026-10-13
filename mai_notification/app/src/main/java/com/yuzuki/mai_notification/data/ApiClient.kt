package com.yuzuki.mai_notification.data

import android.webkit.CookieManager
import com.yuzuki.mai_notification.data.model.EventsResponse
import com.yuzuki.mai_notification.data.model.HistoryResponse
import com.yuzuki.mai_notification.data.model.NotificationSettings
import com.yuzuki.mai_notification.data.model.UserProfile
import com.yuzuki.mai_notification.data.model.UserSchedule
import com.google.gson.annotations.SerializedName
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PUT
import retrofit2.http.Query

/** 既存サーバー（routes/）をそのまま叩く Retrofit インターフェース */
interface ApiService {
    @GET("api/history")
    suspend fun history(
        @Query("limit") limit: Int = 30,
        @Query("offset") offset: Int = 0
    ): HistoryResponse

    @GET("api/events")
    suspend fun events(
        @Query("limit") limit: Int = 30,
        @Query("offset") offset: Int = 0,
        @Query("platform") platform: String? = null
    ): EventsResponse

    /** 要ログイン（session Cookie が無いと 401） */
    @GET("api/user/schedules")
    suspend fun schedules(): List<UserSchedule>

    /** 要ログイン */
    @GET("api/user/me")
    suspend fun me(): UserProfile

    /** 要ログイン: 通知設定の取得 */
    @GET("api/user/notification-settings")
    suspend fun notificationSettings(): NotificationSettings

    /** 要ログイン: 通知設定の更新（部分更新可） */
    @PUT("api/user/notification-settings")
    suspend fun updateNotificationSettings(
        @Body settings: Map<String, Boolean>
    ): NotificationSettingsResponse

    /** 要ログイン: 推し始めた日の更新 */
    @PUT("api/user/oshi")
    suspend fun updateOshi(
        @Body body: OshiUpdateRequest
    ): OshiUpdateResponse
}

/** PUT /api/user/notification-settings のレスポンス */
data class NotificationSettingsResponse(
    val success: Boolean,
    val settings: NotificationSettings?
)

/** PUT /api/user/oshi のリクエスト */
data class OshiUpdateRequest(
    @SerializedName("oshi_since") val oshiSince: String
)

/** PUT /api/user/oshi のレスポンス */
data class OshiUpdateResponse(
    val success: Boolean,
    @SerializedName("oshi_since") val oshiSince: String?,
    val days: Int?
)

/**
 * WebView と OkHttp で Cookie（session）を共有するためのクライアント。
 *
 * サーバー側の認証は auth.js の通り Cookie 発行（httpOnly / sameSite=strict / 365日）。
 * ネイティブ画面からの呼び出しでも WebView でログイン済みの Cookie をそのまま
 * 送ればサーバー側の変更は不要。WebView 側でログインし直した分も即座に反映される。
 */
object ApiClient {

    /** サーバー直下（nginx のルート） */
    private const val BASE_URL = "https://koinoyamai.love/"

    private val cookieJar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            val cm = CookieManager.getInstance()
            cookies.forEach { cm.setCookie(url.toString(), it.toString()) }
            cm.flush()
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val header = CookieManager.getInstance().getCookie(url.toString())
                ?: return emptyList()
            // CookieManager が返すのは "a=1; b=2" 形式のためヘッダとして再構成して解析する
            return Cookie.parseAll(url, okhttp3.Headers.headersOf("Cookie", header))
                ?: emptyList()
        }
    }

    private val okHttp: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .cookieJar(cookieJar)
            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .build()
    }

    val service: ApiService by lazy {
        Retrofit.Builder()
            .baseUrl(BASE_URL)
            .client(okHttp)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)
    }
}
