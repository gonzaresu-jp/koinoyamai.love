package com.yuzuki.mai_notification

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.TimeZone

/**
 * 配信開始のアラームを端末内に予約する。
 *
 * なぜ AlarmManager.setAlarmClock() を使うのか（2026-10-21 検討）:
 *   - 公式ドキュメント: 「the system never adjusts their delivery time.
 *     The system identifies these alarms as the most critical ones and
 *     leaves low-power modes if necessary to deliver the alarms.」
 *     → Doze（画面オフ・スリープ中）でも**正確な時刻に**発火する。
 *   - 「次のアラーム」としてシステムに登録されるので、ステータスバーに
 *     アラームアイコンが出る（標準のアラーム時計と同じ扱い）。
 *   - 通知（FCM push）に頼らないので、push が届かない・遅延する環境でも動く。
 *
 * 権限:
 *   - API 31/32: SCHEDULE_EXACT_ALARM（インストール時に付与。ユーザーが取り消せる）
 *   - API 33+  : USE_EXACT_ALARM（インストール時に自動付与・取り消し不可）
 *     ※ このアプリは Play ではなく APK 直配布なので、exact alarm の用途制限に該当しない。
 *   - 権限が無い／取り消された場合は canScheduleExactAlarms() が false になり、
 *     アプリは設定画面への誘導に徹する（アラームを黙って不被にするより案内する）。
 *
 * スケジュールの取得:
 *   サーバーの /api/events（status=scheduled）が将来の配信枠を返すので、
 *   アプリ起動時・ウィジェット更新時・通知受信時に取得して予約し直す。
 */
object AlarmScheduler {

    private const val TAG = "AlarmScheduler"

    private const val PREFS = "stream_alarm_prefs"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_OFFSET_MIN = "offset_min"
    private const val KEY_EVENTS = "events_json"

    /** 通知チャネルの ID（既存のものとは別。アラーム専用の高い優先度にする） */
    const val CHANNEL_ID = "mai_stream_alarm"

    /** オフセットの選択肢（分前）。0 = 開始時刻そのもの */
    val OFFSET_CHOICES = intArrayOf(0, 5, 10, 15, 30)

    private const val REQ_CODE = 8101

    // ---------------------------------------------------------------- 設定

    fun isEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_ENABLED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
        if (!enabled) {
            cancelAll(context)
        } else {
            rescheduleFromServer(context)
        }
    }

    /** 何分前に鳴らすか（既定 15 分前） */
    fun offsetMin(context: Context): Int =
        prefs(context).getInt(KEY_OFFSET_MIN, 15)

    fun setOffsetMin(context: Context, minutes: Int) {
        prefs(context).edit().putInt(KEY_OFFSET_MIN, minutes.coerceIn(0, 180)).apply()
        if (isEnabled(context)) rescheduleFromServer(context)
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ------------------------------------------------------- exact alarm 権限

    /** 正確なアラームを設定できるか（権限が無い場合は false） */
    fun canScheduleExact(context: Context): Boolean {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.canScheduleExactAlarms() else true
    }

    /** 「アラームとリマインダー」の権限画面を開く（ユーザーが許可する導線） */
    fun requestExactAlarmPermission(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
            .setData(Uri.fromParts("package", context.packageName, null))
        try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            // 端末に該画面が無い場合は既定の特殊アクセス画面へ
            try {
                context.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.fromParts("package", context.packageName, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e2: Exception) {
                Log.w(TAG, "exact alarm 権限画面を開けません: ${e2.message}")
            }
        }
    }

    // ------------------------------------------------------------ 登録 / 解除

    /**
     * 1 件の配信をアラームに登録する。
     * @param startTimeMs 配信開始時刻（epoch ms）
     */
    fun registerEvent(
        context: Context,
        eventId: Long,
        title: String,
        url: String?,
        startTimeMs: Long
    ) {
        if (!isEnabled(context)) return
        if (startTimeMs <= 0L) return
        val fireAt = startTimeMs - offsetMin(context) * 60_000L
        if (fireAt <= System.currentTimeMillis()) return // 過去は登録しない

        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_STREAM_ALARM
            putExtra(AlarmReceiver.EXTRA_EVENT_ID, eventId)
            putExtra(AlarmReceiver.EXTRA_TITLE, title)
            putExtra(AlarmReceiver.EXTRA_URL, url)
        }
        val pi = PendingIntent.getBroadcast(
            context, REQ_CODE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        try {
            // setAlarmClock: 正確に発火し、Doze でも polymiss しない（システム视为“次のアラーム”）
            am.setAlarmClock(AlarmManager.AlarmClockInfo(fireAt, pi.showIntent), pi)
            Log.i(TAG, "アラーム登録: $title / $fireAt (offset=${offsetMin(context)}分)")
        } catch (e: SecurityException) {
            // exact alarm 権限が無い（SCHEDULE_EXACT_ALARM を取り消された等）
            Log.w(TAG, "exact alarm が許可されていません: ${e.message}")
        }
    }

    /** 登録済みの全アラームを解除する */
    fun cancelAll(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_STREAM_ALARM
        }
        val pi = PendingIntent.getBroadcast(
            context, REQ_CODE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        am.cancel(pi)
        prefs(context).edit().remove(KEY_EVENTS).apply()
    }

    // ---------------------------------------------------- スケジュール取得 / 保存

    /**
     * サーバーの予定を取得してアラームを予約し直す。
     * ネットワークが無い場合は保存済みの予定で再登録する（前回の予約は保持）。
     */
    fun rescheduleFromServer(context: Context) {
        if (!isEnabled(context)) return
        Thread {
            val events = try {
                fetchUpcomingEvents(context)
            } catch (e: Exception) {
                Log.w(TAG, "予定の取得に失敗しました（保存済みで再登録します）: ${e.message}")
                null
            }
            if (events != null && events.isNotEmpty()) {
                prefs(context).edit().putString(KEY_EVENTS, JSONArray(events).toString()).apply()
            }
            val list = events ?: readSavedEvents(context)
            // まず全解除してから登録する（重複を残さないため）
            val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
            if (am != null) {
                val intent = Intent(context, AlarmReceiver::class.java).apply { action = AlarmReceiver.ACTION_STREAM_ALARM }
                val pi = PendingIntent.getBroadcast(
                    context, REQ_CODE, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                am.cancel(pi)
            }
            var count = 0
            for (e in list) {
                val ms = e.optLong("startTimeMs", 0L)
                if (ms > System.currentTimeMillis()) {
                    registerEvent(context, e.optLong("id", 0L), e.optString("title", "配信"), e.optString("url", ""), ms)
                    count++
                }
            }
            Log.i(TAG, "アラーム再登録: $count 件")
        }.start()
    }

    private fun readSavedEvents(context: Context): List<JSONObject> = try {
        val raw = prefs(context).getString(KEY_EVENTS, "[]") ?: "[]"
        val arr = JSONArray(raw)
        (0 until arr.length()).map { arr.getJSONObject(it) }
    } catch (e: Exception) {
        emptyList()
    }

    /**
     * /api/events?status=scheduled から将来の配信を取得する。
     * 通信は java.net.HttpURLConnection を使う（依存を増やさないため）。
     */
    private fun fetchUpcomingEvents(context: Context): List<JSONObject> {
        val url = java.net.URL("https://koinoyamai.love/api/events?status=scheduled&limit=20")
        val conn = url.openConnection() as java.net.HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.requestMethod = "GET"
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            val items = json.optJSONArray("items") ?: JSONArray()
            val out = mutableListOf<JSONObject>()
            for (i in 0 until items.length()) {
                val it = items.getJSONObject(i)
                val ms = parseServerTime(it.optString("start_time")) ?: continue
                if (ms <= System.currentTimeMillis()) continue
                out.add(JSONObject().apply {
                    put("id", it.optLong("id", 0L))
                    put("title", it.optString("title", "配信"))
                    put("url", it.optString("url", ""))
                    put("startTimeMs", ms)
                })
            }
            return out
        } finally {
            conn.disconnect()
        }
    }

    /**
     * サーバーの start_time を epoch ms に変換する。
     *
     * ⚠️ サーバーの start_time はタイムゾーン表記が混在している
     * （"2026-10-18T23:45:51" = JST の naive / "...Z" = UTC）。
     * オフセットが無いものは **JST（+09:00）** として解釈する。
     */
    fun parseServerTime(raw: String?): Long? {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty()) return null
        return try {
            if (s.endsWith("Z") || s.matches(Regex(".*[+-]\\d{2}:?\\d{2}$"))) {
                // 明示的なオフセット付き → そのまま解釈
                java.time.Instant.parse(if (s.endsWith("Z")) s else s) .toEpochMilli()
            } else {
                // naive → JST として解釈
                val pattern = if (s.contains("T")) "yyyy-MM-dd'T'HH:mm:ss" else "yyyy-MM-dd'T'HH:mm"
                val fmt = java.text.SimpleDateFormat(pattern, java.util.Locale.US)
                fmt.timeZone = TimeZone.getTimeZone("Asia/Tokyo")
                val d = fmt.parse(s) ?: return null
                d.time
            }
        } catch (e: Exception) {
            Log.w(TAG, "start_time の解析に失敗: $s (${e.message})")
            null
        }
    }

    /**
     * 標準のアラーム時計にアラームを設定する（ACTION_SET_ALARM）。
     *
     * ⚠️ 公式ドキュメント: EXTRA_SKIP_UI は API 19 以降無視され、
     * アラームアプリは必ず確認 UI を出す（＝ユーザーの 1 タップが必須）。
     * このメソッドはその確認画面を開くだけなので、
     * 「確実に目視でセットしたい」場合の補助として使う。
     */
    fun openSystemAlarmSetScreen(context: Context, hour: Int, minute: Int, message: String) {
        val intent = Intent(android.provider.AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(android.provider.AlarmClock.EXTRA_HOUR, hour)
            putExtra(android.provider.AlarmClock.EXTRA_MINUTES, minute)
            putExtra(android.provider.AlarmClock.EXTRA_MESSAGE, message)
            putExtra(android.provider.AlarmClock.EXTRA_SKIP_UI, true)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "アラームアプリを開けません: ${e.message}")
        }
    }
}
