package com.yuzuki.mai_notification.data

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.yuzuki.mai_notification.data.model.EventItem
import com.yuzuki.mai_notification.data.model.HistoryLog

/**
 * オフラインキャッシュ（Phase 3）。
 *
 * 履歴・予定を SharedPreferences に JSON で保存し、オフライン時に直近の内容を表示する。
 * ネットワーク成功時は常にキャッシュを更新する（stale-while-revalidate）。
 */
object CacheStore {
    private const val PREFS = "mai_cache"
    private const val KEY_HISTORY = "history_logs"
    private const val KEY_EVENTS = "events"
    private const val KEY_HISTORY_AT = "history_cached_at"
    private const val KEY_EVENTS_AT = "events_cached_at"

    private val gson = Gson()

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ---- 履歴 ----

    fun saveHistory(context: Context, logs: List<HistoryLog>) {
        prefs(context).edit()
            .putString(KEY_HISTORY, gson.toJson(logs))
            .putLong(KEY_HISTORY_AT, System.currentTimeMillis())
            .apply()
    }

    fun loadHistory(context: Context): List<HistoryLog>? {
        val json = prefs(context).getString(KEY_HISTORY, null) ?: return null
        return runCatching {
            gson.fromJson<List<HistoryLog>>(json, object : TypeToken<List<HistoryLog>>() {}.type)
        }.getOrNull()
    }

    fun historyCachedAt(context: Context): Long =
        prefs(context).getLong(KEY_HISTORY_AT, 0L)

    // ---- 予定（イベント） ----

    fun saveEvents(context: Context, events: List<EventItem>) {
        prefs(context).edit()
            .putString(KEY_EVENTS, gson.toJson(events))
            .putLong(KEY_EVENTS_AT, System.currentTimeMillis())
            .apply()
    }

    fun loadEvents(context: Context): List<EventItem>? {
        val json = prefs(context).getString(KEY_EVENTS, null) ?: return null
        return runCatching {
            gson.fromJson<List<EventItem>>(json, object : TypeToken<List<EventItem>>() {}.type)
        }.getOrNull()
    }

    fun eventsCachedAt(context: Context): Long =
        prefs(context).getLong(KEY_EVENTS_AT, 0L)
}
