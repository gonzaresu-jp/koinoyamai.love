package com.yuzuki.mai_notification.ui.home

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import com.yuzuki.mai_notification.data.ApiClient
import com.yuzuki.mai_notification.data.SseClient
import com.yuzuki.mai_notification.data.model.EventItem
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

private const val SSE_URL = "https://koinoyamai.love/api/events/stream"

/**
 * ホーム: 直近の配信予定（/api/events?from=now）。
 * SSE（/api/events/stream）で通知追加を受けて自動更新する。
 * 予定カードをタップすると該当ページ（YouTube 等）を開く。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen() {
    val uriHandler = LocalUriHandler.current
    var events by remember { mutableStateOf<List<EventItem>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    suspend fun load() {
        runCatching {
            // 過去の予定を並べないため from=現在時刻 を指定
            ApiClient.service.events(limit = 30, offset = 0, platform = null)
        }.onSuccess { resp ->
            val now = OffsetDateTime.now()
            events = resp.items
                .filter { e ->
                    runCatching {
                        OffsetDateTime.parse(e.startTime?.replace(" ", "T") ?: "")
                            .isAfter(now.minusDays(1))
                    }.getOrDefault(true)
                }
                .sortedBy { it.startTime }
            error = null
        }.onFailure { e ->
            error = e.message ?: e.javaClass.simpleName
        }
    }

    LaunchedEffect(reload) {
        events = null
        error = null
        load()
    }

    // SSE: 通知追加を受けて自動更新
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

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("まいちゃん") },
                actions = {
                    IconButton(onClick = { reload++ }) {
                        Icon(Icons.Default.Refresh, contentDescription = "更新")
                    }
                }
            )
        }
    ) { padding ->
        when {
            events == null && error == null -> BoxLoading(Modifier.padding(padding))
            error != null -> BoxMessage(error!!, Modifier.padding(padding))
            events!!.isEmpty() -> BoxMessage("今後の予定はありません", Modifier.padding(padding))
            else -> LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(events!!) { ev ->
                    EventCard(ev) {
                        ev.url?.takeIf { it.startsWith("http") }?.let { uriHandler.openUri(it) }
                    }
                }
            }
        }
    }
}

@Composable
private fun EventCard(ev: EventItem, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                Icons.Default.Event,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    ev.title ?: "(無題)",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    formatSchedule(ev.startTime, ev.timePeriod),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                ev.platform?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        it,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
            }
        }
    }
}

/** "2026-10-10T23:00:00" → "10/10(金) 23:00" */
internal fun formatSchedule(startTime: String?, timePeriod: String?): String {
    if (startTime.isNullOrBlank()) return timePeriod ?: ""
    val dt = runCatching {
        LocalDateTime.parse(startTime.replace(" ", "T"))
    }.getOrElse {
        runCatching { OffsetDateTime.parse(startTime.replace(" ", "T")) }.getOrNull()
            ?.toLocalDateTime() ?: return startTime
    }
    val date = dt.format(DateTimeFormatter.ofPattern("M/d(E)"))
    val time = dt.format(DateTimeFormatter.ofPattern("HH:mm"))
    return "$date $time"
}

@Composable
internal fun BoxLoading(modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        CircularProgressIndicator()
    }
}

@Composable
internal fun BoxMessage(text: String, modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Box(
        modifier = modifier.fillMaxSize().padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(text, style = MaterialTheme.typography.bodyLarge)
    }
}
