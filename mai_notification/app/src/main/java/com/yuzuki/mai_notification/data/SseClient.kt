package com.yuzuki.mai_notification.data

import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okio.BufferedSource
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * /api/events/stream への SSE クライアント。
 *
 * サーバー側（server.js sseHandler + services/sse.js）の仕様:
 * - 接続時に ": connected\n\n" と "retry: 5000\n\n" を送信
 * - 25秒ごとに ": ping\n\n" ハートビート
 * - 通知追加時に "event: message\ndata: {\"type\":\"history-updated\",...}\n\n"
 *
 * OkHttp のストリーミング応答を simply 読み、data 行の JSON をコールバックに渡す。
 */
class SseClient(
    private val url: String,
    private val client: OkHttpClient,
    private val onEvent: (String) -> Unit,
    private val onConnected: () -> Unit = {},
    private val onDisconnected: (() -> Unit)? = null
) {
    @Volatile
    private var running = false
    private var call: Call? = null

    fun start() {
        if (running) return
        running = true
        connect()
    }

    fun stop() {
        running = false
        call?.cancel()
        call = null
    }

    private fun connect() {
        if (!running) return
        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .build()

        val c = client.newCall(request)
        call = c
        c.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (running && !call.isCanceled()) {
                    // 5秒後に再接続（サーバーの retry: 5000 相当）
                    Thread {
                        try { Thread.sleep(5000) } catch (_: InterruptedException) {}
                        connect()
                    }.start()
                }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { resp ->
                    if (!resp.isSuccessful) {
                        if (running) {
                            Thread {
                                try { Thread.sleep(5000) } catch (_: InterruptedException) {}
                                connect()
                            }.start()
                        }
                        return
                    }
                    val body = resp.body ?: return
                    val source: BufferedSource = body.source()
                    try {
                        onConnected()
                        while (running && !source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            // "data: {...}" 行を抽出
                            if (line.startsWith("data:")) {
                                val json = line.removePrefix("data:").trim()
                                if (json.isNotEmpty()) onEvent(json)
                            }
                            // ": connected" / ": ping" は無視（接続維持のため読むだけ）
                        }
                    } catch (_: IOException) {
                        // 切断（正常）
                    } finally {
                        if (running) {
                            Thread {
                                try { Thread.sleep(3000) } catch (_: InterruptedException) {}
                                connect()
                            }.start()
                        } else {
                            onDisconnected?.invoke()
                        }
                    }
                }
            }
        })
    }

    companion object {
        /** アプリ内で共有するクライアント（Cookie 共有のため ApiClient と同じ okHttp を使う） */
        fun shared(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS) // SSE は無制限
                .pingInterval(30, TimeUnit.SECONDS)
                .build()
    }
}
