package com.yuzuki.mai_notification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 予約された「配信開始アラーム」が発火したときの処理。
 *
 * ポイント:
 *   - 高優先度（IMPORTANCE_HIGH）の専用チャネルで通知する。
 *     -chanel の優先度はインストール後にユーザーしか変えられないので、
 *     初回は!=でも鳴るよう、アラームの「音・バイブ」は channel の設定に従う。
 *   - full-screen intent を付けると、画面が消えていても全画面表示されうる
 *     （Android 14+ では「全画面intent」の権限が必要）。
 *     権限が無い場合は通常の通知として表示される。
 *   - 画面を確実に起こすため、AlterManager が起こsoilなくてよい。
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
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "配信が始まります"
        val url = intent.getStringExtra(EXTRA_URL)
        val eventId = intent.getLongExtra(EXTRA_EVENT_ID, 0L)
        Log.i(TAG, "配信アラーム発火: $title (id=$eventId)")

        ensureChannel(context)

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
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(contentPi)
            .setFullScreenIntent(fullPi, true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(eventId.toInt() or 0x40000000, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "通知の表示に失敗しました（通知権限なし？）: ${e.message}")
        }

        // 発火後は同じアラームを再登録しない（次回にスケジュールを取り直して登録する）
        AlarmScheduler.rescheduleFromServer(context)
    }

    /** アラーム用の通知チャネル（IMPORTANCE_HIGH + アラーム音） */
    private fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val channel = NotificationChannel(
            AlarmScheduler.CHANNEL_ID,
            "配信アラーム",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "配信開始の15分前などに通知します"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 500, 250, 500)
            if (sound != null) setSound(sound, attrs)
            lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
        }
        mgr.createNotificationChannel(channel)
    }
}
