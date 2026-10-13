package com.yuzuki.mai_notification.ui.web

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.yuzuki.mai_notification.MaiWebBridge
import com.yuzuki.mai_notification.UpdateChecker

/**
 * 案Bの「WebView 残置」面。
 *
 * wiki / アーカイブ詳細 / logs / guide / download / 管理画面・OAuth ログインなど、
 * Phase 1 でネイティブ化しないページをここで表示する。
 * WebViewPool 経由でインスタンスを再利用し、タブ切替で再ロードしない。
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewScreen(startUrl: String) {
    val context = LocalContext.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var canGoBack by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }

    // 戻る: WebView の履歴を戻る。尽きたら NavHost（タブ）へ戻る
    BackHandler(enabled = canGoBack) { webView?.goBack() }

    val bridge = remember {
        MaiWebBridge(context) { open -> menuOpen = open }
    }

    // プールから再利用できるものがあれば使う
    val pooledKey = remember(startUrl) { startUrl }
    val pooled = remember(startUrl) { WebViewPool.get(pooledKey) }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { webView?.reload() },
        modifier = Modifier.fillMaxSize(),
        content = {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    // プールに有効な WebView があれば再利用（再ロード不要）
                    pooled?.also { existing ->
                        (existing.parent as? ViewGroup)?.removeView(existing)
                        webView = existing
                        canGoBack = existing.canGoBack()
                        return@AndroidView existing
                    }

                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                        addJavascriptInterface(bridge, "MaiApp")
                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true
                            useWideViewPort = true
                            loadWithOverviewMode = true
                            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
                            databaseEnabled = true
                            allowFileAccess = true
                            mediaPlaybackRequiresUserGesture = false
                            offscreenPreRaster = true
                            userAgentString = "Mozilla/5.0 (Linux; Android 13; Pixel 7) " +
                                "AppleWebKit/537.36 (KHTML, like Gecko) " +
                                "Chrome/124.0.0.0 Mobile Safari/537.36 MaiApp/" +
                                UpdateChecker.currentVersionName(ctx)
                        }

                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(
                                view: WebView?,
                                request: WebResourceRequest?
                            ): Boolean {
                                val uri = request?.url ?: return false
                                val scheme = uri.scheme?.lowercase()

                                if (scheme == "http" || scheme == "https") {
                                    if (!request.isForMainFrame) return false
                                    if (isOwnSite(uri) || isAuthHost(uri.host)) return false
                                    return openExternal(ctx, uri)
                                }
                                if (scheme == null || scheme == "data" || scheme == "about" ||
                                    scheme == "blob" || scheme == "javascript" || scheme == "file"
                                ) return false
                                return openExternal(ctx, uri)
                            }

                            override fun onPageFinished(view: WebView?, url: String?) {
                                refreshing = false
                                canGoBack = view?.canGoBack() == true
                                // ステータスバー高さと header 高さを CSS 変数として注入（旧MainActivityと同一）
                                view?.evaluateJavascript(
                                    """
                                    (function() {
                                        var header = document.querySelector('header');
                                        if (header) {
                                            document.documentElement.style.setProperty(
                                                '--header-height', header.getBoundingClientRect().height + 'px');
                                        }
                                    })();
                                    """.trimIndent(), null
                                )
                                // ハンバーガーメニュー開閉の監視（pull-to-refresh 抑止用）
                                view?.evaluateJavascript(
                                    """
                                    (function(){
                                        if (window.__maiMenuObserver) return;
                                        window.__maiMenuObserver = true;
                                        var report = function(){
                                            try {
                                                if (window.MaiApp && window.MaiApp.setMenuOpen) {
                                                    window.MaiApp.setMenuOpen(
                                                        document.body.classList.contains('menu-open'));
                                                }
                                            } catch (e) {}
                                        };
                                        new MutationObserver(report).observe(document.body, {
                                            attributes: true, attributeFilter: ['class']
                                        });
                                        report();
                                    })();
                                    """.trimIndent(), null
                                )
                                // ページが変わったらプールのキーを更新
                                url?.let { WebViewPool.put(it, view ?: return) }
                            }
                        }
                        webChromeClient = object : WebChromeClient() {
                            override fun onConsoleMessage(m: ConsoleMessage): Boolean = true
                        }
                        loadUrl(startUrl)
                        WebViewPool.put(startUrl, this)
                        webView = this
                    }
                },
                update = { v -> canGoBack = v.canGoBack() },
                onRelease = { _ ->
                    // プールに残すため destroy しない。Activity 破棄時に clear() される。
                }
            )
        }
    )
}
