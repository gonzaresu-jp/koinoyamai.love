package com.yuzuki.mai_notification

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 予約された「配信開始アラーム」が発火したときの処理。
 *
 * ポイント:
 *   - 高優先度（IMPORTANCE_HIGH）の専用チャネルで通知する。
 *     チャネルの優先度はインストール後にユーザーしか変えられないので、
 *     初回から鳴らせるよう、アラームの「音・バイブ」はチャネルの設定に従う
 *     （チャネルの設定はインストール後にユーザーしか変えられない）。
 *   - full-screen intent を付けると、画面が消えていても全画面表示されうる
 *     （Android 14+ では「全画面intent」の権限が必要）。
 *     権限が無い場合は通常の通知として表示される。
 *   - 画面を確実に起こすため、AlarmManager 側の exact alarm でデバイスを起こす。
 */
class AlarmReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "AlarmReceiver"
        const val ACTION_STREAM_ALARM = "com.yuzuki.mai_notification.STREAM_ALARM"
        const val EXTRA_EVENT_ID = "event_id"
        const val EXTRA_TITLE = "title"
        const val EXTRA_URL = "url"
        private const val REQ_CODE = 8102
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_STREAM_ALARM) return
        // 通知の表示とスケジュールの取り直しでネットワークを叩くため、
        // broadcast の猶予（10秒）を goAsync で確保する
        val pending = goAsync()
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "配信が始まります"
        val url = intent.getStringExtra(EXTRA_URL)
        val eventId = intent.getLongExtra(EXTRA_EVENT_ID, 0L)
        Log.i(TAG, "配信アラーム発火: $title (id=$eventId)")

        AlarmScheduler.ensureChannel(context)

        // 通知をタップしたら配信ページを開く
        val openIntent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            if (!url.isNullOrBlank()) putExtra("targetUrl", url)
        }
        val contentPi = PendingIntent.getActivity(
            context, REQ_CODE, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        // 全画面表示用（画面が消えていても先に出す）
        val fullPi = PendingIntent.getActivity(
            context, REQ_CODE + 1, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, AlarmScheduler.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText("配信が始まる時間です")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(contentPi)
            .setFullScreenIntent(fullPi, true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()

        // 通知 ID: eventId が無い場合（FCM 経由）は title から安定に作る
        val notifyId = if (eventId != 0L) eventId.toInt() else (title.hashCode() and 0x00FFFFFF)
        try {
            NotificationManagerCompat.from(context).notify(notifyId, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "通知の表示に失敗しました（通知権限なし？）: ${e.message}")
        }

        // 発火後は同じアラームを再登録しない（次回にスケジュールを取り直して登録する）
        Thread {
            try {
                AlarmScheduler.rescheduleFromServer(context)
            } catch (e: Exception) {
                Log.w(TAG, "再登録に失敗: ${e.message}")
            } finally {
                pending.finish()
            }
        }.start()
    }

}
