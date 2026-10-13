package com.yuzuki.mai_notification

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
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

        // 表示中の WebView の描画プロセスの優先度をフォアグラウンド/バックグラウンドで切替
        // （Chrome同様、裏に回ったら優先度を下げてメモリを節約。前面では重要に保つ）
        // 描画プロセスを前面では優先（whenInForeground=true で裏に回ったら自動的に WAIVED 降格＝
        // Chrome と同様の挙動。従来からこの設定で既に最適化済み）
        applyRendererPriority()

        // アップデート確認（6時間に1回まで・失敗しても無視）。初回表示の邪魔をしないよう少し遅らせる
        web.postDelayed({ com.yuzuki.mai_notification.UpdateChecker.checkOnLaunch(this) }, 3000)
        // v1.1: 起動のたびに clearCache(true) していたのをやめる（毎回すべてを再ダウンロードしていた）。
        // JS/CSS は ?v=更新日時 付きで配信され、HTML はサーバーが no-store を返すので、キャッシュを使っても古くならない。
        // v1.6: 通知タップ等で targetUrl 指定がない場合は前回のページを restoreState で即復元（2回目以降の起動を高速化）。
        // targetUrl 指定時・初回起動時は clearHistory してから読み込む。
        val targetUrlIntent = intent?.getStringExtra("targetUrl")
        val canRestore = savedInstanceState != null && targetUrlIntent == null
        if (!canRestore) {
            web.clearHistory()
        }

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
            // サーバーの Cache-Control に従う（旧: LOAD_NO_CACHE で常にネットワークから取得していた）。
            // オフライン時のみキャッシュを優先（ブラウザ同様、電波が無くても2回目以降のページを開ける）
            cacheMode = if (isOnline()) {
                android.webkit.WebSettings.LOAD_DEFAULT
            } else {
                android.webkit.WebSettings.LOAD_CACHE_ELSE_NETWORK
            }

            databaseEnabled = true
            allowFileAccess = true
            mediaPlaybackRequiresUserGesture = false

            // v1.6: offscreenPreRaster=true を解除。画面外を事前にラスタライズすると
            // メモリ/GPU使用量が増えて「重い」原因になっていた（Chromeは既定でOFF）
            offscreenPreRaster = false

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

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // ステータスバー高さはDOMに依存しないので onPageStarted で即注入（CSS変数が先に使える）
                val insets = ViewCompat.getRootWindowInsets(web)
                val statusBarHeight = insets
                    ?.getInsets(WindowInsetsCompat.Type.statusBars())?.top ?: 0
                val statusBarDp = statusBarHeight / resources.displayMetrics.density
                view?.evaluateJavascript(
                    "document.documentElement.style.setProperty('--status-bar-height', '${statusBarDp}px');",
                    null
                )
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                Log.d("MaiWebBridge", "onPageFinished url=$url")
                swipe.isRefreshing = false

                // header高さの測定＋menu-open監視を1回の JS 実行にまとめた（v1.6）
                // （以前は evaluateJavascript を2回に分けていたため往復が余分に発生していた）
                view?.evaluateJavascript("""
                    (function(){
                        var h = document.querySelector('header');
                        if (h) {
                            document.documentElement.style.setProperty('--header-height', h.getBoundingClientRect().height + 'px');
                        }
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
        // URLロード or 前回状態の復元
        if (canRestore) {
            // targetUrl 指定なしでプロセス復元された場合は前回のページを即表示（2回目以降の起動を高速化）
            if (web.restoreState(savedInstanceState) == null) {
                loadInitialUrl()
            }
        } else {
            loadInitialUrl()
        }

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

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private fun applyRendererPriority() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)
        }
    }

    // ネットワークが生きているか（オフライン時のキャッシュ優先に使う）
    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
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







