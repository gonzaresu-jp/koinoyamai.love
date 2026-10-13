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
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : AppCompatActivity() {

    companion object {
        // アプリ内ブラウザで開く自サイトのトップ
        private const val HOME_URL = "https://koinoyamai.love"

        // ログイン（Google / Discord OAuth）はアプリ内ブラウザのまま完結させる必要があるため、
        // ここに載っているホストへの遷移だけは外部に出さない
        private val AUTH_HOSTS = setOf(
            "accounts.google.com",
            "discord.com",
            "login.discord.com"
        )
    }

    private lateinit var web: WebView
    private lateinit var swipe: SwipeRefreshLayout

    // ハンバーガーメニューが開いているか（pull-to-refresh抑止用）
    @Volatile
    private var menuOpen: Boolean = false

    // Android13 通知許可
    private val requestPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { isGranted ->
            if (isGranted) {
                Toast.makeText(this, "通知が許可されました", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "通知がブロックされました", Toast.LENGTH_SHORT).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // スプラッシュテーマ → 通常テーマに切り替え
        setTheme(R.style.Theme_MaiNotification)

        super.onCreate(savedInstanceState)

        // Android15+はedge-to-edgeが強制されstatusBarColor/navigationBarColorは無視されるため、
        // ルートビューの背景を紫にして透明なシステムバーの下から色が見えるようにする
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        // 通知チャンネルをアプリ起動時に確実に作成
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "mai_default",
                "一般通知",
                NotificationManager.IMPORTANCE_HIGH
            )
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
        try {
            val wv = WebView.getCurrentWebViewPackage()
            Log.d("MaiApp", "webview=${wv?.packageName} ${wv?.versionName}")
        } catch (e: Exception) {
            Log.w("MaiApp", "webview package read failed", e)
        }

        // v1.2: WebView.enableSlowWholeDocumentDraw() を削除。
        // ページ全体（画面外も含む）を毎回描画させる設定で、スクロールや表示が重くなる主因だった
        // （本来はページ全体のスクリーンショット用。backdrop-filter の描画には不要）。

        // PullToRefreshレイアウト作成
        swipe = SwipeRefreshLayout(this)
        web = WebView(this)
        web.addJavascriptInterface(
            MaiWebBridge(this) { open -> menuOpen = open },
            "MaiApp"
        )
        swipe.addView(web)
        setContentView(swipe)

        // 表示中の WebView の描画プロセスを優先度「重要」に（バックグラウンドでは下げる）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)
        }

        // アップデート確認（6時間に1回まで・失敗しても無視）。初回表示の邪魔をしないよう少し遅らせる
        web.postDelayed({ com.yuzuki.mai_notification.UpdateChecker.checkOnLaunch(this) }, 3000)
        // v1.1: 起動のたびに clearCache(true) していたのをやめる（毎回すべてを再ダウンロードしていた）。
        // JS/CSS は ?v=更新日時 付きで配信され、HTML はサーバーが no-store を返すので、キャッシュを使っても古くならない。
        web.clearHistory()

        // ルート背景を紫に。透明化したステータスバー/ナビバーの下からこの色が透けて見える
        swipe.setBackgroundColor(android.graphics.Color.parseColor("#B11E7C"))

        // システムバー分の余白をWebViewコンテナに付与（コンテンツがバーと重ならないように）
        ViewCompat.setOnApplyWindowInsetsListener(swipe) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        // SwipeRefreshのインジケーター色をメインカラーに合わせる
        swipe.setColorSchemeResources(R.color.primary)

        // pull-to-refresh は「WebViewが先頭」かつ「メニューを開いていない」時だけ有効。
        // （メニューを開いて上から引っ張ってもリロードしない／スクロール途中での誤リロードも防ぐ）
        swipe.setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 || menuOpen }

        // WebView設定
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            // サーバーの Cache-Control に従う（旧: LOAD_NO_CACHE で常にネットワークから取得していた）
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT

            databaseEnabled = true
            allowFileAccess = true
            mediaPlaybackRequiresUserGesture = false

            // 画面外（スクロール先）も事前にラスタライズしてスクロールを滑らかに
            offscreenPreRaster = true

            // モバイル表示にするためUserAgentをスマホ向けに設定
            userAgentString = "Mozilla/5.0 (Linux; Android 13; Pixel 7) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/124.0.0.0 Mobile Safari/537.36 MaiApp/" + com.yuzuki.mai_notification.UpdateChecker.currentVersionName(this@MainActivity)
        }

        web.webViewClient = object : WebViewClient() {

            // 自サイト内はWebViewのまま遷移し、外部リンクはブラウザ／専用アプリで開く
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val uri = request?.url ?: return false
                val scheme = uri.scheme?.lowercase()

                if (scheme == "http" || scheme == "https") {
                    // iframe（サブフレーム）はWebView内で読む
                    if (!request.isForMainFrame) return false
                    // 自サイト（*.honna-yuzuki.com）とログインフローはアプリ内ブラウザのまま
                    if (isOwnSite(uri) || isAuthHost(uri.host)) return false
                    // 外部はOSに委譲。開けなかった時だけWebViewで読む
                    return openExternal(uri.toString())
                }

                // data: / about: / blob: / javascript: などはWebViewに任せる
                if (scheme == null || scheme == "data" || scheme == "about" ||
                    scheme == "blob" || scheme == "javascript" || scheme == "file"
                ) return false

                // tel: / mailto: / intent: などはOSに任せる（開けなければWebViewに任せる）
                return openExternal(uri.toString())
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                Log.d("MaiWebBridge", "onPageFinished url=$url")
                swipe.isRefreshing = false

                // ステータスバーの高さをCSS変数としてWebViewに注入
                val insets = ViewCompat.getRootWindowInsets(web)
                val statusBarHeight = insets
                    ?.getInsets(WindowInsetsCompat.Type.statusBars())?.top ?: 0
                val statusBarDp = statusBarHeight / resources.displayMetrics.density
                Log.d("DEBUG_INSETS", "statusBarHeight(px): $statusBarHeight, dp: $statusBarDp")

                view?.evaluateJavascript("""
                    (function() {
                        // ステータスバー高さをCSS変数として注入
                        document.documentElement.style.setProperty('--status-bar-height', '${statusBarDp}px');

                        // headerの実際の高さを測定してCSS変数にセット
                        var header = document.querySelector('header');
                        if (header) {
                            var headerH = header.getBoundingClientRect().height;
                            document.documentElement.style.setProperty('--header-height', headerH + 'px');
                        }

                    })();
                """.trimIndent(), null)


                // ハンバーガーメニュー(body.menu-open)の開閉を監視してネイティブへ通知し、
                // 開いている間は pull-to-refresh を無効化する
                view?.evaluateJavascript("""
                    (function(){
                        if (window.__maiMenuObserver) return;
                        window.__maiMenuObserver = true;
                        var report = function(){
                            try {
                                if (window.MaiApp && window.MaiApp.setMenuOpen) {
                                    window.MaiApp.setMenuOpen(document.body.classList.contains('menu-open'));
                                }
                            } catch (e) {}
                        };
                        new MutationObserver(report).observe(document.body, {
                            attributes: true, attributeFilter: ['class']
                        });
                        report();
                    })();
                """.trimIndent(), null)
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                if (!isDebuggable) return true
                Log.d("WebConsole", "${consoleMessage.messageLevel()}: ${consoleMessage.message()} (${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})")
                return true
            }
        }
        // URLロード
        loadInitialUrl()

        // Pull to refresh
        swipe.setOnRefreshListener {
            web.reload()
        }

        // 戻るボタンでWeb履歴を戻る。先頭では finish() せず裏に回すだけにして、
        // 次に開いた時にページを読み直さず一瞬で復帰できるようにする（v1.2）
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) {
                    web.goBack()
                } else {
                    moveTaskToBack(true)
                }
            }
        })

        // 通知許可確認
        askNotificationPermission()

        // FCMトークン取得（初回表示を優先して少し遅らせる）
        web.postDelayed({ registerFcmToken() }, 1500)
    }

    private val isDebuggable: Boolean by lazy {
        (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        // インストール許可の設定画面から戻った時にアップデート案内を再表示する。
        // 通常時は6時間クールダウンで弾かれるため、起動直後の二重表示にはならない
        web.postDelayed({ com.yuzuki.mai_notification.UpdateChecker.checkOnLaunch(this) }, 1500)
    }

    override fun onPause() {
        // アニメーション等を止めて電池と CPU を節約（JS のタイマーは止めない＝SSE は維持）
        web.onPause()
        super.onPause()
    }

    private fun registerFcmToken() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.w("FCM", "FCMトークン取得失敗", task.exception)
                return@addOnCompleteListener
            }
            val token = task.result
            Log.d("FCM", "FCMトークン: $token")
            FcmRegistrar.registerToken(applicationContext, token)
        }
    }

    private fun loadInitialUrl() {
        val targetUrl = intent?.getStringExtra("targetUrl")
        val uri = targetUrl?.let { runCatching { Uri.parse(it) }.getOrNull() }
        val scheme = uri?.scheme?.lowercase()

        if (uri != null && (scheme == "http" || scheme == "https")) {
            if (isOwnSite(uri)) {
                web.loadUrl(uri.toString())
                return
            }
            // 通知のリンク先が外部の場合はブラウザ／専用アプリで開く。
            // 帰ってきた時に白紙にならないよう、アプリ側はホームを表示しておく
            web.loadUrl(HOME_URL)
            openExternal(uri.toString())
            return
        }
        web.loadUrl(HOME_URL)
    }

    // アプリ内ブラウザで開いてよい自サイトかどうか
    private fun isOwnSite(uri: Uri): Boolean {
        val host = uri.host?.lowercase() ?: return false
        return host == "honna-yuzuki.com" || host.endsWith(".honna-yuzuki.com") ||
                host == "koinoyamai.love" || host.endsWith(".koinoyamai.love")
    }

    // ログイン（OAuth）に必要なホストかどうか
    private fun isAuthHost(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        return h in AUTH_HOSTS
    }

    /**
     * 外部リンクを開く。http(s) はまず専用アプリ（YouTube等）を優先し、
     * ブラウザしか使えないURLはブラウザ（または選択ダイアログ）で開く。
     * どちらも開けなかったら false（= 読み込みを中断せずWebViewに任せる）。
     */
    private fun openExternal(url: String): Boolean {
        val isWeb = url.startsWith("http://", ignoreCase = true) ||
                url.startsWith("https://", ignoreCase = true)
        val intent = try {
            if (url.startsWith("intent:", ignoreCase = true)) {
                Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
            } else {
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
            }
        } catch (e: Exception) {
            Log.w("MaiApp", "invalid uri: $url", e)
            return false
        }

        if (isWeb) {
            // まず専用アプリで開く（ブラウザしか使えないURLは例外になる）
            try {
                startActivity(Intent(intent).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    flags = flags or Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER
                })
                return true
            } catch (_: Exception) {
                Log.d("MaiApp", "no non-browser handler for $url")
            }
        }

        // ブラウザ（または選択ダイアログ）で開く
        return try {
            startActivity(intent)
            true
        } catch (e: Exception) {
            Log.w("MaiApp", "no activity for $url", e)
            false
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        // 通知・ウィジェットから URL 指定で開かれた時だけ読み込む。
        // ランチャーから再表示しただけの時は、今のページをそのまま見せる（再読み込みしない）
        if (intent?.getStringExtra("targetUrl") != null) loadInitialUrl()
    }

    // Android13通知許可
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
}







