package com.yuzuki.mai_notification.data.model

import com.google.gson.annotations.SerializedName

/** GET /api/history の1件（routes/history.js の logs 相当） */
data class HistoryLog(
    val id: Long,
    val title: String?,
    val body: String?,
    val url: String?,
    val icon: String?,
    val image: String?,
    val platform: String?,
    val status: String?,
    val timestamp: Long,
    @SerializedName("media_url") val mediaUrl: String?,
    @SerializedName("media_type") val mediaType: String?
)

data class HistoryResponse(
    val logs: List<HistoryLog>,
    val total: Int,
    val hasMore: Boolean
)

/** GET /api/events の1件（events テーブルの SELECT * 相当） */
data class EventItem(
    val id: Long,
    val title: String?,
    @SerializedName("start_time") val startTime: String?,
    @SerializedName("end_time") val endTime: String?,
    val url: String?,
    @SerializedName("thumbnail_url") val thumbnailUrl: String?,
    val platform: String?,
    @SerializedName("event_type") val eventType: String?,
    val description: String?,
    val status: String?,
    @SerializedName("time_period") val timePeriod: String?
)

data class EventsResponse(
    val items: List<EventItem>,
    val limit: Int,
    val offset: Int,
    val total: Int
)

/** GET /api/user/schedules の1件（要ログイン） */
data class UserSchedule(
    val id: Long,
    @SerializedName("event_id") val eventId: Long?,
    val source: String?,
    val title: String?,
    val note: String?,
    val url: String?,
    @SerializedName("thumbnail_url") val thumbnailUrl: String?,
    @SerializedName("scheduled_at") val scheduledAt: String?,
    @SerializedName("reminder_minutes") val reminderMinutes: Int?,
    @SerializedName("event_title") val eventTitle: String?,
    @SerializedName("start_time") val startTime: String?,
    val platform: String?,
    @SerializedName("event_url") val eventUrl: String?,
    @SerializedName("event_status") val eventStatus: String?,
    val editable: Boolean?
)

/** GET /api/user/me のレスポンス（user テーブル＋推し日数） */
data class UserProfile(
    val id: Long? = null,
    val name: String? = null,
    val email: String? = null,
    val platform: String? = null,
    @SerializedName("oshi_since") val oshiSince: String? = null,
    @SerializedName("oshi_days") val oshiDays: Int? = null
)

/** GET /api/user/notification-settings のレスポンス（services/context.js DEFAULT_PLATFORM_SETTINGS 相当） */
data class NotificationSettings(
    val twitcasting: Boolean = true,
    val youtube: Boolean = true,
    val youtubeCommunity: Boolean = true,
    val fanbox: Boolean = true,
    val twitterMain: Boolean = true,
    val twitterSub: Boolean = true,
    val milestone: Boolean = true,
    val schedule: Boolean = true,
    val gipt: Boolean = true,
    val twitch: Boolean = true,
    val bilibili: Boolean = false
)

/** 通知設定スイッチの表示名マップ（UI 用） */
val NOTIFICATION_SETTING_LABELS: Map<String, String> = mapOf(
    "twitcasting" to "ツイキャス（ライブ開始）",
    "youtube" to "YouTube（ライブ・動画）",
    "youtubeCommunity" to "YouTube（コミュニティ）",
    "fanbox" to "Fanbox（新着投稿）",
    "twitterMain" to "X / Twitter（メイン）",
    "twitterSub" to "X / Twitter（サブ）",
    "milestone" to "マイルストーン（登録者数等）",
    "schedule" to "スケジュール更新",
    "gipt" to "GIPT（お知らせ）",
    "twitch" to "Twitch",
    "bilibili" to "Bilibili"
)
