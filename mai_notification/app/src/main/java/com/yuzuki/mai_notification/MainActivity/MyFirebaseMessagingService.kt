package com.yuzuki.mai_notification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

class MyFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        private const val BASE_URL = "https://koinoyamai.love"
        // 展開時の BigPicture 用の最大幅（1280px のサムネイルをそのまま保持しない）
        private const val BIG_PICTURE_MAX_WIDTH = 1024
        // 折りたたみ時に表示される大きなアイコンの最大幅
        private const val LARGE_ICON_MAX_WIDTH = 256
        // 取得する画像の上限サイズ（FCM SDK の画像ローダと同じ 1MiB では maxres が切れるため 5MiB）
        private const val MAX_IMAGE_BYTES = 5 * 1024 * 1024
    }

    // スマホごとに割り当てられるFCMのID（トークン）が更新された時に呼ばれます
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d("FCM", "新しいトークン: $token")
        FcmRegistrar.registerToken(applicationContext, token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        // 配信予定が追加・変更された可能性があるので、スケジュールウィジェットを更新（配置されていなければ何もしない）
        try { com.yuzuki.mai_notification.widget.ScheduleWidgetProvider.requestUpdate(applicationContext) } catch (_: Exception) {}
        Log.d("FCM", "=== onMessageReceived START ===")
        Log.d("FCM", "data keys: ${remoteMessage.data.keys}")
        Log.d("FCM", "data: ${remoteMessage.data}")
        Log.d("FCM", "notification: ${remoteMessage.notification}")
        Log.d("FCM", "from: ${remoteMessage.from}")
        Log.d("FCM", "messageId: ${remoteMessage.messageId}")

        val title = remoteMessage.data["title"] ?: remoteMessage.notification?.title ?: "新着通知"
        val body = remoteMessage.data["body"] ?: remoteMessage.notification?.body ?: "新しいメッセージがあります"
        val url = remoteMessage.data["url"]
        val iconUrl = remoteMessage.data["icon"]
        val imageUrl = remoteMessage.data["image"]
        Log.d("FCM", "title=$title, body=$body, url=$url")

        // 配信開始の予定が入っていれば、端末内アラームを予約する（アラーム機能が有効な場合のみ）
        val startTime = remoteMessage.data["start_time"]
        if (!startTime.isNullOrBlank()) {
            try {
                val ms = com.yuzuki.mai_notification.AlarmScheduler.parseServerTime(startTime)
                if (ms != null) {
                    com.yuzuki.mai_notification.AlarmScheduler.registerEvent(
                        applicationContext, 0L, title, url, ms
                    )
                }
            } catch (e: Exception) {
                Log.w("FCM", "アラーム登録に失敗: ${e.message}")
            }
        }

        // 通知チャンネルID。サーバー側で `channel`（例: 配信開始の "mai_stream_alarm"）を
        // 付けている場合はそれを尊重する（付け無ければ既定の mai_default）。
        // ※ バックグラウンド時は FCM SDK 自身が `channel_id` で描画するため、
        //   ここではフォアグラウンド受信時（および data のみの通知）の描画だけを担う。
        val channelId = remoteMessage.data["channel"]?.takeIf { it.isNotBlank() } ?: "mai_default"

        // ★ 配信開始のときはアラーム音を**ループ再生**する（ユーザーが止めるまで鳴らす）。
        //   サーバーの scheduler.js / youtube.js が `channel: "mai_stream_alarm"` を付けるので、
        //   それを「配信開始」の判定に使う（事前告知 event_pre_* は情報通知のまま）。
        if (channelId == com.yuzuki.mai_notification.AlarmScheduler.CHANNEL_ID) {
            // アラーム用チャネルが無い端末でも確実に鳴るように作成しておく
            try {
                com.yuzuki.mai_notification.AlarmScheduler.ensureChannel(applicationContext)
            } catch (e: Exception) {
                Log.w("FCM", "アラームチャネルの作成に失敗: ${e.message}")
            }
            val loopStarted = com.yuzuki.mai_notification.AlarmSoundService.start(applicationContext, title, url)
            Log.i("FCM", "配信開始: ループアラームを${if (loopStarted) "開始" else "開始できず（通知にフォールバック）"}")
        }

        sendNotification(title, body, url, iconUrl, imageUrl, channelId)
        Log.d("FCM", "=== onMessageReceived END ===")
    }

    private fun normalizeUrl(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val trimmed = url.trim()
        return when {
            trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
            trimmed.startsWith("//") -> "https:$trimmed"
            trimmed.startsWith("/") -> "$BASE_URL$trimmed"
            trimmed.startsWith("./") -> "$BASE_URL/${trimmed.removePrefix("./")}" 
            else -> "$BASE_URL/$trimmed"
        }
    }

    /**
     * 画像を取得し、幅・高さの大きい方が maxWidth 以下になるよう縮小した Bitmap を返す。
     * 通知画像はメモリを圧迫しやすいため、デコード時点で inSampleSize を使う。
     */
    private fun fetchImage(imageUrl: String?, maxWidth: Int): Bitmap? {
        val resolved = normalizeUrl(imageUrl) ?: return null
        if (!resolved.startsWith("https://")) {
            Log.w("FCM", "fetchImage: non-https URL skipped: $resolved")
            return null
        }
        Log.d("FCM", "fetchImage: $resolved (maxWidth=$maxWidth)")
        return try {
            val conn = (URL(resolved).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 8000
                instanceFollowRedirects = true
                doInput = true
            }
            try {
                conn.connect()
                val code = conn.responseCode
                Log.d("FCM", "fetchImage response=$code contentType=${conn.contentType}")
                if (code !in 200..299) {
                    Log.w("FCM", "fetchImage HTTP $code")
                    return null
                }
                val bytes = conn.inputStream.use { readAllBounded(it, MAX_IMAGE_BYTES) }
                if (bytes == null) {
                    Log.w("FCM", "fetchImage: image exceeds $MAX_IMAGE_BYTES bytes")
                    return null
                }
                decodeDownsampled(bytes, maxWidth)
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w("FCM", "fetchImage failed: ${e.message}", e)
            null
        }
    }

    /** 応答本文を上限付きで読む（壊れたURLや巨大画像でOOMしないため）。 */
    private fun readAllBounded(input: InputStream, maxBytes: Int): ByteArray? {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > maxBytes) return null
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    /** 画像バイト列を、幅・高さの大きい方が maxWidth 以下になるよう縮小してデコードする。 */
    private fun decodeDownsampled(bytes: ByteArray, maxWidth: Int): Bitmap? {
        // まず寸法だけ読み、inSampleSize を決める
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            Log.w("FCM", "decodeDownsampled: invalid image bounds")
            return null
        }
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        var sample = 1
        while (longest / (sample * 2) >= maxWidth) sample *= 2
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            // 通知画像は写真（不透明JPEG）なので RGB_565 でメモリを半減させる
            inPreferredConfig = Bitmap.Config.RGB_565
        }

        var bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
        val longestDecoded = maxOf(bitmap.width, bitmap.height)
        if (longestDecoded > maxWidth) {
            val scale = maxWidth.toFloat() / longestDecoded
            val w = (bitmap.width * scale).toInt().coerceAtLeast(1)
            val h = (bitmap.height * scale).toInt().coerceAtLeast(1)
            val scaled = runCatching { Bitmap.createScaledBitmap(bitmap, w, h, true) }
                .onFailure { Log.w("FCM", "decodeDownsampled: scale failed: ${it.message}") }
                .getOrNull()
            if (scaled != null) {
                if (scaled != bitmap) bitmap.recycle()
                bitmap = scaled
            }
        }
        Log.d("FCM", "decodeDownsampled bitmap=${bitmap.width}x${bitmap.height} sample=$sample")
        return bitmap
    }

    // 実際にスマホの画面上に通知を表示する処理
    private fun sendNotification(
        title: String,
        messageBody: String,
        url: String?,
        iconUrl: String?,
        imageUrl: String?,
        channelId: String = "mai_default"
    ) {
        Log.d("FCM", "sendNotification called: title=$title")
        // 自サイトならアプリ内ブラウザ、外部URLならブラウザ／専用アプリで開く（MainActivity側で判定）
        val finalUrl = normalizeUrl(url)

        // 通知をタップした時にMainActivityを開く設定
        val intent = Intent(this, MainActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (!finalUrl.isNullOrBlank()) {
            intent.putExtra("targetUrl", finalUrl)
        }

        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT
        )

        val notificationBuilder = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(messageBody)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)

        // サムネイル（YouTube の配信枠など）を取得し、折りたたみ時の大きなアイコンにも使う。
        // なお、アプリがバックグラウンドのときは onMessageReceived は呼ばれず、FCM SDK が
        // notification.image を使って同様に描画する（折りたたみ＝大きなアイコン／展開＝BigPicture）。
        // ここはフォアグラウンド受信時（および data のみの通知）の描画を担う。
        val heroImage = if (imageUrl != null) fetchImage(imageUrl, BIG_PICTURE_MAX_WIDTH) else null
        if (imageUrl != null && heroImage == null) {
            Log.w("FCM", "heroImage fetch returned null for: $imageUrl")
        } else if (imageUrl == null) {
            Log.d("FCM", "No imageUrl in data, using launcher icon")
        }

        // 大きなアイコン: サムネイルを縮小して使用し、メモリを抑える。無ければランチャーアイコン
        val largeBitmap = heroImage?.let { hero ->
            if (maxOf(hero.width, hero.height) > LARGE_ICON_MAX_WIDTH) {
                val scale = LARGE_ICON_MAX_WIDTH.toFloat() / maxOf(hero.width, hero.height)
                runCatching {
                    Bitmap.createScaledBitmap(
                        hero,
                        (hero.width * scale).toInt().coerceAtLeast(1),
                        (hero.height * scale).toInt().coerceAtLeast(1),
                        true
                    )
                }.onFailure { Log.w("FCM", "large icon scale failed: ${it.message}") }
                    .getOrDefault(hero)
            } else {
                hero
            }
        } ?: runCatching {
            BitmapFactory.decodeResource(resources, R.drawable.ic_mai_logo)
        }.onFailure { Log.w("FCM", "Failed to load launcher icon: ${it.message}") }
            .getOrNull()
        if (largeBitmap != null) {
            notificationBuilder.setLargeIcon(largeBitmap)
        }

        // 展開時は BigPictureStyle で大きく表示
        if (heroImage != null) {
            notificationBuilder.setStyle(
                NotificationCompat.BigPictureStyle()
                    .bigPicture(heroImage)
                    .bigLargeIcon(null as Bitmap?)
            )
        }

        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // Android 8.0以降は通知チャンネルの作成が必須。
        // アラーム用チャネル（mai_stream_alarm）は AlarmScheduler.ensureChannel が
        // アラーム音つきで作るため、こちらは**既に存在すれば触らない**
        // （チャネルの音・バイブはインストール後ユーザーが変えられないので、
        //   作り直すと設定がリセットされる）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && channelId == "mai_default") {
            val channel = NotificationChannel(
                channelId,
                "一般通知",
                NotificationManager.IMPORTANCE_HIGH
            )
            notificationManager.createNotificationChannel(channel)
        }

        // 通知を表示
        val notifId = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
        Log.d("FCM", "posting notification id=$notifId channel=$channelId")
        notificationManager.notify(notifId, notificationBuilder.build())
        Log.d("FCM", "notification posted successfully")
    }
}
