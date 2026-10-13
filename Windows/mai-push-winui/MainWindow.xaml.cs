using H.NotifyIcon;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Windows.AppNotifications;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Windows.Graphics;
using Windows.UI;

namespace MaiPushWinUI;

public sealed partial class MainWindow : Window
{
    private const string AppUrl = "https://koinoyamai.love";

    private const string ChromeUA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    private readonly AppWindow _appWindow;
    private TaskbarIcon? _trayIcon;

    private readonly Dictionary<TabViewItem, WebView2> _tabWebViews = new();
    private readonly Dictionary<TabViewItem, long> _tabCallbackTokens = new();

    // SSE 通知の重複排除（複数タブで同一イベントが届くため最後に処理したIDを保持）
    private int _lastNotifId = 0;

    private static readonly SolidColorBrush TabActive   = new(Color.FromArgb(0xFF, 0xFD, 0x2A, 0xB1));
    private static readonly SolidColorBrush TabInactive = new(Color.FromArgb(0xFF, 0x7D, 0x14, 0x57));

    public MainWindow()
    {
        InitializeComponent();

        _appWindow = this.GetAppWindow();
        _appWindow.Resize(new SizeInt32(960, 580));
        _appWindow.Title = "まいちゃん通知";
        if (File.Exists("Assets\\app-icon.ico"))
            _appWindow.SetIcon("Assets\\app-icon.ico");

        ExtendsContentIntoTitleBar = true;
        StyleCaptionButtons();
        _appWindow.Changed += (_, _) => UpdateCaptionPadding();

        _appWindow.Closing += (_, e) =>
        {
            e.Cancel = true;
            HideToTray();
        };

        SetupTrayIcon();
        InstallWndProcSubclass();
        _ = Task.Delay(3000).ContinueWith(_ => UpdateChecker.CheckAsync());
    }

    // ---- タイトルバー ----

    private void StyleCaptionButtons()
    {
        if (_appWindow.TitleBar is not { } tb) return;
        tb.ButtonBackgroundColor = Colors.Transparent;
        tb.ButtonInactiveBackgroundColor = Colors.Transparent;
        tb.ButtonHoverBackgroundColor = Color.FromArgb(0x26, 0xFF, 0xFF, 0xFF);
        tb.ButtonPressedBackgroundColor = Color.FromArgb(0x4D, 0xFF, 0xFF, 0xFF);
        tb.ButtonForegroundColor = Colors.White;
        tb.ButtonInactiveForegroundColor = Color.FromArgb(0x80, 0xFF, 0xFF, 0xFF);
        tb.ButtonHoverForegroundColor = Colors.White;
        tb.ButtonPressedForegroundColor = Colors.White;
    }

    private void UpdateCaptionPadding()
    {
        var inset = _appWindow.TitleBar?.RightInset ?? 138;
        DispatcherQueue.TryEnqueue(() => CaptionPadding.Width = inset);
    }

    // ---- Win32 WndProc（カーソル + 上辺リサイズボーダー排除）----
    // タイトルバー域では WM_SETCURSOR を WinUI が上書きできないため Win32 で制御する。
    // HTTOP/HTTOPLEFT/HTTOPRIGHT を HTCLIENT に変換してリサイズグリップをタブ域から排除。

    private const int WM_NCHITTEST  = 0x0084;
    private const int WM_SETCURSOR  = 0x0020;
    private const int WM_SYSCOMMAND = 0x0112;
    private const int SC_MINIMIZE   = 0xF020;
    private const int HTCLIENT      = 1;
    private const int HTCAPTION     = 2;
    private const int HTTOP         = 12;
    private const int HTTOPLEFT     = 13;
    private const int HTTOPRIGHT    = 14;
    private static readonly IntPtr IDC_HAND = (IntPtr)32649; // OCR_HAND

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    private WndProcDelegate? _wndProcKeepAlive;
    private IntPtr _prevWndProc;
    private IntPtr _hwnd;

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    [DllImport("user32.dll", EntryPoint = "CallWindowProcW")]
    private static extern IntPtr CallWindowProc(IntPtr lpPrevWndFunc, IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "LoadCursorW")]
    private static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr lpCursorName);
    [DllImport("user32.dll")]
    private static extern IntPtr SetCursor(IntPtr hCursor);
    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT pt);
    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr hWnd, ref POINT pt);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool AppendMenuW(IntPtr hMenu, uint uFlags, IntPtr uIDNewItem, string? lpNewItem);
    [DllImport("user32.dll")]
    private static extern int TrackPopupMenuEx(IntPtr hmenu, uint fuFlags, int x, int y, IntPtr hwnd, IntPtr lptpm);
    [DllImport("user32.dll")]
    private static extern bool DestroyMenu(IntPtr hMenu);

    private const uint MF_STRING = 0x00000000;
    private const uint MF_SEPARATOR = 0x00000800;
    private const uint MF_CHECKED = 0x00000008;
    private const uint TPM_RIGHTBUTTON = 0x00000002;
    private const uint TPM_NONOTIFY = 0x00000080;
    private const uint TPM_RETURNCMD = 0x00000100;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }

    private void InstallWndProcSubclass()
    {
        _hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        _wndProcKeepAlive = WndProc;
        _prevWndProc = SetWindowLongPtr(_hwnd, -4,
            Marshal.GetFunctionPointerForDelegate(_wndProcKeepAlive));
    }

    private IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_SYSCOMMAND && (wParam.ToInt32() & 0xFFF0) == SC_MINIMIZE)
        {
            // 最小化ボタン → タスクバーに残さずトレイへ格納
            DispatcherQueue.TryEnqueue(HideToTray);
            return IntPtr.Zero;
        }
        if (msg == WM_NCHITTEST)
        {
            var result = CallWindowProc(_prevWndProc, hWnd, msg, wParam, lParam).ToInt32();
            // 上辺リサイズゾーンだけをクライアントエリアに変換する。
            // タブ/空白の HTCAPTION 判定は SetTitleBar + InputNonClientPointerSource に委ねる。
            if (result is HTTOP or HTTOPLEFT or HTTOPRIGHT)
                return (IntPtr)HTCLIENT;
            return (IntPtr)result;
        }
        if (msg == WM_SETCURSOR && IsPointerInTabStrip() && IsPointerOverInteractiveElement())
        {
            SetCursor(LoadCursor(IntPtr.Zero, IDC_HAND));
            return (IntPtr)1;
        }
        return CallWindowProc(_prevWndProc, hWnd, msg, wParam, lParam);
    }

    private bool IsPointerInTabStrip()
    {
        if (!GetCursorPos(out var pt)) return false;
        ScreenToClient(_hwnd, ref pt);
        double dpi = GetDpiForWindow(_hwnd) / 96.0;
        return pt.Y >= 0 && pt.Y < (int)(40 * dpi);
    }

    // タブアイテムまたはボタンの上にいるときのみ true（空白ストリップ背景では false）
    // FindElementsInHostCoordinates は座標系が不安定なため TransformToVisual で代替
    private bool IsPointerOverInteractiveElement()
    {
        if (Tabs is not { IsLoaded: true }) return false;
        if (!GetCursorPos(out var pt)) return false;
        ScreenToClient(_hwnd, ref pt);
        double dpi = GetDpiForWindow(_hwnd) / 96.0;
        var logicalPt = new Windows.Foundation.Point(pt.X / dpi, pt.Y / dpi);
        try
        {
            // 各 TabViewItem の視覚コンテナ（TabContainer Grid）のバウンドで判定
            // tab.ActualWidth は ListView の内部コンテナ幅（ストリップ全幅）になる場合があるため
            // TabContainer を使う。取得できなければ tab 自身で MaxWidth キャップを掛けて代替
            foreach (var obj in Tabs.TabItems)
            {
                if (obj is not TabViewItem tab || !tab.IsLoaded) continue;
                var container = FindChild<Grid>(tab, "TabContainer");
                FrameworkElement visual = container is not null ? (FrameworkElement)container : tab;
                double w = visual == tab
                    ? Math.Min(tab.ActualWidth, tab.MaxWidth)
                    : visual.ActualWidth;
                var xform = visual.TransformToVisual(null);
                var bounds = xform.TransformBounds(
                    new Windows.Foundation.Rect(0, 0, w, visual.ActualHeight));
                if (bounds.Contains(logicalPt)) return true;
            }
            // 左ヘッダー: スペーサー 8px + リロードボタン 40px = 48px
            if (logicalPt.X < 48) return true;
            // 追加 (+) ボタン（TabView テンプレート内 "AddButton"）
            var addBtn = FindChild<Button>(Tabs, "AddButton");
            if (addBtn?.IsLoaded == true)
            {
                var xform = addBtn.TransformToVisual(null);
                var bounds = xform.TransformBounds(
                    new Windows.Foundation.Rect(0, 0, addBtn.ActualWidth, addBtn.ActualHeight));
                if (bounds.Contains(logicalPt)) return true;
            }
        }
        catch { return false; }
        return false;
    }


    // ---- Tabs.Loaded ----

    private void Tabs_Loaded(object sender, RoutedEventArgs e)
    {
        SetTitleBar(Tabs);
        UpdateCaptionPadding();
        AddNewTab(AppUrl);
    }

    // ---- V2: タブごとの WebView2 初期化 ----

    private async Task InitWebViewAsync(TabViewItem tab, WebView2 wv, string url)
    {
        try { await wv.EnsureCoreWebView2Async(); }
        catch (Exception ex)
        {
            var msg = $"ERR:0x{(uint)ex.HResult:X8} {ex.Message}";
            DispatcherQueue.TryEnqueue(() => SetTabTitle(tab, msg));
            return;
        }

        var core = wv.CoreWebView2;
        core.Settings.UserAgent = ChromeUA;
        core.Settings.AreDevToolsEnabled = true;  // F12 でDevTools起動

        // Notification.requestPermission() を自動許可
        core.PermissionRequested += (_, e2) =>
        {
            if (e2.PermissionKind == CoreWebView2PermissionKind.Notifications)
                e2.State = CoreWebView2PermissionState.Allow;
        };

        // requestPermission() が denied を返すと new Notification() が黙殺されるため、
        // ナビゲーションごとに通知権限を明示的に許可しておく
        void AllowNotifications()
        {
            try
            {
                if (Uri.TryCreate(core.Source, UriKind.Absolute, out var u) &&
                    !string.IsNullOrEmpty(u.Host))
                    _ = core.Profile.SetPermissionStateAsync(CoreWebView2PermissionKind.Notifications,
                        u.GetLeftPart(UriPartial.Authority), CoreWebView2PermissionState.Allow);
            }
            catch { }
        }
        core.NavigationCompleted += (_, _) => AllowNotifications();
        core.SourceChanged += (_, _) => AllowNotifications();

        await core.AddScriptToExecuteOnDocumentCreatedAsync("""
            document.addEventListener('DOMContentLoaded', () => {
                const s = document.createElement('style');
                s.textContent = '::-webkit-scrollbar { display: none; width: 0; height: 0 }';
                document.head.appendChild(s);
            });
            """);

        await core.AddScriptToExecuteOnDocumentCreatedAsync(PushOverrideScript);

        // テスト通知はサーバー送信に頼らずローカルで Notification を出す
        // （旧 Electron 版 preload.js と同等。webview2:// 偽 endpoint はサーバーから到達不能のため）
        await core.AddScriptToExecuteOnDocumentCreatedAsync(SendTestInterceptScript);

        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            "Object.defineProperty(window,'__WEBVIEW2_HOST__',{value:true,writable:false});");

        await core.AddScriptToExecuteOnDocumentCreatedAsync(SseNotifyBridgeScript);

        core.NotificationReceived += (_, e2) =>
        {
            e2.Handled = true;
            var n = e2.Notification;
            var img = string.IsNullOrEmpty(n.BodyImageUri) ? n.IconUri : n.BodyImageUri;
            DispatcherQueue.TryEnqueue(() => NotificationHelper.ShowToast(n.Title, n.Body, img));
        };

        core.DocumentTitleChanged += (_, _) =>
        {
            DispatcherQueue.TryEnqueue(() =>
                SetTabTitle(tab, string.IsNullOrEmpty(core.DocumentTitle)
                    ? "新しいタブ" : core.DocumentTitle));
        };

        core.FaviconChanged += (_, _) =>
        {
            if (Uri.TryCreate(core.FaviconUri, UriKind.Absolute, out var uri))
                DispatcherQueue.TryEnqueue(() =>
                    tab.IconSource = new BitmapIconSource { UriSource = uri, ShowAsMonochrome = false });
        };

        core.NewWindowRequested += (_, e2) =>
        {
            e2.Handled = true;
            DispatcherQueue.TryEnqueue(() => AddNewTab(e2.Uri));
        };

        await core.AddScriptToExecuteOnDocumentCreatedAsync("""
            document.addEventListener('keydown', e => {
                if (!e.ctrlKey) return;
                if (e.key === 't') { e.preventDefault(); window.chrome.webview.postMessage('shortcut:new-tab'); }
                if (e.key === 'w') { e.preventDefault(); window.chrome.webview.postMessage('shortcut:close-tab'); }
            }, true);
            """);

        core.WebMessageReceived += (_, e2) =>
        {
            var msg = e2.TryGetWebMessageAsString();
            switch (msg)
            {
                case "shortcut:new-tab":
                    DispatcherQueue.TryEnqueue(() => AddNewTab(AppUrl));
                    break;
                case "shortcut:close-tab":
                    DispatcherQueue.TryEnqueue(() =>
                    {
                        if (Tabs.SelectedItem is TabViewItem t) CloseTab(t);
                    });
                    break;
                default:
                    if (msg?.StartsWith("{") == true) HandleWebMessage(msg);
                    break;
            }
        };

        core.Navigate(url);
    }

    // ---- タブ管理 ----

    private void AddNewTab(string url)
    {
        var headerText = new TextBlock
        {
            Text = "新しいタブ",
            TextTrimming = TextTrimming.CharacterEllipsis,
            MaxWidth = 140,  // アイコン・閉じるボタン分を除いた本文幅
        };
        var tab = new TabViewItem
        {
            Header = headerText,
            IconSource = new FontIconSource { Glyph = "" },
            IsClosable = true,
            MaxWidth = 200,
            MinWidth = 80,
        };

        tab.Loaded += (_, _) =>
        {
            // VSM が TabContainer.Background を上書きするたびに即座に打ち消す
            var container = FindChild<Grid>(tab, "TabContainer");
            if (container is not null)
            {
                bool setting = false;
                long token = container.RegisterPropertyChangedCallback(Panel.BackgroundProperty, (s, _) =>
                {
                    if (setting || s is not Panel p) return;
                    bool isActive = ReferenceEquals(tab, Tabs.SelectedItem);
                    var expected = isActive ? TabActive : TabInactive;
                    if (ReferenceEquals(p.Background, expected)) return;
                    setting = true;
                    try { p.Background = expected; }
                    finally { setting = false; }
                });
                // CloseTab でコールバックを解除するためトークンを保存
                _tabCallbackTokens[tab] = token;
            }
            DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, UpdateTabColors);
        };

        var wv = new WebView2();
        wv.Loaded += async (s, e) => await InitWebViewAsync(tab, wv, url);
        _tabWebViews[tab] = wv;
        ContentGrid.Children.Add(wv);

        Tabs.TabItems.Add(tab);
        Tabs.SelectedItem = tab;
    }

    private void UpdateTabColors()
    {
        foreach (var item in Tabs.TabItems.OfType<TabViewItem>())
        {
            bool active = ReferenceEquals(item, Tabs.SelectedItem);
            var brush = active ? TabActive : TabInactive;
            var grid = FindChild<Grid>(item, "TabContainer");
            if (grid is not null) { grid.Background = brush; continue; }
            item.Background = brush;
        }
    }

    private static void SetTabTitle(TabViewItem tab, string title)
    {
        if (tab.Header is TextBlock tb) tb.Text = title;
        else tab.Header = title;
    }

    private static T? FindChild<T>(DependencyObject parent, string? name = null) where T : FrameworkElement
    {
        int n = VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < n; i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T fe && (name is null || fe.Name == name)) return fe;
            var found = FindChild<T>(child, name);
            if (found is not null) return found;
        }
        return null;
    }

    private void CloseTab(TabViewItem tab)
    {
        // RegisterPropertyChangedCallback のトークンを解除してメモリリークを防ぐ
        if (_tabCallbackTokens.TryGetValue(tab, out var token))
        {
            var container = FindChild<Grid>(tab, "TabContainer");
            container?.UnregisterPropertyChangedCallback(Panel.BackgroundProperty, token);
            _tabCallbackTokens.Remove(tab);
        }
        if (_tabWebViews.TryGetValue(tab, out var wv))
        {
            ContentGrid.Children.Remove(wv);
            _tabWebViews.Remove(tab);
        }
        Tabs.TabItems.Remove(tab);
        if (Tabs.TabItems.Count == 0)
            AddNewTab(AppUrl);
    }

    private void ReloadActive()
    {
        if (Tabs.SelectedItem is TabViewItem t && _tabWebViews.TryGetValue(t, out var wv))
            try { wv.CoreWebView2?.Reload(); } catch { }
    }

    // ---- TabView イベント ----

    private void Tabs_AddTabButtonClick(TabView sender, object args) => AddNewTab(AppUrl);

    private void Tabs_TabCloseRequested(TabView sender, TabViewTabCloseRequestedEventArgs args) =>
        CloseTab(args.Tab);

    private void Tabs_TabDroppedOutside(TabView sender, TabViewTabDroppedOutsideEventArgs args)
    {
        // タブをウィンドウ外にドラッグしても切り離さない（元の位置に戻す）
        // 何もしなければ TabView がタブを Tabs.TabItems から削除しようとするので防ぐ
        if (!Tabs.TabItems.Contains(args.Tab))
            Tabs.TabItems.Add(args.Tab);
    }

    private void Tabs_SelectionChanged(object sender, SelectionChangedEventArgs args)
    {
        foreach (var (_, webView) in _tabWebViews)
            webView.Visibility = Visibility.Collapsed;

        if (Tabs.SelectedItem is TabViewItem tab && _tabWebViews.TryGetValue(tab, out var active))
            active.Visibility = Visibility.Visible;

        DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, UpdateTabColors);
    }

    private void Tabs_KeyDown(object sender, Microsoft.UI.Xaml.Input.KeyRoutedEventArgs e)
    {
        var ctrl = Microsoft.UI.Input.InputKeyboardSource
            .GetKeyStateForCurrentThread(Windows.System.VirtualKey.Control)
            .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        if (!ctrl) return;

        switch (e.Key)
        {
            case Windows.System.VirtualKey.T:          // Ctrl+T: 新しいタブ
                AddNewTab(AppUrl);
                e.Handled = true;
                break;
            case Windows.System.VirtualKey.W:          // Ctrl+W: 現在のタブを閉じる
                if (Tabs.SelectedItem is TabViewItem t)
                    CloseTab(t);
                e.Handled = true;
                break;
            case Windows.System.VirtualKey.R:          // Ctrl+R: 再読み込み
                ReloadActive();
                e.Handled = true;
                break;
        }
    }

    private void ReloadButton_Click(object sender, RoutedEventArgs e) => ReloadActive();

    // ---- PushManager 偽装 ----

    private const string PushOverrideScript = """
        (function () {
            // WebView2 は Push API 非対応で window.PushManager が無い。ガード通過用のダミー。
            if (!('PushManager' in window)) {
                try {
                    Object.defineProperty(window, 'PushManager', {
                        value: function PushManager() {}, configurable: true, writable: true
                    });
                } catch (e) {}
            }
            // WebView2 の Notification.permission は既定 denied のため、
            // 'granted' を返すように差し替える（トーストは PermissionRequested ハンドラ経由で表示される）。
            try {
                Object.defineProperty(Notification, 'permission', {
                    get: function () { return 'granted'; }, configurable: true
                });
                console.log('[WV2] Notification.permission => granted (overridden)');
            } catch (e) {}
            const KEY = '__wv2_push_sub__';
            class _FakePushMgr {
                async subscribe(opts) {
                    const cached = localStorage.getItem(KEY);
                    if (cached) return Object.assign(JSON.parse(cached), {
                        unsubscribe: async () => { localStorage.removeItem(KEY); return true; }
                    });
                    const fake = {
                        endpoint: 'webview2://push/' + Date.now(),
                        expirationTime: null,
                        keys: { p256dh: '', auth: '' },
                        toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: this.keys }; },
                        unsubscribe: async () => { localStorage.removeItem(KEY); return true; },
                    };
                    localStorage.setItem(KEY, JSON.stringify(fake.toJSON()));
                    return fake;
                }
                async getSubscription() {
                    const s = localStorage.getItem(KEY);
                    if (!s) return null;
                    return Object.assign(JSON.parse(s), {
                        unsubscribe: async () => { localStorage.removeItem(KEY); return true; }
                    });
                }
                async permissionState(opts) { return 'granted'; }
            }
            function installFake(reg) {
                const mgr = new _FakePushMgr();
                let proto = false, inst = false;
                // ready が毎回異なる JS ラッパーを返す環境でも効くようプロトタイプ優先で貼る
                try { Object.defineProperty(Object.getPrototypeOf(reg), 'pushManager', { get: () => mgr, configurable: true }); proto = true; } catch (e) {}
                try { Object.defineProperty(reg, 'pushManager', { get: () => mgr, configurable: true }); inst = true; } catch (e) {}
                console.log('[WV2] fake pushManager installed proto=' + proto + ' inst=' + inst);
            }
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.ready.then(installFake).catch(() => {});
                navigator.serviceWorker.getRegistration().then(r => { if (r) installFake(r); }).catch(() => {});
            }
        })();
        """;

    private const string SendTestInterceptScript = """
        (function () {
            const origFetch = window.fetch.bind(window);
            window.fetch = function (input, init) {
                let url = '';
                try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
                const method = ((init && init.method) || (input && input.method) || 'GET') + '';
                if (url.indexOf('/api/send-test') !== -1 && method.toUpperCase() === 'POST') {
                    const show = () => {
                        try {
                            new Notification('テスト通知', {
                                body: 'ここをクリックしてURL飛べるか確認！',
                                icon: '/icon.webp'
                            });
                        } catch (e) {}
                    };
                    try {
                        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') show();
                        else if (typeof Notification !== 'undefined' && Notification.requestPermission)
                            Notification.requestPermission().then(p => { if (p === 'granted') show(); }).catch(() => {});
                        else show();
                    } catch (e) {}
                    return Promise.resolve(new Response(
                        JSON.stringify({ success: true, sent: true, local: true }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }
                return origFetch(input, init);
            };
        })();
        """;

    // ---- SSE プッシュ通知ブリッジ ----

    // web-push の fake endpoint 問題を回避するため、SSE 経由でサーバー側の通知履歴を
    // リアルタイム受信し、Windows トーストに変換する。
    private const string SseNotifyBridgeScript = """
        (function () {
            if (typeof window.chrome?.webview?.postMessage !== 'function') return;
            if (window.location.hostname !== 'koinoyamai.love') return;
            let lastId = 0;
            let es = null;
            let retryMs = 5000;
            function connect() {
                try {
                    es = new EventSource('/api/events/stream');
                    es.onopen = function () { retryMs = 5000; };
                    es.onmessage = async function (e) {
                        try {
                            const d = JSON.parse(e.data);
                            if (d.type !== 'history-updated') return;
                            const r = await fetch('/api/history?limit=1');
                            const json = await r.json();
                            const notif = json.logs?.[0];
                            if (!notif || notif.id <= lastId) return;
                            lastId = notif.id;
                            window.chrome.webview.postMessage(JSON.stringify({
                                type: 'push-notification',
                                id: notif.id,
                                title: notif.title || '',
                                body: notif.body || '',
                                icon: notif.icon || '',
                                url: notif.url || ''
                            }));
                        } catch (_) {}
                    };
                    es.onerror = function () {
                        try { es.close(); } catch (_) {}
                        es = null;
                        setTimeout(connect, retryMs);
                        retryMs = Math.min(retryMs * 2, 60000);
                    };
                } catch (_) {
                    setTimeout(connect, retryMs);
                }
            }
            window.addEventListener('beforeunload', function () { try { es?.close(); } catch (_) {} });
            connect();
        })();
        """;

    private void HandleWebMessage(string json)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var typeProp) ||
                typeProp.GetString() != "push-notification") return;

            var id = root.TryGetProperty("id", out var idProp) ? idProp.GetInt32() : 0;
            if (id > 0 && id <= _lastNotifId) return;  // 複数タブからの重複を破棄
            if (id > 0) _lastNotifId = id;

            var title = root.TryGetProperty("title", out var t) ? t.GetString() ?? "" : "";
            var body  = root.TryGetProperty("body",  out var b) ? b.GetString() ?? "" : "";
            var icon  = root.TryGetProperty("icon",  out var i) ? i.GetString() ?? "" : "";

            DispatcherQueue.TryEnqueue(() => NotificationHelper.ShowToast(title, body, icon));
        }
        catch { }
    }

    // ---- Windows 自動起動（レジストリ）----

    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "MaiPush";

    private static bool IsAutoStartEnabled()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(RunValueName) is not null;
        }
        catch { return false; }
    }

    private static void SetAutoStart(bool enable)
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
            if (key is null) return;
            if (enable)
            {
                // 実行ファイルのパスに --hidden を付けて登録（起動時はトレイに格納）
                var exe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule!.FileName;
                key.SetValue(RunValueName, $"\"{exe}\" --hidden");
            }
            else
            {
                key.DeleteValue(RunValueName, throwOnMissingValue: false);
            }
        }
        catch { }
    }

    // ---- システムトレイ ----

    private void SetupTrayIcon()
    {
        try
        {
            _trayIcon = new TaskbarIcon { ToolTipText = "まいちゃん通知" };
            var ico = Path.GetFullPath("Assets\\tray-icon.ico");
            if (File.Exists(ico))
                // 16x16 を明示指定してトレイ表示の透明化バグを回避
                _trayIcon.Icon = new System.Drawing.Icon(ico, 16, 16);
            _trayIcon.DoubleClickCommand = new SimpleCommand(BringToFront);

            // WinUI の MenuFlyout は H.NotifyIcon が表示すると MenuFlyoutItem.Click が
            // 発火しないことがある（DoubleClickCommand は ICommand なので正常）ため、
            // 右クリックメニューは Win32 の TrackPopupMenu で表示する。
            _trayIcon.RightClickCommand = new SimpleCommand(ShowTrayMenu);
            _trayIcon.ForceCreate(enablesEfficiencyMode: false);

            // 動作確認用: MAIPUSH_TEST_MENU=1 で起動すると3秒後にメニューを自動表示
            if (Environment.GetEnvironmentVariable("MAIPUSH_TEST_MENU") == "1")
                _ = Task.Run(async () =>
                {
                    await Task.Delay(3000);
                    DispatcherQueue.TryEnqueue(ShowTrayMenu);
                });
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[Tray] {ex.Message}");
        }
    }

    private void ShowTrayMenu()
    {
        try
        {
            GetCursorPos(out var cpt);
            IntPtr menu = CreatePopupMenu();
            AppendMenuW(menu, MF_STRING, (IntPtr)1, "開く");
            AppendMenuW(menu, MF_STRING, (IntPtr)2, "再読み込み");
            AppendMenuW(menu, MF_STRING, (IntPtr)3, "新しいタブ");
            AppendMenuW(menu, MF_SEPARATOR, IntPtr.Zero, null!);
            AppendMenuW(menu, MF_STRING | (IsAutoStartEnabled() ? MF_CHECKED : 0u), (IntPtr)4, "Windows 起動時に自動起動");
            AppendMenuW(menu, MF_SEPARATOR, IntPtr.Zero, null!);
            AppendMenuW(menu, MF_STRING, (IntPtr)5, "終了");
            uint cmd = (uint)TrackPopupMenuEx(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                cpt.X, cpt.Y, _hwnd, IntPtr.Zero);
            DestroyMenu(menu);
            switch (cmd)
            {
                case 1: BringToFront(); break;
                case 2: ReloadActive(); break;
                case 3: BringToFront(); AddNewTab(AppUrl); break;
                case 4: SetAutoStart(!IsAutoStartEnabled()); break;
                case 5: ExitApp(); break;
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[TrayMenu] {ex.Message}");
        }
    }

    public void BringToFront()
    {
        // HideToTray で隠したウィンドウを Show してから最前面に
        _appWindow.Show();
        _appWindow.MoveInZOrderAtTop();
        // 念のため Minimized 状態（通常は SC_MINIMIZE 横取りで起きない）も復元
        if (_appWindow.Presenter is OverlappedPresenter p &&
            p.State == OverlappedPresenterState.Minimized)
            p.Restore();
    }

    public void HideToTray() => _appWindow.Hide();

    private void ExitApp()
    {
        // WinUI3 では UI スレッドからの Environment.Exit / Dispose 経由の終了が
        // デッドロックして止まることがあるため、メッセージループを経由せず強制終了する。
        // トレイアイコンはプロセス終了時に OS が自動で消す。
        try { Process.GetCurrentProcess().Kill(); }
        catch { Environment.Exit(0); }
    }
}

// タブストリップ全体（タブ・追加ボタン含む）に手カーソルを設定
// DefaultStyleKey を明示しないとサブクラス用テンプレートが存在せずタブが空白になる
public sealed class HandTabView : TabView
{
    public HandTabView() => DefaultStyleKey = typeof(TabView);
}

internal sealed class SimpleCommand(Action execute) : System.Windows.Input.ICommand
{
    public event EventHandler? CanExecuteChanged { add { } remove { } }
    public bool CanExecute(object? p) => true;
    public void Execute(object? p) => execute();
}

internal static class WindowExtensions
{
    public static AppWindow GetAppWindow(this Window window)
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
        var wndId = Win32Interop.GetWindowIdFromWindow(hwnd);
        return AppWindow.GetFromWindowId(wndId);
    }
}
