package com.yuzuki.mai_notification

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.ui.platform.ComposeView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.yuzuki.mai_notification.ui.AppRoot
import com.yuzuki.mai_notification.ui.theme.MaiTheme
import com.yuzuki.mai_notification.ui.web.isOwnSite
import com.yuzuki.mai_notification.ui.web.openExternal
import java.net.URLEncoder

/**
 * Phase 1（ネイティブUI化・案Bハイブリッド）のエントリポイント。
 *
 * 旧版はこの Activity に WebView を貼っつけて全画面を Web 表示していたが、
 * ここでは Compose のシェル（AppRoot＝BottomNav＋ネイティブ画面）を表示する。
 * wiki / アーカイブ / OAuth ログイン等は AppRoot 内の WebView タブに逃がす。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val HOME_URL = "https://koinoyamai.love"
        private const val TAG = "MaiApp"

        /**
         * 通知・ウィジェットから渡ってきた URL を解析し、適切なタブへ遷移する。
         *
         * - 自サイトの /history → 履歴タブ（ネイティブ）
         * - 自サイトの /events や /schedule → 予定タブ（ネイティブ）
         * - 自サイトのその他（/wiki, /archive 等） → WebView タブ
         * - 外部 URL → ブラウザへ委譲し、ホームを表示
         */
        private fun resolveStartRoute(intent: Intent?): String {
            val targetUrl = intent?.getStringExtra("targetUrl")
            val uri = targetUrl?.let { runCatching { Uri.parse(it) }.getOrNull() }
            val scheme = uri?.scheme?.lowercase()
            if (uri == null || (scheme != "http" && scheme != "https")) return "home"
            if (!isOwnSite(uri)) return "home" // 外部は openExternal で処理

            val path = uri.path ?: "/"
            return when {
                path == "/" || path.isEmpty() -> "home"
                path.startsWith("/history") -> "history"
                path.startsWith("/events") || path.startsWith("/schedule") -> "schedule"
                else -> "web?url=${URLEncoder.encode(uri.toString(), "UTF-8")}"
            }
        }
    }

    private val requestPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { isGranted ->
            val msg = if (isGranted) "通知が許可されました" else "通知がブロックされました"
            android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
        }

    /** 通知から開いた外部URLは先に委譲してからホームを出す */
    private var pendingExternalUrl: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(R.style.Theme_MaiNotification)
        super.onCreate(savedInstanceState)

        // Android15+ は edge-to-edge が強制。システムバー下から背景色が見えるようにする
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        // 通知チャンネル（アプリ起動時に確実に作成）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "mai_default",
                "一般通知",
                NotificationManager.IMPORTANCE_HIGH
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        try {
            val wv = WebView.getCurrentWebViewPackage()
            Log.d(TAG, "webview=${wv?.packageName} ${wv?.versionName}")
        } catch (e: Exception) {
            Log.w(TAG, "webview package read failed", e)
        }

        // 通知のリンク先が外部だった場合は OS に委譲してからホームを出す
        val target = intent?.getStringExtra("targetUrl")
        val targetUri = target?.let { runCatching { Uri.parse(it) }.getOrNull() }
        if (targetUri != null && isOwnSite(targetUri).not()) {
            val scheme = targetUri.scheme?.lowercase()
            if (scheme == "http" || scheme == "https") {
                pendingExternalUrl = targetUri.toString()
            }
        }

        val startRoute = resolveStartRoute(intent)
        setContentView(
            ComposeView(this).apply {
                setContent {
                    MaiTheme {
                        AppRoot(startRoute = if (pendingExternalUrl != null) "home" else startRoute)
                    }
                }
            }
        )

        pendingExternalUrl?.let {
            openExternal(this, Uri.parse(it))
            pendingExternalUrl = null
        }

        // アップデート確認（初回表示の邪魔をしないよう少し遅らせる）
        android.view.View(this).postDelayed({ UpdateChecker.checkOnLaunch(this) }, 3000)

        askNotificationPermission()

        // FCMトークン取得（初回表示を優先して少し遅らせる）
        android.view.View(this).postDelayed({ registerFcmToken() }, 1500)
    }

    override fun onResume() {
        super.onResume()
        // インストール許可の設定画面から戻った時にアップデート案内を再表示する
        android.view.View(this).postDelayed({ UpdateChecker.checkOnLaunch(this) }, 1500)
    }

    private fun registerFcmToken() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.w("FCM", "FCMトークン取得失敗", task.exception)
                return@addOnCompleteListener
            }
            Log.d("FCM", "FCMトークン: ${task.result}")
            FcmRegistrar.registerToken(applicationContext, task.result)
        }
    }

    // Android13 通知許可
    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                return
            }
            requestPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // 通知・ウィジェットから URL 指定で開かれた時だけ作り直す。
        // ランチャーから再表示しただけの時は今の画面を維持する（旧仕様を維持）
        if (intent?.getStringExtra("targetUrl") != null) recreate()
    }

    override fun onDestroy() {
        super.onDestroy()
        // WebView プールのクリア（コンテキストリーク防止）
        com.yuzuki.mai_notification.ui.web.WebViewPool.clear()
    }
}
