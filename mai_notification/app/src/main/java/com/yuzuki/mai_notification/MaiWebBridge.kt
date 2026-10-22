package com.yuzuki.mai_notification

import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface

class MaiWebBridge(
    private val context: Context,
    private val onMenuOpenChanged: ((Boolean) -> Unit)? = null
) {

    // ハンバーガーメニューの開閉をネイティブへ通知（pull-to-refresh制御に使用）
    @JavascriptInterface
    fun setMenuOpen(open: Boolean) {
        Log.d("MaiWebBridge", "setMenuOpen: $open")
        onMenuOpenChanged?.invoke(open)
    }

    // アプリのバージョン（Web 側で旧バージョンの利用者に入れ直しを案内するのに使う。v1.1 で追加）
    @JavascriptInterface
    fun getAppVersion(): String {
        return try {
            "{\"versionName\":\"${UpdateChecker.currentVersionName(context)}\",\"versionCode\":${UpdateChecker.currentVersionCode(context)}}"
        } catch (e: Exception) {
            "{}"
        }
    }

    // Web の「推し始めた日」(YYYY-MM-DD / 空文字で解除) をホーム画面ウィジェット用に保存（v1.2）
    @JavascriptInterface
    fun setOshiDate(ymd: String?) {
        if (com.yuzuki.mai_notification.widget.MaiDates.setOshiStart(context, ymd)) {
            com.yuzuki.mai_notification.widget.WidgetCommon.requestUpdate(
                context, com.yuzuki.mai_notification.widget.CountWidgetProvider::class.java)
        }
    }

    // ホーム画面にウィジェットを追加するダイアログを出す（kind: "count" / "schedule"）。
    // ランチャーが対応していない場合は false（その時は Web 側で手動追加の手順を案内する）
    @JavascriptInterface
    fun requestPinWidget(kind: String): Boolean {
        val mgr = android.appwidget.AppWidgetManager.getInstance(context)
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O || !mgr.isRequestPinAppWidgetSupported) return false
        val cls = when (kind) {
            "schedule" -> com.yuzuki.mai_notification.widget.ScheduleWidgetProvider::class.java
            else -> com.yuzuki.mai_notification.widget.CountWidgetProvider::class.java
        }
        return mgr.requestPinAppWidget(android.content.ComponentName(context, cls), null, null)
    }

    @JavascriptInterface
    fun isAndroidApp(): Boolean {
        Log.d("MaiWebBridge", "isAndroidApp")
        return true
    }

    @JavascriptInterface
    fun getAndroidClientId(): String {
        val clientId = FcmRegistrar.getClientId(context)
        Log.d("MaiWebBridge", "getAndroidClientId: $clientId")
        return clientId
    }

    @JavascriptInterface
    fun isNotificationsEnabled(): Boolean {
        Log.d("MaiWebBridge", "isNotificationsEnabled")
        return FcmRegistrar.isNotificationsEnabled(context)
    }

    @JavascriptInterface
    fun setNotificationsEnabled(enabled: Boolean) {
        Log.d("MaiWebBridge", "setNotificationsEnabled: $enabled")
        FcmRegistrar.updateAllSettings(context, enabled)
    }

    @JavascriptInterface
    fun updateSettings(settingsJson: String) {
        Log.d("MaiWebBridge", "updateSettings")
        FcmRegistrar.updateSettings(context, settingsJson)
    }

    @JavascriptInterface
    fun sendTestNotification() {
        Log.d("MaiWebBridge", "sendTestNotification")
        FcmRegistrar.sendTest(context)
    }

    // ===== 配信開始アラーム（v1.7.3 で追加 / v1.7.4 でループ再生に強化）=====

    /**
     * アラームの状態を JSON で返す。
     * {"enabled":bool,"offsetMin":int,"canExact":bool,"choices":[int]}
     */
    @JavascriptInterface
    fun getStreamAlarmState(): String {
        return try {
            val choices = AlarmScheduler.OFFSET_CHOICES.joinToString(",")
            """{"enabled":${AlarmScheduler.isEnabled(context)},"offsetMin":${AlarmScheduler.offsetMin(context)},"canExact":${AlarmScheduler.canScheduleExact(context)},"choices":[$choices]}"""
        } catch (e: Exception) {
            """{"enabled":false,"offsetMin":15,"canExact":false,"choices":[0,5,10,15,30]}"""
        }
    }

    /** アラームの有効/無効を切り替える */
    @JavascriptInterface
    fun setStreamAlarmEnabled(enabled: Boolean) {
        Log.d("MaiWebBridge", "setStreamAlarmEnabled: $enabled")
        AlarmScheduler.setEnabled(context, enabled)
    }

    /** 何分前に鳴らすか（0 = 開始時刻そのもの） */
    @JavascriptInterface
    fun setStreamAlarmOffsetMin(minutes: Int) {
        Log.d("MaiWebBridge", "setStreamAlarmOffsetMin: $minutes")
        AlarmScheduler.setOffsetMin(context, minutes)
    }

    /**
     * 鳴っているアラームを止める（アプリ内から）。
     * 通知の「停止」ボタンやアプリを開く操作と同じ効果。
     */
    @JavascriptInterface
    fun stopStreamAlarm() {
        Log.d("MaiWebBridge", "stopStreamAlarm")
        try {
            AlarmSoundService.stop(context)
        } catch (e: Exception) {
            Log.w("MaiWebBridge", "アラームの停止に失敗: ${e.message}")
        }
    }

    /** 正確なアラームの権限画面を開く（権限が無いときの導線） */
    @JavascriptInterface
    fun openExactAlarmSettings() {
        Log.d("MaiWebBridge", "openExactAlarmSettings")
        AlarmScheduler.requestExactAlarmPermission(context)
    }

    /**
     * 端末の標準アラーム時計にアラームを設定する画面を開く。
     * ⚠️ EXTRA_SKIP_UI は API 19 以降無視され、アラームアプリが必ず確認 UI を出す
     * （＝ユーザーの 1 タップが必須）。補助手段として使う。
     */
    @JavascriptInterface
    fun openSystemAlarmSetScreen(hour: Int, minute: Int, message: String) {
        Log.d("MaiWebBridge", "openSystemAlarmSetScreen: $hour:$minute")
        AlarmScheduler.openSystemAlarmSetScreen(context, hour, minute, message)
    }

    /** 次の配信の開始時刻（epoch ms）を返す。予定が無ければ 0。 */
    @JavascriptInterface
    fun getNextStreamStartAt(): Long {
        return try {
            val url = java.net.URL("https://koinoyamai.love/api/events?status=scheduled&limit=50")
            val conn = url.openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            try {
                if (conn.responseCode !in 200..299) return 0L
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                val items = org.json.JSONObject(body).optJSONArray("items") ?: org.json.JSONArray()
                var min = 0L
                for (i in 0 until items.length()) {
                    val ms = AlarmScheduler.parseServerTime(items.getJSONObject(i).optString("start_time")) ?: continue
                    if (ms > System.currentTimeMillis() && (min == 0L || ms < min)) min = ms
                }
                min
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w("MaiWebBridge", "次の配信の取得に失敗: ${e.message}")
            0L
        }
    }
}
