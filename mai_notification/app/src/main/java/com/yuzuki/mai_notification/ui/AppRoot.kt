package com.yuzuki.mai_notification.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.yuzuki.mai_notification.ui.history.HistoryScreen
import com.yuzuki.mai_notification.ui.home.HomeScreen
import com.yuzuki.mai_notification.ui.schedule.ScheduleScreen
import com.yuzuki.mai_notification.ui.settings.SettingsScreen
import com.yuzuki.mai_notification.ui.web.WebViewScreen
import java.net.URLEncoder

private const val HOME_SITE = "https://koinoyamai.love/"
private const val WIKI_URL = "https://koinoyamai.love/wiki"
private const val ARCHIVE_URL = "https://koinoyamai.love/archive"

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val tabs = listOf(
    Tab("home", "ホーム", Icons.Default.Home),
    Tab("history", "履歴", Icons.AutoMirrored.Filled.List),
    Tab("schedule", "予定", Icons.Default.CalendarMonth),
    Tab("wiki", "Wiki", Icons.Default.MenuBook),
    Tab("archive", "アーカイブ", Icons.Default.Movie),
    Tab("settings", "設定", Icons.Default.Settings)
)

/**
 * ネイティブのシェル（Phase 2）。
 * ホーム／履歴／予定／設定は Compose のネイティブ画面、
 * Wiki とアーカイブは WebView 残置面を個別タブとして表示する。
 */
@Composable
fun AppRoot(startRoute: String = "home", startUrl: String? = null) {
    val nav = rememberNavController()
    val backStack by nav.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route

    fun openSite(url: String) {
        nav.navigate("web?url=${URLEncoder.encode(url, "UTF-8")}") {
            popUpTo(nav.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    // WebView 画面（ログイン誘導など）では下部バーを隠す
    val showBottomBar = currentRoute?.startsWith("web") != true

    Scaffold(
        bottomBar = {
            if (showBottomBar) {
                NavigationBar {
                    tabs.forEach { tab ->
                        NavigationBarItem(
                            selected = currentRoute == tab.route,
                            onClick = {
                                nav.navigate(tab.route) {
                                    popUpTo(nav.graph.findStartDestination().id) {
                                        saveState = true
                                    }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = { Icon(tab.icon, contentDescription = tab.label) },
                            label = { Text(tab.label) }
                        )
                    }
                }
            }
        }
    ) { padding ->
        NavHost(
            navController = nav,
            startDestination = startRoute,
            modifier = Modifier.padding(padding)
        ) {
            composable("home") { HomeScreen() }
            composable("history") { HistoryScreen() }
            composable("schedule") {
                ScheduleScreen(onOpenLogin = { openSite(HOME_SITE) })
            }
            composable("wiki") { WebViewScreen(WIKI_URL) }
            composable("archive") { WebViewScreen(ARCHIVE_URL) }
            composable("settings") {
                SettingsScreen(onOpenLogin = { openSite(HOME_SITE) })
            }
            composable(
                route = "web?url={url}",
                arguments = listOf(navArgument("url") { type = NavType.StringType })
            ) { entry ->
                val url = entry.arguments?.getString("url")
                    ?: startUrl ?: HOME_SITE
                WebViewScreen(url)
            }
        }
    }
}
