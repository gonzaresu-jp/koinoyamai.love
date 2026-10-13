package com.yuzuki.mai_notification.ui.web

import android.content.Context
import android.view.ViewGroup
import android.webkit.WebView
import java.lang.ref.WeakReference

/**
 * WebView インスタンスのプール（Phase 3）。
 *
 * タブ切替や画面遷移で WebView を破棄・再生成すると、スクロール位置・フォーム入力・
 * ページ内遷移が失われて毎回ロードし直すことになる。本プールはキー（URL）ごとに
 * WebView を保持し、同じキーで再表示された時に再利用する。
 *
 * Activity 破棄時は clear() を呼ぶこと（コンテキストリーク防止）。
 */
object WebViewPool {
    private val pool = mutableMapOf<String, WeakReference<WebView>>()

    /** キーに対応する有効な WebView を返す。無ければ null */
    fun get(key: String): WebView? {
        val ref = pool[key] ?: return null
        val wv = ref.get()
        if (wv == null || wv.context == null) {
            pool.remove(key)
            return null
        }
        return wv
    }

    /** WebView をプールに登録する */
    fun put(key: String, webView: WebView) {
        pool[key] = WeakReference(webView)
    }

    /** プールから削除する（destroy は呼び出し側で行う） */
    fun remove(key: String) {
        pool.remove(key)
    }

    /**
     * すべて破棄する。Activity.onDestroy から呼ぶ。
     * 既に親から切り離された ViewGroup から removeView してから destroy する。
     */
    fun clear() {
        for ((_, ref) in pool.toMap()) {
            ref.get()?.let { wv ->
                try {
                    (wv.parent as? ViewGroup)?.removeView(wv)
                    wv.stopLoading()
                    wv.destroy()
                } catch (_: Exception) {
                }
            }
        }
        pool.clear()
    }
}
