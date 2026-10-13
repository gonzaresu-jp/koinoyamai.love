package com.yuzuki.mai_notification.ui.history

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.yuzuki.mai_notification.data.ApiClient
import com.yuzuki.mai_notification.data.SseClient
import com.yuzuki.mai_notification.data.model.HistoryLog
import com.yuzuki.mai_notification.ui.home.BoxLoading
import com.yuzuki.mai_notification.ui.home.BoxMessage
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private const val PAGE_SIZE = 30
private const val SSE_URL = "https://koinoyamai.love/api/events/stream"

/**
 * 通知履歴（/api/history）。
 * 末尾到達で追加取得（hasMore）。SSE で通知追加を受けて自動更新。
 * カードをタップすると url を開く。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen() {
    val uriHandler = LocalUriHandler.current
    var logs by remember { mutableStateOf<List<HistoryLog>>(emptyList()) }
    var hasMore by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var loadedOnce by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    val listState = rememberLazyListState()

    suspend fun load(offset: Int) {
        loading = true
        runCatching { ApiClient.service.history(PAGE_SIZE, offset) }
            .onSuccess { resp ->
                logs = if (offset == 0) resp.logs else logs + resp.logs
                hasMore = resp.hasMore
                error = null
                loadedOnce = true
            }
            .onFailure { e ->
                error = e.message ?: e.javaClass.simpleName
                loadedOnce = true
            }
        loading = false
    }

    LaunchedEffect(Unit) { if (!loadedOnce) load(0) }

    // SSE: 通知追加を受けて先頭ページを再取得（差分ではなく全体リロード）
    LaunchedEffect(reload) {
        if (loadedOnce) load(0)
    }

    DisposableEffect(Unit) {
        val sse = SseClient(
            url = SSE_URL,
            client = SseClient.shared(),
            onEvent = { json ->
                if (json.contains("\"history-updated\"")) {
                    reload++
                }
            }
        )
        sse.start()
        onDispose { sse.stop() }
    }

    // 末尾付近まで来たら次ページを取得
    LaunchedEffect(listState, logs.size, hasMore, loading) {
        val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: return@LaunchedEffect
        if (hasMore && !loading && last >= logs.size - 5) load(logs.size)
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("通知履歴") }) }
    ) { padding ->
        when {
            !loadedOnce && error == null -> BoxLoading(Modifier.padding(padding))
            error != null && logs.isEmpty() -> BoxMessage(error!!, Modifier.padding(padding))
            logs.isEmpty() -> BoxMessage("通知履歴はまだありません", Modifier.padding(padding))
            else -> LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(logs, key = { it.id }) { log ->
                    HistoryCard(log) {
                        log.url?.takeIf { it.startsWith("http") }?.let { uriHandler.openUri(it) }
                    }
                }
                if (loading) {
                    item {
                        androidx.compose.foundation.layout.Box(
                            Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                            contentAlignment = Alignment.Center
                        ) { CircularProgressIndicator(Modifier.size(28.dp)) }
                    }
                }
                if (!hasMore && !loading) {
                    item {
                        Text(
                            "これ以前はありません",
                            Modifier.fillMaxWidth().padding(vertical = 12.dp),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun HistoryCard(log: HistoryLog, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!log.image.isNullOrBlank() || !log.icon.isNullOrBlank()) {
                AsyncImage(
                    model = log.image ?: log.icon,
                    contentDescription = null,
                    modifier = Modifier.size(48.dp)
                )
                Spacer(Modifier.width(12.dp))
            } else {
                Icon(
                    Icons.AutoMirrored.Filled.List,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary
                )
                Spacer(Modifier.width(12.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    log.title ?: "(無題)",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2
                )
                if (!log.body.isNullOrBlank()) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        log.body,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 3
                    )
                }
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(
                        onClick = {},
                        label = { Text(log.platform ?: "不明", style = MaterialTheme.typography.labelSmall) }
                    )
                    Text(
                        formatTimestamp(log.timestamp),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.align(Alignment.CenterVertically)
                    )
                }
            }
        }
    }
}

private fun formatTimestamp(ts: Long): String {
    if (ts <= 0L) return ""
    return SimpleDateFormat("M/d HH:mm", Locale.JAPANESE).format(Date(ts * 1000))
}
