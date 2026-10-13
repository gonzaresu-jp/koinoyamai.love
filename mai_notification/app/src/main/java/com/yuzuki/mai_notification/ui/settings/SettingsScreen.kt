package com.yuzuki.mai_notification.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.yuzuki.mai_notification.data.ApiClient
import com.yuzuki.mai_notification.data.OshiUpdateRequest
import com.yuzuki.mai_notification.data.model.NOTIFICATION_SETTING_LABELS
import com.yuzuki.mai_notification.data.model.NotificationSettings
import com.yuzuki.mai_notification.data.model.UserProfile
import com.yuzuki.mai_notification.ui.home.BoxLoading
import com.yuzuki.mai_notification.ui.home.formatSchedule
import com.yuzuki.mai_notification.ui.schedule.NeedLoginView
import kotlinx.coroutines.launch
import retrofit2.HttpException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 設定（Phase 2）:
 * - アカウント情報（/api/user/me）
 * - 推し始めた日の設定（PUT /api/user/oshi・DatePicker）
 * - 通知設定のトグル（GET/PUT /api/user/notification-settings）
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onOpenLogin: () -> Unit) {
    val uriHandler = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    var profile by remember { mutableStateOf<UserProfile?>(null) }
    var notifSettings by remember { mutableStateOf<NotificationSettings?>(null) }
    var needLogin by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var saving by remember { mutableStateOf(false) }
    var showOshiPicker by remember { mutableStateOf(false) }
    var oshiSaveError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(reload) {
        profile = null
        notifSettings = null
        error = null
        needLogin = false
        val meResult = runCatching { ApiClient.service.me() }
        meResult.onSuccess { profile = it }
        meResult.onFailure { e ->
            if (e is HttpException && e.code() == 401) needLogin = true
            else error = e.message ?: e.javaClass.simpleName
        }
        // 通知設定（401 ならログイン済み判定で拾済み）
        if (!needLogin && meResult.isSuccess) {
            runCatching { ApiClient.service.notificationSettings() }
                .onSuccess { notifSettings = it }
                .onFailure { /* 通知設定が取れなくても画面は継続 */ }
        }
    }

    fun toggleSetting(key: String, value: Boolean) {
        if (saving) return
        saving = true
        scope.launch {
            runCatching {
                ApiClient.service.updateNotificationSettings(mapOf(key to value))
            }.onSuccess { resp ->
                resp.settings?.let { notifSettings = it }
                // ローカルでも即反映（サーバーレスポンスが無い場合のフォールバック）
                notifSettings = notifSettings?.let { cur ->
                    when (key) {
                        "twitcasting" -> cur.copy(twitcasting = value)
                        "youtube" -> cur.copy(youtube = value)
                        "youtubeCommunity" -> cur.copy(youtubeCommunity = value)
                        "fanbox" -> cur.copy(fanbox = value)
                        "twitterMain" -> cur.copy(twitterMain = value)
                        "twitterSub" -> cur.copy(twitterSub = value)
                        "milestone" -> cur.copy(milestone = value)
                        "schedule" -> cur.copy(schedule = value)
                        "gipt" -> cur.copy(gipt = value)
                        "twitch" -> cur.copy(twitch = value)
                        "bilibili" -> cur.copy(bilibili = value)
                        else -> cur
                    }
                }
            }.onFailure { e ->
                error = e.message ?: e.javaClass.simpleName
            }
            saving = false
        }
    }

    if (showOshiPicker) {
        OshiDatePickerDialog(
            currentDate = profile?.oshiSince,
            onDismiss = { showOshiPicker = false },
            onConfirm = { dateStr ->
                showOshiPicker = false
                saving = true
                scope.launch {
                    runCatching {
                        ApiClient.service.updateOshi(OshiUpdateRequest(dateStr))
                    }.onSuccess { resp ->
                        profile = profile?.copy(
                            oshiSince = resp.oshiSince,
                            oshiDays = resp.days
                        )
                        oshiSaveError = null
                    }.onFailure { e ->
                        oshiSaveError = e.message ?: e.javaClass.simpleName
                    }
                    saving = false
                }
            }
        )
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("設定") }) }
    ) { padding ->
        val mod = Modifier.padding(padding)
        when {
            needLogin -> NeedLoginView(mod, onOpenLogin)
            profile == null && error == null -> BoxLoading(mod)
            error != null && notifSettings == null -> BoxMessageSimple(error!!, mod)
            else -> Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                // アカウント情報
                Card(Modifier.fillMaxWidth(), elevation = CardDefaults.cardElevation(1.dp)) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Default.AccountCircle,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary
                        )
                        Spacer(Modifier.width(14.dp))
                        Column {
                            Text(
                                profile!!.name ?: profile!!.email ?: "（未設定）",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold
                            )
                            profile!!.email?.let {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }

                // 推し始めた日
                Card(Modifier.fillMaxWidth(), elevation = CardDefaults.cardElevation(1.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("推し始めた日", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            TextButton(onClick = { showOshiPicker = true }) {
                                Text(if (profile!!.oshiSince != null) "変更" else "設定")
                            }
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            when {
                                profile!!.oshiSince != null ->
                                    "${formatSchedule(profile!!.oshiSince, null)}（${profile!!.oshiDays}日目）"
                                else -> "未設定"
                            },
                            style = MaterialTheme.typography.bodyMedium
                        )
                        oshiSaveError?.let {
                            Spacer(Modifier.height(4.dp))
                            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }

                // 通知設定
                Card(Modifier.fillMaxWidth(), elevation = CardDefaults.cardElevation(1.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        Text("通知設定", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "プラットフォームごとに通知のオン／オフを切り替えられます。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(Modifier.height(8.dp))
                        if (notifSettings == null) {
                            CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                        } else {
                            NOTIFICATION_SETTING_LABELS.forEach { (key, label) ->
                                val value = when (key) {
                                    "twitcasting" -> notifSettings!!.twitcasting
                                    "youtube" -> notifSettings!!.youtube
                                    "youtubeCommunity" -> notifSettings!!.youtubeCommunity
                                    "fanbox" -> notifSettings!!.fanbox
                                    "twitterMain" -> notifSettings!!.twitterMain
                                    "twitterSub" -> notifSettings!!.twitterSub
                                    "milestone" -> notifSettings!!.milestone
                                    "schedule" -> notifSettings!!.schedule
                                    "gipt" -> notifSettings!!.gipt
                                    "twitch" -> notifSettings!!.twitch
                                    "bilibili" -> notifSettings!!.bilibili
                                    else -> true
                                }
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable { if (!saving) toggleSetting(key, !value) }
                                        .padding(vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                    Switch(
                                        checked = value,
                                        onCheckedChange = { toggleSetting(key, it) },
                                        enabled = !saving
                                    )
                                }
                            }
                        }
                        if (saving) {
                            Spacer(Modifier.height(8.dp))
                            CircularProgressIndicator(Modifier.size(20.dp).align(Alignment.CenterHorizontally))
                        }
                    }
                }

                // Web設定へのリンク
                Card(Modifier.fillMaxWidth(), elevation = CardDefaults.cardElevation(1.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        Text("その他の設定", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "通知先の登録・追加設定は Web の設定画面から行えます。",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        TextButton(onClick = { uriHandler.openUri("https://koinoyamai.love/") }) {
                            Text("設定画面を開く")
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

/** 推し始めた日をDatePickerで選ぶダイアログ */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OshiDatePickerDialog(
    currentDate: String?,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit
) {
    // 既存の日付をミリ秒に変換（DatePicker は UTC ミリ秒を受け取る）
    val initialMillis = runCatching {
        LocalDate.parse(currentDate?.substring(0, 10) ?: "", DateTimeFormatter.ISO_LOCAL_DATE)
            .atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli()
    }.getOrNull() ?: System.currentTimeMillis()

    val datePickerState = rememberDatePickerState(initialSelectedDateMillis = initialMillis)

    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(onClick = {
                datePickerState.selectedDateMillis?.let { millis ->
                    val date = Instant.ofEpochMilli(millis).atZone(ZoneId.of("UTC")).toLocalDate()
                    onConfirm(date.format(DateTimeFormatter.ISO_LOCAL_DATE))
                }
            }) { Text("OK") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("キャンセル") }
        }
    ) {
        DatePicker(state = datePickerState)
    }
}

@Composable
private fun BoxMessageSimple(text: String, modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Box(
        modifier = modifier.fillMaxSize().padding(24.dp),
        contentAlignment = Alignment.Center
    ) { Text(text) }
}
