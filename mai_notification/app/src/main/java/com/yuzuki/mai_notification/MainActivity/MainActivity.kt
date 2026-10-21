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
import android.view.MotionEvent
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
import kotlin.math.abs

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

    // 別ウィンドウ要求（target="_blank" / window.open）の受け皿となる一時WebView
    private var windowHolder: WebView? = null

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
        // v1.7: 横方向優勢のスワイプを pull-to-refresh に横取りさせない。
        // カルーセル（count-page 等の横スワイプ）は touch-action:pan-y + JS 変換のため
        // WebView が親への intercept 禁止を出せず、指が下方向にブレた瞬間に
        // SwipeRefreshLayout が奪って ACTION_CANCEL → スワイプ無反応になっていた。
        swipe = DirectionAwareSwipeRefreshLayout(this)
        web = WebView(this)
        web.addJavascriptInterface(
            MaiWebBridge(this) { open -> menuOpen = open },
            "MaiApp"
        )
        swipe.addView(web)
        setContentView(swipe)

        // 描画プロセスは前面を優先（whenInForeground=true で裏に回ったら自動的に WAIVED 降格＝
        // Chrome と同様の挙動）
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

            // v1.7.1: 別ウィンドウ要求（target="_blank" / window.open）を受け取れるようにする。
            // 既定は false のため、YouTube・X 等の rel="noopener" リンクが「新しいウィンドウ」に
            // 落とせず既存WebView内に落ち、アプリ内ブラウザで開いてしまっていた。
            setSupportMultipleWindows(true)
            // JS から直接 window.open されるケース（ユーザー操作を伴わないもの）も許可し、
            // 下の onCreateWindow で自サイト／外部を判定して振り分ける
            javaScriptCanOpenWindowsAutomatically = true

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
                    // 自サイト（*.koinoyamai.love）とログインフローはアプリ内ブラウザのまま
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

            // v1.7.1: target="_blank" / window.open はここ（onCreateWindow）で受け取る。
            // 未実装だと別ウィンドウ要求が既存WebView内に落ち、外部リンクがアプリ内に開かれていた
            // （同一タブ遷移は shouldOverrideUrlLoading で従来通り OS 委譲している）。
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message?
            ): Boolean {
                val src = view ?: return false
                val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false

                // 開くURLは resultMsg 経由でしか渡らないため、受け皿となる一時WebViewを差し込み、
                // その最初の遷移を横取りして shouldOverrideUrlLoading と同じ振り分けに流す
                val holder = WebView(src.context)
                holder.settings.javaScriptEnabled = true
                holder.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView?,
                        request: WebResourceRequest?
                    ): Boolean {
                        val uri = request?.url ?: return false
                        val handled = dispatchNewWindowUrl(uri)
                        if (handled) dismissWindowHolder(holder)
                        return handled
                    }

                    // shouldOverrideUrlLoading が鳴らない経路でも外部に出さない
                    override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                        if (url == null) return
                        // 処理できなかった（about:blank 等、受け皿に任せるURL）なら何もしない
                        if (dispatchNewWindowUrl(Uri.parse(url))) {
                            view?.stopLoading()
                            dismissWindowHolder(holder)
                        }
                    }
                }

                // 前回分の受け皿が残っていれば先に破棄（WebViewリーク防止）
                windowHolder?.let { prev -> runCatching { prev.destroy() } }
                windowHolder = holder
                transport.webView = holder
                resultMsg.sendToTarget()
                return true
            }

            // ダイアログ等のウィンドウが閉じられたら受け皿を破棄
            override fun onCloseWindow(window: WebView?) {
                if (window != null && window !== web) {
                    runCatching { window.destroy() }
                    if (windowHolder === window) windowHolder = null
                }
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
        // 配信開始アラームをスケジュールを取り直して登録し直す
        // （アラーム設定が有効な場合のみ・Exact Alarm 権限が無ければ何もしない）
        try {
            com.yuzuki.mai_notification.AlarmScheduler.rescheduleFromServer(this)
        } catch (e: Exception) {
            Log.w("MainActivity", "アラームの再登録に失敗: ${e.message}")
        }
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
        return host == "koinoyamai.love" || host.endsWith(".koinoyamai.love")
    }

    // ログイン（OAuth）に必要なホストかどうか
    private fun isAuthHost(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        return h in AUTH_HOSTS
    }

    /**
     * 別ウィンドウ要求（target="_blank" / window.open）で渡ってきたURLの振り分け。
     * 自サイト・認証ホストは既存の WebView（web）で開き、それ以外は openExternal()
     * （専用アプリ優先→ブラウザ）に委譲する。tel: / mailto: / intent: も同様。
     *
     * 戻り値 true = 処理済み（受け皿の WebView では読み込まなくてよい）
     */
    private fun dispatchNewWindowUrl(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase()
        val url = uri.toString()

        if (scheme == "http" || scheme == "https") {
            // 自サイトとログインフローはアプリ内ブラウザのまま（新タブは作らない）
            if (isOwnSite(uri) || isAuthHost(uri.host)) {
                web.loadUrl(url)
                return true
            }
            // 専用アプリもブラウザも無ければ、視認される既存WebViewで読む
            //（shouldOverrideUrlLoading と同じ保険。受け皿は画面上に無いため読ませても見えない）
            if (openExternal(url)) return true
            web.loadUrl(url)
            return true
        }

        // data: / about: / blob: / javascript: / file: は受け皿の WebView に任せる
        if (scheme == null || scheme == "data" || scheme == "about" ||
            scheme == "blob" || scheme == "javascript" || scheme == "file"
        ) return false

        // tel: / mailto: / intent: などはOSに任せる（開けなければ受け皿に任せる）
        return openExternal(url)
    }

    // 振り分け完了後の受け皿を破棄する（まだ使われている場合は次回作成時に破棄される）
    private fun dismissWindowHolder(holder: WebView) {
        if (windowHolder === holder) windowHolder = null
        holder.postDelayed({ runCatching { holder.destroy() } }, 100)
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

/**
 * 横方向優勢のジェスチャを pull-to-refresh に横取りさせない SwipeRefreshLayout。
 *
 * カルーセル（.stats-carousel）は CSS touch-action: pan-y ＋ JS transform での横送りなので
 * WebView はネイティブ横スクロールを起こさず、親へ requestDisallowInterceptTouchEvent を
 * 出さない。その結果、指が少しでも下方向にブレると（touchSlop 超過）素の
 * SwipeRefreshLayout が onTouchEvent を奪い、WebView に ACTION_CANCEL が飛んで
 * carousel.js の touch トラックが途切れて「スワイプしても反応しない」が発生していた
 * （ブラウザにはこの親 View がいないため常にスムーズ）。
 *
 * 横が優勢なら intercept を通さず、縦優勢（＝引き下げ）は従来どおり SRL に任せる。
 */
private class DirectionAwareSwipeRefreshLayout(context: Context) : SwipeRefreshLayout(context) {

    private var downX = 0f
    private var downY = 0f

    // 一度 pull-to-refresh のドラッグが始まったら、方向判定で中断しない
    private var refreshingDrag = false

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.x
                downY = ev.y
                refreshingDrag = false
            }

            MotionEvent.ACTION_MOVE -> {
                if (!refreshingDrag) {
                    val dx = abs(ev.x - downX)
                    val dy = abs(ev.y - downY)
                    // 横方向が優勢＝横スワイプ。pull-to-refresh には渡さない
                    if (dx > dy) return false
                }
            }
        }
        val intercepted = super.onInterceptTouchEvent(ev)
        if (intercepted) refreshingDrag = true
        return intercepted
    }
}







