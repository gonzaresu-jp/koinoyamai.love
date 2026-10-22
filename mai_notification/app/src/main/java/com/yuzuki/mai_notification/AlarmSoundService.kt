package com.yuzuki.mai_notification

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * 配信アラームの音を**繰り返し鳴らし続ける**フォアグラウンドサービス。
 *
 * なぜ必要か（2026-10-22 実測・ユーザー報告）:
 *   - これまで（通知チャネルにアラーム音を持たせる方式）は
 *     **チャネル音が 1 回鳴るだけ**で止まっていた。
 *     「スマホのアラームは確かに鳴ったけど短いし、ユーザーが止めるまで鳴らす
 *     ような設計じゃない。これじゃ起きれない」＝アラームとして機能していない。
 *   - 通知チャネルは「チャネルに音を持たせる」だけなので**ループ再生できない**
 *     （鳴らし続けるには自前の再生が必要です）。
 *
 * 方式:
 *   - MediaPlayer で端末のアラーム音（RingtoneManager.TYPE_ALARM）を
 *     `isLooping = true` で**ループ再生**する。
 *     `USAGE_ALARM` なのでマナーモード・消音でも鳴る（アラーム音量）。
 *   - バイブもサービス側で繰り返す（チャネルのバイブは 1 回だけになるため）。
 *   - 通知は **ongoing**（スワイプで消せない）＋「停止」アクションでユーザーが停止できる。
 *   - **最大 10 分で自動停止**する（放置で鳴りっぱなしにならないための安全弁）。
 *   - 画面を消す・ロックするときには full-screen intent でアラーム画面を先に出す。
 *
 * フォアグラウンドサービスの制限（Android 12+ のバックグラウンド起動制限）:
 *   - `AlarmManager.setAlarmClock()` からの起動は**免除**されている
 *     （exact alarm は FGS を開始してよい）。→ アラーム予約からの発火は確実。
 *   - FCM（配信開始通知）からの起動は環境によって拒否されうるため、
 *     失敗したら**通常の通知にフォールバック**する（黙って無音にしない）。
 *
 * チャネルの音について:
 *   - このサービスの通知は**無音チャネル**（mai_stream_alarm_loop）を使う。
 *     音はサービスが鳴らすので、チャネル音と二重に鳴らさない。
 *     ※ 既存の mai_stream_alarm チャネル（アラーム音つき）は
 *       「事前通知（15分前など）」用に残す。
 */
class AlarmSoundService : Service() {

    companion object {
        private const val TAG = "AlarmSoundService"

        const val ACTION_START = "com.yuzuki.mai_notification.ALARM_SOUND_START"
        const val ACTION_STOP = "com.yuzuki.mai_notification.ALARM_SOUND_STOP"
        const val EXTRA_TITLE = "title"
        const val EXTRA_URL = "url"
        /** full-screen intent で起動したことを示す（MainActivity はこれを見て停止しない） */
        const val EXTRA_FROM_ALARM = "from_alarm"

        /** 無音チャネル（音はサービスが鳴らす） */
        const val CHANNEL_ID = "mai_stream_alarm_loop"

        private const val NOTIF_ID = 8601

        /** フォアグラウンドサービスを開始できず、通常の通知にフォールバックしたときの通知 ID */
        private const val FALLBACK_NOTIF_ID = 8602

        /**
         * 最大鳴動時間（ユーザーが止める前に鳴り続けるが、放置で鳴りっぱなしにはしない）。
         * 既定のオフセット（15分前）と同程度にしてある（鳴っている間に次の予定に備える）。
         */
        private const val MAX_DURATION_MS = 15 * 60 * 1000L

        /** アラーム音を鳴らし始める */
        fun start(context: Context, title: String?, url: String?): Boolean {
            val intent = Intent(context, AlarmSoundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_URL, url)
            }
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                true
            } catch (e: Exception) {
                // バックグラウンド起動の制限（API 31+）”等で失敗した場合
                Log.w(TAG, "アラームサービスを開始できません: ${e.message}")
                false
            }
        }

        /** アラームを止める（アプリを開いたとき・通知の「停止」操作） */
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, AlarmSoundService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "アラームサービスの停止に失敗: ${e.message}")
            }
        }
    }

    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private val handler = Handler(Looper.getMainLooper())
    private val autoStop = Runnable {
        Log.i(TAG, "最大鳴動時間を超えたので自動停止します")
        stopSelf()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Log.i(TAG, "停止アクションで停止します")
            stopSelf()
            return START_NOT_STICKY
        }

        ensureChannel(this)

        // ★ startForeground は 5 秒以内に呼ばないと ForegroundServiceDidNotStartInTimeException で
        //   プロセスが落ちる。音の準備（prepare()）は時間がかかりうるので**先に** startForeground する。
        val notification = buildNotification(intent)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIF_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                )
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (e: Exception) {
            // startForeground 自体が拒まれた場合（バックグラウンド起動制限など）
            Log.w(TAG, "startForeground に失敗しました: ${e.message}")
            postFallbackNotification(intent)
            stopSelf()
            return START_NOT_STICKY
        }

        // 既に鳴っている場合は二重に再生しない
        if (player == null && !startSound()) {
            // ★ 音を開始できなかった（アラーム音が無い・再生失敗）→ 1 回だけ鳴る通知にフォールバック
            //   （無音チャネルなので、このままでは完全に無音になる）
            Log.w(TAG, "アラーム音を開始できませんでした。通常の通知にフォールバックします")
            postFallbackNotification(intent)
            stopSelf()
            return START_NOT_STICKY
        }

        handler.removeCallbacks(autoStop)
        handler.postDelayed(autoStop, MAX_DURATION_MS)
        // STICKY にすると、システムが kill した後にアラームが勝手に鳴り始めるので NOT_STICKY にする
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(autoStop)
        try {
            player?.let {
                if (it.isPlaying) it.stop()
                it.release()
            }
        } catch (e: Exception) {
            Log.w(TAG, ".player の停止に失敗: ${e.message}")
        }
        player = null
        try {
            vibrator?.cancel()
        } catch (e: Exception) {
            Log.w(TAG, "バイブの停止に失敗: ${e.message}")
        }
        vibrator = null
        Log.i(TAG, "アラーム音を停止しました")
        super.onDestroy()
    }

    /**
     * アラーム音（端末のアラーム音）をループ再生し、バイブも繰り返す。
     * @return 音を開始できたか（false なら呼び出し側でフォールバックする）
     */
    private fun startSound(): Boolean {
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        if (uri == null) {
            Log.w(TAG, "アラーム音が見つかりません（音なしで通知のみ）")
            return false
        }
        var mp: MediaPlayer? = null
        try {
            val attrs = AudioAttributes.Builder()
                // USAGE_ALARM: マナーモード/消音でもアラーム音量で鳴る
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            mp = MediaPlayer()
            mp.setAudioAttributes(attrs)
            mp.setDataSource(this@AlarmSoundService, uri)
            mp.isLooping = true      // ★ ユーザーが止めるまで鳴らし続ける
            mp.prepare()
            mp.start()
            player = mp
            Log.i(TAG, "アラーム音を開始します（ループ）: $uri")
        } catch (e: Exception) {
            Log.w(TAG, "アラーム音の再生に失敗しました: ${e.message}")
            // 途中まで初期化されて孤児になった MediaPlayer を解放する
            try { mp?.release() } catch (e2: Exception) { /* noop */ }
            player = null
            return false
        }

        // バイブ（チャネル側のは 1 回だけなので、サービス側で繰り返す）
        try {
            val vib: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            vibrator = vib
            if (vib != null && vib.hasVibrator()) {
                // 0, 600, 400, 600, 400 を**無限**に繰り返す（repeat=0）
                val pattern = longArrayOf(0, 600, 400, 600, 400)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vib.vibrate(VibrationEffect.createWaveform(pattern, 0))
                } else {
                    @Suppress("DEPRECATION")
                    vib.vibrate(pattern, 0)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "バイブの開始に失敗しました: ${e.message}")
        }
        return true
    }

    /** 継続表示する通知（スワイプで消せない・停止アクション付き） */
    private fun buildNotification(intent: Intent?): Notification {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "配信が始まります"
        val url = intent?.getStringExtra(EXTRA_URL)

        val openIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            if (!url.isNullOrBlank()) putExtra("targetUrl", url)
            // ★ full-screen intent で起動したときは「ユーザーが開いた」ではないため、
            //   MainActivity 側でアラームを止めない（止めると数秒で鳴り終わってしまう）。
            putExtra(EXTRA_FROM_ALARM, true)
        }
        val contentPi = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        // 停止は broadcast 経由にする（`PendingIntent.getService` は
        // バックグラウンド起動制限に引っかかる可能性があるため。
        // 受け取りは AlarmReceiver が担い、`stopService` で確実に止める）。
        val stopPi = PendingIntent.getBroadcast(
            this, 1,
            Intent(this, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_STOP_ALARM),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText("配信が始まりました（停止するまで鳴ります）")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)          // ユーザーがスワイプで消せない
            .setAutoCancel(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(contentPi)
            .setFullScreenIntent(contentPi, true)   // 画面が消えていても先に出す
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .addAction(R.drawable.ic_notification, "停止", stopPi)   // ★ ユーザーが止める
            .build()
    }

    /**
     * フォアグラウンド-servicesを開始できなかった場合のフォールバック。
     * 1 回だけ鳴る通常の通知（アラーム用チャネル）を出して、黙って無音にしない。
     */
    private fun postFallbackNotification(intent: Intent?) {
        try {
            AlarmScheduler.ensureChannel(this)
            val title = intent?.getStringExtra(EXTRA_TITLE) ?: "配信が始まります"
            val url = intent?.getStringExtra(EXTRA_URL)
            val openIntent = Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
                if (!url.isNullOrBlank()) putExtra("targetUrl", url)
            }
            val contentPi = PendingIntent.getActivity(
                this, 2, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val n = NotificationCompat.Builder(this, AlarmScheduler.CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText("配信が始まりました")
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setContentIntent(contentPi)
                .setFullScreenIntent(contentPi, true)
                .build()
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            mgr.notify(FALLBACK_NOTIF_ID, n)
            Log.w(TAG, "フォールバック通知を表示しました（ループ再生は不可）")
        } catch (e: Exception) {
            Log.w(TAG, "フォールバック通知の表示に失敗: ${e.message}")
        }
    }

    /** 無音チャネル（音はサービスが鳴らすので、チャネル音と二重に鳴らさない） */
    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "配信アラーム（鳴り続ける）",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "配信開始にアラーム音を繰り返し鳴らします"
            setSound(null, null)      // 音はサービスが担当
            enableVibration(false)   // バイブもサービスが担当
            lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
        }
        mgr.createNotificationChannel(channel)
    }
}
