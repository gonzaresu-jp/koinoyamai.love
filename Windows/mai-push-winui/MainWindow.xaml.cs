using H.NotifyIcon;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
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

    // タブストリップ寸法（ドラッグゾーン 40px + タブ 40px = 合計 80px）
    // hidden: Y=-80、shown: Y=0
    private const int TabStripTotal    = 70;
    private const int TabStripDragZone = 30;

    // タブドラッグ中は HTCAPTION を抑制する
    private bool _tabStripPointerPressed = false;
    // AppWindow.Changed の例外ログは 5 秒に 1 回へ制限する（連発でログが溢れる・UI が詰まる）
    private readonly Diagnostics.ThrottledFault _appWindowFaultLog = new(5000);
    // タブストリップの各タイマー（アニメーション 16ms 周期・折りたたみ）の例外ログも連発制限する
    private readonly Diagnostics.ThrottledFault _tabStripAnimFaultLog = new(5000);
    private readonly Diagnostics.ThrottledFault _tabStripCollapseFaultLog = new(5000);
    private readonly Diagnostics.ThrottledFault _tabStripCollapseStartFaultLog = new(5000);
    // AddButton 右端の物理ピクセル X（Chrome 方式: これより右がウィンドウドラッグ領域）
    private int _tabAreaRight = 0;
    // フローティングドラッグゴースト用
    private double _dragGrabOffsetX;
    private readonly TranslateTransform _dragGhostTransform = new();
    // タブストリップの表示状態とスライドアニメーション用
    private bool _tabStripVisible = false;
    private readonly TranslateTransform _tabStripTransform = new() { Y = -TabStripTotal };
    // ストリップ折りたたみ予約が既に掛かっているか（ホバーポーリングの連打で
    // 400ms のタイマーが延長され続けて折りたたまれない不具合の防止, Issue #14）
    private bool _collapsePending = false;
    private DispatcherQueueTimer? _collapseTimer;
    private DispatcherQueueTimer? _animTimer;
    private double _animFromY, _animToY;
    private long _animStartMs;
    private const double AnimDurationMs = 180;

    private static readonly SolidColorBrush TabActive   = new(Color.FromArgb(0xFF, 0xFD, 0x2A, 0xB1));
    private static readonly SolidColorBrush TabInactive = new(Color.FromArgb(0xFF, 0x7D, 0x14, 0x57));

    public MainWindow()
    {
        InitializeComponent();

        _appWindow = this.GetAppWindow();
        _appWindow.Resize(new SizeInt32(960, 580));
        _appWindow.Title = "まいちゃん通知";
        // パスは必ず絶対で解決する。
        // 自動起動（Run キー）時は CWD が C:\Windows\System32 になるため
        // 相対パス "Assets\\app-icon.ico" は File.Exists が false になり SetIcon されない。
        var exeDir = AppContext.BaseDirectory;
        var appIconPath = Path.Combine(exeDir, "Assets", "app-icon.ico");
        if (File.Exists(appIconPath))
            _appWindow.SetIcon(appIconPath);

        ExtendsContentIntoTitleBar = true;
        StyleCaptionButtons();
        // AppWindow.Changed は UI スレッドのコールバック。例外境界で包む（§10 / Issue #10 と同じ方針）
        // 最小化/復帰や監視構成変更で連発しうるのでログは 5 秒に 1 回へ制限する（Issue #17）
        _appWindow.Changed += (_, _) =>
        {
            try { UpdateCaptionPadding(); }
            catch (Exception ex) { _appWindowFaultLog.Report("AppWindow.Changed", ex); }
        };
        DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, UpdateDragRects);

        _appWindow.Closing += (_, e) =>
        {
            e.Cancel = true;
            HideToTray();
        };

        SetupTrayIcon();
        InstallWndProcSubclass();
        // フォーカス復帰時にポインター捕捉の取りこぼしを回復する（タッチパッドスクロールの飲み込み対策）
        this.Activated += (_, _) =>
        {
            if (_tabStripPointerPressed && (GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0)
                ClearDragState();
        };
        TabStripContainer.RenderTransform = _tabStripTransform;
        DragGhost.RenderTransform = _dragGhostTransform;
        StartHoverPoller();
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
        // 最小化/復帰の瞬間 TitleBar.RightInset が NaN / Infinity になることがある。
        // 不正値を FrameworkElement.Width に代入すると ArgumentException
        // （"Value does not fall within the expected range"）となり UI スレッドで
        // 例外が投げて処理が中断される（Issue #14）。
        if (double.IsNaN(inset) || double.IsInfinity(inset) || inset < 0 || inset > 10000)
            inset = 138;
        EnqueueUi("CaptionPadding", () =>
        {
            CaptionPadding.Width = inset;
            UpdateDragRects();
        });
    }

    // SetDragRectangles で Y=0-40px をドラッグ領域として明示登録
    // WM_NCHITTEST に加えて InputNonClientPointerSource レベルでも確定させる
    private void UpdateDragRects()
    {
        if (_appWindow.TitleBar is not { } tb) return;
        uint rawDpi = GetDpiForWindow(_hwnd);
        double dpi = rawDpi > 0 ? rawDpi / 96.0 : 1.0;
        var size = _appWindow.ClientSize;
        int dragH = (int)(TabStripDragZone * dpi);
        int dragW = size.Width - tb.RightInset;
        if (dragW > 0 && dragH > 0)
            tb.SetDragRectangles([new RectInt32(0, 0, dragW, dragH)]);
    }

    // ---- Win32 WndProc（カーソル + 上辺リサイズボーダー排除）----
    // タイトルバー域では WM_SETCURSOR を WinUI が上書きできないため Win32 で制御する。
    // HTTOP/HTTOPLEFT/HTTOPRIGHT を HTCLIENT に変換してリサイズグリップをタブ域から排除。

    private const int WM_NCHITTEST   = 0x0084;
    private const int WM_SETCURSOR   = 0x0020;
    private const int WM_SYSCOMMAND  = 0x0112;
    private const int WM_NCMOUSEMOVE = 0x00A0;
    private const int SC_MINIMIZE    = 0xF020;
    private const int HTCLIENT       = 1;
    private const int HTCAPTION      = 2;
    private const int HTMINBUTTON    = 8;
    private const int HTMAXBUTTON    = 9;
    private const int HTTOP          = 12;
    private const int HTTOPLEFT      = 13;
    private const int HTTOPRIGHT     = 14;
    private const int HTCLOSE        = 20;
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
    private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
    private const int VK_LBUTTON = 0x01;
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
        // ネイティブ → マネージドのコールバック境界から例外を出さない。
        // WndProc から例外が抜けるとプロセスが落ちる（Issue #10 の stowed exception と同系統）。
        try
        {
            return WndProcCore(hWnd, msg, wParam, lParam);
        }
        catch (Exception ex)
        {
            // WM_NCHITTEST / WM_SETCURSOR はマウス移動中に毎秒100回以上来る。
            // ここで毎回同期ログを書くと UI スレッドが詰まるので、記録は 5 秒に1回へ制限する。
            LogWndProcFault(ex);
            try { return CallWindowProc(_prevWndProc, hWnd, msg, wParam, lParam); }
            catch
            {
                // HTCLIENT(=1) を返しておく（0 は HTNOWHERE で入力が効かなくなる）
                return msg == WM_NCHITTEST ? (IntPtr)HTCLIENT : IntPtr.Zero;
            }
        }
    }

    // WndProc の例外ログは 5 秒に 1 回へ制限する（メッセージポンプの詰まり防止）
    private readonly Diagnostics.ThrottledFault _wndProcFaultLog = new(5000);

    /// <summary>WndProc の例外ログを 5 秒に1回へ制限する（メッセージポンプの詰まり防止）</summary>
    private void LogWndProcFault(Exception ex) => _wndProcFaultLog.Report("WndProc", ex);

    // UI コールバックの例外ログもソースごとに連発を制限する（Issue #17 / task 1）。
    // 例外境界に入れた箇所は繰り返し失敗しうるため、同期ファイル書き込みが連発すると
    // UI スレッドが詰まり、log.txt も溢れる（AppWindow.Changed は最小化/復帰・監視変更で連発）。
    private readonly Dictionary<string, Diagnostics.ThrottledFault> _uiFaultLogs = new();

    /// <summary>ソースごとの連発抑制ロガーを返す（UI スレッドからのみ使う想定）</summary>
    private Diagnostics.ThrottledFault UiFaultLog(string source)
    {
        if (!_uiFaultLogs.TryGetValue(source, out var log))
        {
            log = new Diagnostics.ThrottledFault();
            _uiFaultLogs[source] = log;
        }
        return log;
    }

    /// <summary>UI スレッドへ投げる処理を例外境界で包む（DispatcherQueue のコールバックで落とさない）</summary>
    private void EnqueueUi(string source, Action action)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            try { action(); }
            catch (Exception ex) { UiFaultLog(source).Report(source, ex); }
        });
    }

    private IntPtr WndProcCore(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_SYSCOMMAND && (wParam.ToInt32() & 0xFFF0) == SC_MINIMIZE)
        {
            // 最小化ボタン → タスクバーに残さずトレイへ格納
            EnqueueUi("WndProc.Minimize", HideToTray);
            return IntPtr.Zero;
        }
        if (msg == WM_NCMOUSEMOVE)
        {
            // キャプションボタン（×・□・─）ではストリップを操作しない
            int ncHit = wParam.ToInt32();
            if (ncHit is HTCLOSE or HTMINBUTTON or HTMAXBUTTON)
            {
                if (_tabStripVisible) EnqueueUi("WndProc.NcMouseMove", StartCollapseTimer);
                goto fallback;
            }
            // lParam は画面座標 → クライアント座標に変換
            short ncx = (short)(lParam.ToInt64() & 0xFFFF);
            short ncy = (short)((lParam.ToInt64() >> 16) & 0xFFFF);
            var ncp = new POINT { X = ncx, Y = ncy };
            if (!ScreenToClient(hWnd, ref ncp)) goto fallback;
            uint rawDpiNc = GetDpiForWindow(_hwnd);
            double dpiNc = rawDpiNc > 0 ? rawDpiNc / 96.0 : 1.0;
            bool inStrip = ncp.Y >= -(int)(10 * dpiNc) && ncp.Y < (int)(TabStripTotal * dpiNc);
            if (inStrip && !_tabStripVisible)
                EnqueueUi("WndProc.NcMouseMove.Show", ShowTabStrip);
            else if (inStrip && _tabStripVisible)
                EnqueueUi("WndProc.NcMouseMove.Cancel", CancelCollapseTimer);
            else if (!inStrip && _tabStripVisible)
                EnqueueUi("WndProc.NcMouseMove.Collapse", StartCollapseTimer);
        }
        if (msg == WM_NCHITTEST)
        {
            var result = CallWindowProc(_prevWndProc, hWnd, msg, wParam, lParam).ToInt32();

            // キャプションボタン（×・□・─）は base 結果を最優先
            if (result is HTCLOSE or HTMINBUTTON or HTMAXBUTTON)
                return (IntPtr)result;

            short sx = (short)(lParam.ToInt64() & 0xFFFF);
            short sy = (short)((lParam.ToInt64() >> 16) & 0xFFFF);
            var cp = new POINT { X = sx, Y = sy };
            // 変換に失敗したら座標は信用できない（screen 座標のまま判定すると HTCAPTION を誤返却する）
            if (!ScreenToClient(hWnd, ref cp)) return (IntPtr)result;
            uint rawDpi = GetDpiForWindow(_hwnd);
            double dpi = rawDpi > 0 ? rawDpi / 96.0 : 1.0;

            // ドラッグゾーン（上 40px）: 常に HTCAPTION（リサイズ含め上書き）
            if (cp.Y >= 0 && cp.Y < (int)(TabStripDragZone * dpi))
                return (IntPtr)HTCAPTION;

            // タブゾーン上辺のリサイズグリップを無効化
            if (result is HTTOP or HTTOPLEFT or HTTOPRIGHT)
                return (IntPtr)HTCLIENT;

            // タブゾーン（40-80px）: 非表示時のみ HTCAPTION、表示時は HTCLIENT でタブに届ける
            if (result == HTCLIENT && cp.Y < (int)(TabStripTotal * dpi))
            {
                if (!_tabStripVisible)
                    return (IntPtr)HTCAPTION;
                // 表示中は _tabAreaRight によるチェックなし（SetDragRectangles が上半分を担当）
            }

            return (IntPtr)result;
        }
        if (msg == WM_SETCURSOR && _tabStripVisible)
        {
            if (!GetCursorPos(out var cur)) goto fallback;
            if (!ScreenToClient(_hwnd, ref cur)) goto fallback;
            uint rawDpi2 = GetDpiForWindow(_hwnd);
            double dpi2 = rawDpi2 > 0 ? rawDpi2 / 96.0 : 1.0;
            if (cur.Y >= (int)(TabStripDragZone * dpi2) && cur.Y < (int)(TabStripTotal * dpi2) && cur.X <= _tabAreaRight)
            {
                SetCursor(LoadCursor(IntPtr.Zero, IDC_HAND));
                return (IntPtr)1;
            }
        }
        fallback:
        return CallWindowProc(_prevWndProc, hWnd, msg, wParam, lParam);
    }

    // ---- タブストリップ ホバー検出（ポーリング）----

    // ポーリングタイマーはフィールドで保持する（異常時・ウィンドウ破棄時に確実に止めるため）
    private DispatcherQueueTimer? _hoverTimer;
    // 異常停止後に再開しない（80ms 周期で例外が出続けるとログが溢れるため）
    private bool _hoverPollerStopped;

    private void StartHoverPoller()
    {
        _hoverPollerStopped = false;
        _hoverTimer?.Stop();

        var timer = DispatcherQueue.CreateTimer();
        _hoverTimer = timer;
        timer.Interval = TimeSpan.FromMilliseconds(80);
        timer.IsRepeating = true;
        timer.Tick += (_, _) =>
        {
            // Tick は DispatcherQueue のコールバック境界で実行されるため、ここから例外が
            // 抜けると未処理例外＝stowed exception (0xc000027b) になりプロセスごと落ちうる。
            // 例外は必ずハンドラ内で止め、原因調査用の状態をログに残してポーリングを停止する（Issue #10）。
            try
            {
                OnHoverTick();
            }
            catch (Exception ex)
            {
                StopHoverPoller("hover-tick", ex);
            }
        };
        // 起動直後にカーソルがウィンドウ上部にいてもストリップが出ないよう遅延起動
        _ = Task.Delay(600).ContinueWith(_ => DispatcherQueue.TryEnqueue(() =>
        {
            try
            {
                if (_hoverPollerStopped || !IsWindowAlive()) return;
                timer.Start();
            }
            catch (Exception ex)
            {
                StopHoverPoller("hover-start", ex);
            }
        }));
    }

    /// <summary>ホバーポーリング 1 フレーム分。ウィンドウが無効/非表示ならストリップを閉じたままにする。</summary>
    private void OnHoverTick()
    {
        if (!IsWindowAlive())
        {
            // ウィンドウ破棄後もタイマーが走り続けるケース → 参照せずに停止する
            StopHoverPoller("hwnd-invalid", null);
            return;
        }
        // タッチパッドスクロールが飲み込まれる原因のフェイルセーフ:
        // OnTabItemDragPressed で立てた _tabStripPointerPressed が PointerReleased /
        // PointerCaptureLost の取りこぼしで立ちっぱなしになると、Tabs のポインター捕捉が
        // 解除されず、以後のポインター（スクロール）イベントが WebView2 に届かなくなる。
        // 左ボタンが既に離されているのにフラグが立っている場合は自動回復する。
        if (_tabStripPointerPressed && (GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0)
        {
            ClearDragState();
        }
        if (!IsWindowVisible(_hwnd) || IsIconic(_hwnd))
        {
            // トレイ格納中・最小化中はストリップを出さない／残さない
            // （最小化でも IsWindowVisible は true になるため IsIconic も見る）
            ResetTabStripHidden();
            return;
        }

        if (!GetCursorPos(out var pt)) return;
        if (!ScreenToClient(_hwnd, ref pt)) return;
        uint rawDpiP = GetDpiForWindow(_hwnd);
        double dpi = rawDpiP > 0 ? rawDpiP / 96.0 : 1.0;
        int triggerTop    = -(int)(10 * dpi); // 上端より 10px 上まで検知
        int triggerBottom =  (int)( 5 * dpi); // 上端から 5px 以内のみ表示トリガー（ドラッグゾーンでは出ない）
        int stayBottom    =  (int)(TabStripTotal * dpi); // 表示中はストリップ全体で維持

        bool inTrigger = pt.Y >= triggerTop && pt.Y < triggerBottom;
        bool inStrip   = pt.Y >= triggerTop && pt.Y < stayBottom;

        if (inTrigger && !_tabStripVisible) ShowTabStrip();
        else if (!inStrip && _tabStripVisible) StartCollapseTimer();
        else if (inStrip && _tabStripVisible) CancelCollapseTimer();
    }

    private bool IsWindowAlive() => _hwnd != IntPtr.Zero && IsWindow(_hwnd);

    /// <summary>ストリップをアニメーションなしで閉じた状態に戻す（非表示・最小化中のみ使用）</summary>
    private void ResetTabStripHidden()
    {
        // 非表示になる直前にタブをドラッグしていた場合、PointerCaptureLost が届かず
        // _tabStripPointerPressed が立ったままになり、以後 StartCollapseTimer が効かなくなる。
        // ここでドラッグ状態を畳んでおく（ウィンドウは実際に隠れているので安全）。
        if (_dragTab != null || _isDragging || _tabStripPointerPressed)
            ClearDragState();
        if (_tabStripVisible || Math.Abs(_tabStripTransform.Y + TabStripTotal) > 0.01)
        {
            _animTimer?.Stop();
            _tabStripVisible = false;
            _tabStripTransform.Y = -TabStripTotal;
        }
        // 停止は最後に行う（ClearDragState 内のキャプチャ解放が EndTabDrag 経由で
        // 折りたたみタイマーを起動しうるため）
        _collapsePending = false;
        _collapseTimer?.Stop();
    }

    /// <summary>ポーリングを停止し、例外時は型・スタック・ウィンドウ状態をログに残す</summary>
    private void StopHoverPoller(string reason, Exception? ex)
    {
        try
        {
            _hoverPollerStopped = true;
            _hoverTimer?.Stop();
            _hoverTimer = null;
            var state = DescribeWindowState();
            if (ex is null) Diagnostics.Log("HoverPoller", $"stopped({reason}) {state}");
            else Diagnostics.Log("HoverPoller", $"stopped({reason}) {state}{Environment.NewLine}{ex}");
        }
        catch { }
    }

    /// <summary>例外発生時のウィンドウ/カーソル状態（再現条件の特定用, Issue #10）</summary>
    private string DescribeWindowState()
    {
        try
        {
            bool alive = IsWindowAlive();
            bool visible = alive && IsWindowVisible(_hwnd);
            bool minimized = alive && IsIconic(_hwnd);
            uint rawDpi = alive ? GetDpiForWindow(_hwnd) : 0;
            double dpi = rawDpi > 0 ? rawDpi / 96.0 : 1.0;
            var cursor = "unavailable";
            if (GetCursorPos(out var cp))
            {
                cursor = $"{cp.X},{cp.Y}(screen)";
                var local = new POINT { X = cp.X, Y = cp.Y };
                if (alive && ScreenToClient(_hwnd, ref local))
                    cursor += $"/{local.X},{local.Y}(client)";
            }
            return $"hwnd=0x{_hwnd.ToInt64():X} alive={alive} visible={visible} minimized={minimized} " +
                   $"dpi={rawDpi}({dpi:0.##}x) stripVisible={_tabStripVisible} " +
                   $"stripY={_tabStripTransform.Y:0.#} pointerPressed={_tabStripPointerPressed} cursor={cursor}";
        }
        catch (Exception ex)
        {
            return $"(state unavailable: {ex.GetType().Name})";
        }
    }

    // ---- タブストリップ スライドイン/アウト ----

    private void AnimateTabStrip(double toY)
    {
        _animTimer?.Stop();
        _animFromY = _tabStripTransform.Y;
        _animToY = toY;
        _animStartMs = Environment.TickCount64;

        if (_animTimer == null)
        {
            _animTimer = DispatcherQueue.CreateTimer();
            _animTimer.Interval = TimeSpan.FromMilliseconds(16);
            _animTimer.IsRepeating = true;
            _animTimer.Tick += (_, _) =>
            {
                // DispatcherQueue のコールバック境界で例外を出さない（Issue #10 と同系統）
                try
                {
                    double t = (double)(Environment.TickCount64 - _animStartMs) / AnimDurationMs;
                    if (t >= 1.0)
                    {
                        _tabStripTransform.Y = _animToY;
                        _animTimer?.Stop();
                        return;
                    }
                    // ease-out cubic: 速く出てゆっくり止まる
                    double eased = 1.0 - Math.Pow(1.0 - t, 3.0);
                    _tabStripTransform.Y = _animFromY + (_animToY - _animFromY) * eased;
                }
                catch (Exception ex)
                {
                    _animTimer?.Stop();
                    try { _tabStripTransform.Y = _animToY; } catch { }
                    _tabStripAnimFaultLog.Report("TabStripAnim", ex);
                }
            };
        }
        _animTimer.Start();
    }

    private void ShowTabStrip()
    {
        _collapsePending = false;
        _collapseTimer?.Stop();
        if (_tabStripVisible) return;
        _tabStripVisible = true;
        AnimateTabStrip(0);
    }

    private void CollapseTabStrip()
    {
        if (!_tabStripVisible) return;
        _tabStripVisible = false;
        AnimateTabStrip(-TabStripTotal);
    }

    /// <summary>
    /// ストリップを折りたたむ予約（400ms 後）。
    ///
    /// 注意: ホバーポーリング（80ms 周期）と WndProc(WM_NCMOUSEMOVE) から
    /// **毎ティック** 呼び出されるため、毎回タイマーを作り直すと
    /// 「待ち中」を 400ms 以上維持できず、折りたたみが永久に発生しない状態になっていた
    /// （Issue #14 / タブバーが出たままで問題）。
    /// よって「既に待ち中なら延長しない」よう _collapsePending で管理する。
    /// </summary>
    private void StartCollapseTimer()
    {
        if (_tabStripPointerPressed) return;
        if (_collapsePending) return; // 既に予約済み（延長しない）
        try
        {
            _collapsePending = true;
            _collapseTimer?.Stop();
            _collapseTimer = DispatcherQueue.CreateTimer();
            _collapseTimer.Interval = TimeSpan.FromMilliseconds(400);
            _collapseTimer.IsRepeating = false;
            _collapseTimer.Tick += (_, _) =>
            {
                _collapsePending = false;
                // ドラッグ中は畳まない（.EndTabDrag が終了後に再予約する）
                if (_tabStripPointerPressed) return;
                try { CollapseTabStrip(); }
                catch (Exception ex) { _tabStripCollapseFaultLog.Report("TabStripCollapse", ex); }
            };
            _collapseTimer.Start();
        }
        catch (Exception ex)
        {
            // 予約に失敗した場合、フラグを戻さないと以後折りたたまれない
            _collapsePending = false;
            _tabStripCollapseStartFaultLog.Report("TabStripCollapse.Start", ex);
        }
    }

    private void CancelCollapseTimer()
    {
        _collapsePending = false;
        _collapseTimer?.Stop();
    }

    // AddButton 右端を物理ピクセルでキャッシュ（タブ追加・削除・選択変更後に呼ぶ）
    private void UpdateTabAreaRight()
    {
        DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () =>
        {
            try
            {
                var addBtn = FindChild<Button>(Tabs, "AddButton");
                if (addBtn?.IsLoaded != true) return;
                double x = 0;
                DependencyObject? cur = addBtn;
                while (cur != null && !ReferenceEquals(cur, Tabs))
                {
                    if (cur is UIElement ui) x += ui.ActualOffset.X;
                    cur = VisualTreeHelper.GetParent(cur);
                }
                x += addBtn.ActualWidth;
                double dpi = GetDpiForWindow(_hwnd) / 96.0;
                _tabAreaRight = (int)(x * dpi);
            }
            catch { }
        });
    }


    // ---- Tabs.Loaded ----

    private void Tabs_Loaded(object sender, RoutedEventArgs e)
    {
        UpdateCaptionPadding();
        // handledEventsToo: true — 子要素が Handled にしても受け取る
        Tabs.AddHandler(UIElement.PointerMovedEvent,
            new PointerEventHandler(OnTabDragMoved), handledEventsToo: true);
        Tabs.AddHandler(UIElement.PointerReleasedEvent,
            new PointerEventHandler(OnTabDragReleased), handledEventsToo: true);
        Tabs.AddHandler(UIElement.PointerCaptureLostEvent,
            new PointerEventHandler((_, _) => EndTabDrag()), handledEventsToo: true);
        // ポインターがキャンセルされた場合もドラッグ状態を畳む（捕捉の取りこぼし対策）
        Tabs.AddHandler(UIElement.PointerCanceledEvent,
            new PointerEventHandler((_, _) => EndTabDrag()), handledEventsToo: true);
        Tabs.PointerEntered += (_, _) => CancelCollapseTimer();
        Tabs.PointerExited += (_, _) =>
        {
            if (_tabStripPointerPressed) return;
            // カーソルが strip の Y 範囲を出た時のみ折りたたむ（右空白への移動は除外）
            if (GetCursorPos(out var pt))
            {
                ScreenToClient(_hwnd, ref pt);
                double dpi = GetDpiForWindow(_hwnd) / 96.0;
                if (pt.Y < (int)(TabStripTotal * dpi)) return; // まだストリップ内
            }
            StartCollapseTimer();
        };
        AddNewTab(AppUrl);
        UpdateTabAreaRight();
    }

    // ---- タブ並び替え（カスタムドラッグ）----

    private TabViewItem? _dragTab;
    private double _dragOriginX;
    private bool _isDragging;
    private const double DragThreshold = 6.0;

    // タブ自身に貼り付けたハンドラ — 「どのタブか」を推測する必要がない
    private void OnTabItemDragPressed(object sender, PointerRoutedEventArgs e)
    {
        if (sender is not TabViewItem tvi) return;
        var pt = e.GetCurrentPoint(Tabs);
        if (!pt.Properties.IsLeftButtonPressed) return;
        _dragTab = tvi;
        _dragOriginX = pt.Position.X;
        // タブ内のどこを掴んだか（ゴースト位置合わせ用）
        _dragGrabOffsetX = e.GetCurrentPoint(tvi).Position.X;
        _isDragging = false;
        _tabStripPointerPressed = true;
        // キャプチャはドラッグ閾値超過後に行う（ここで CapturePointer すると
        // 次のタブクリックが Tabs に吸われてタブ切り替えが効かなくなる）
    }

    private void OnTabDragMoved(object sender, PointerRoutedEventArgs e)
    {
        if (_dragTab is null) return;
        double x = e.GetCurrentPoint(Tabs).Position.X;
        if (!_isDragging && Math.Abs(x - _dragOriginX) < DragThreshold) return;
        if (!_isDragging)
        {
            _isDragging = true;
            // ゴーストを初期化してオリジナルを非表示
            DragGhostText.Text = (_dragTab.Header as TextBlock)?.Text ?? "";
            DragGhost.Width = Math.Max(60, _dragTab.ActualWidth);
            DragGhost.Height = _dragTab.ActualHeight;
            _dragGhostTransform.Y = TabStripDragZone - 4; // タブ行より 4px 浮かせる
            DragGhost.Visibility = Visibility.Visible;
            _dragTab.Opacity = 0; // オリジナルを透明化（位置プレースホルダーとして残す）
            Tabs.CapturePointer(e.Pointer);
        }

        // ゴーストをカーソルに追従させる
        if (GetCursorPos(out var cur))
        {
            ScreenToClient(_hwnd, ref cur);
            uint rawDpi = GetDpiForWindow(_hwnd);
            double dpi = rawDpi > 0 ? rawDpi / 96.0 : 1.0;
            _dragGhostTransform.X = cur.X / dpi - _dragGrabOffsetX;
        }

        // カーソル位置が最も近いタブ位置と異なれば並び替え
        int fromIdx = Tabs.TabItems.IndexOf(_dragTab);
        if (fromIdx < 0) { EndTabDrag(); return; }
        int toIdx = FindClosestTabIndex(x);
        if (toIdx < 0 || toIdx == fromIdx) return;

        Tabs.TabItems.RemoveAt(fromIdx);
        Tabs.TabItems.Insert(toIdx, _dragTab);
        Tabs.SelectedItem = _dragTab;
    }

    private void OnTabDragReleased(object sender, PointerRoutedEventArgs e) => EndTabDrag();

    private void EndTabDrag()
    {
        ClearDragState();
        // ドラッグ終了後にカーソルが strip 外にあれば折りたたみタイマーを起動
        if (GetCursorPos(out var pt))
        {
            ScreenToClient(_hwnd, ref pt);
            double dpi = GetDpiForWindow(_hwnd) / 96.0;
            if (pt.Y >= (int)(TabStripTotal * dpi)) StartCollapseTimer();
        }
    }

    /// <summary>タブドラッグ状態を畳む（キャプチャ解除・ゴースト非表示・不透明度復元）</summary>
    private void ClearDragState()
    {
        try { Tabs.ReleasePointerCaptures(); } catch { }
        DragGhost.Visibility = Visibility.Collapsed;
        if (_dragTab != null) _dragTab.Opacity = 1.0;
        _dragTab = null;
        _isDragging = false;
        _tabStripPointerPressed = false;
    }

    // TabViewItem の左端 X を Tabs 相対論理座標で返す（ActualOffset 累積）
    private double GetTabLeft(TabViewItem tab)
    {
        double x = 0;
        DependencyObject? cur = tab;
        while (cur != null && !ReferenceEquals(cur, Tabs))
        {
            if (cur is UIElement ui) x += ui.ActualOffset.X;
            cur = VisualTreeHelper.GetParent(cur);
        }
        return x;
    }

    private int FindClosestTabIndex(double x)
    {
        int best = -1;
        double bestDist = double.MaxValue;
        for (int i = 0; i < Tabs.TabItems.Count; i++)
        {
            if (Tabs.TabItems[i] is not TabViewItem tab || !tab.IsLoaded) continue;
            try
            {
                double left = GetTabLeft(tab);
                double w = tab.ActualWidth;
                if (x >= left && x < left + w) return i;
                double d = Math.Abs(x - (left + w / 2));
                if (d < bestDist) { bestDist = d; best = i; }
            }
            catch { }
        }
        return best;
    }

    // ---- 外部リンクのOS委譲（v1.8.1）----
    // 外部リンクをアプリ内タブに閉じ込めないため、自サイト・認証ホスト以外は
    // 既定ブラウザ／登録アプリへ委譲する。

    // ログイン（Google / Discord OAuth）に必要なホスト。ここへの遷移はアプリ内に残す
    private static readonly string[] AuthHosts =
    {
        "accounts.google.com",
        "discord.com",
        "login.discord.com",
    };

    // アプリ内ブラウザで開いてよい自サイトかどうか
    private static bool IsOwnSiteHost(string? host)
    {
        if (string.IsNullOrEmpty(host)) return false;
        var h = host.ToLowerInvariant();
        return h == "koinoyamai.love" || h.EndsWith(".koinoyamai.love");
    }

    private static bool IsAuthHost(string? host)
    {
        if (string.IsNullOrEmpty(host)) return false;
        var h = host.ToLowerInvariant();
        foreach (var a in AuthHosts)
            if (h == a) return true;
        return false;
    }

    /// <summary>
    /// WebView2 内（＝アプリ内）で読み込ませてよい URI かどうか。
    /// 自サイト・認証ホストの http(s) と、data: / about: / blob: / javascript: / file: が該当。
    /// それ以外（外部サイト・tel:・mailto: 等）は OpenExternal へ回す。
    /// </summary>
    private static bool IsInternalUri(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        var scheme = uri.Scheme.ToLowerInvariant();
        if (scheme == "http" || scheme == "https")
            return IsOwnSiteHost(uri.Host) || IsAuthHost(uri.Host);
        return scheme is "data" or "about" or "blob" or "javascript" or "file";
    }

    /// <summary>
    /// 外部リンクを開く。UseShellExecute=true で http(s) は既定ブラウザ、
    /// tel: 等は登録済みアプリへ。開けなかった場合は無視する。
    /// </summary>
    private static void OpenExternal(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[OpenExternal] {url}: {ex.Message}");
        }
    }

    // ---- システムブラウザでの OAuth（Google / Discord）----
    // WebView2 内でのサインインは Google に止められるため、既定ブラウザでログインさせ、
    // セッションは DesktopLogin（ループバック）でアプリへ持ち帰す。詳細は DesktopLogin.cs。

    /// <summary>
    /// OAuth の開始 URL（/auth/google・/auth/discord）なら true。
    /// その場合、既定ブラウザでログインを開始する（アプリ内遷移は止める）。
    /// </summary>
    private bool TryStartDesktopOAuth(string url, WebView2 wv)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || !IsOwnSiteHost(uri.Host)) return false;
        if (uri.AbsolutePath != "/auth/google" && uri.AbsolutePath != "/auth/discord") return false;
        _ = RunDesktopOAuthAsync(uri, wv);
        return true;
    }

    private async Task RunDesktopOAuthAsync(Uri startUri, WebView2 wv)
    {
        try
        {
            var waiter = DesktopLogin.StartWaiter();

            // returnTo をループバックに差し替える（client_id 等の既存クエリは残す）
            var pairs = startUri.Query.TrimStart('?')
                .Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Where(kv => !kv.StartsWith("returnTo=", StringComparison.OrdinalIgnoreCase))
                .ToList();
            pairs.Add("returnTo=" + Uri.EscapeDataString($"http://127.0.0.1:{waiter.Port}/callback"));
            var browserUrl = $"{startUri.Scheme}://{startUri.Host}{startUri.AbsolutePath}?{string.Join("&", pairs)}";

            OpenExternal(browserUrl);

            var code = await waiter.Code;
            if (string.IsNullOrEmpty(code))
            {
                Diagnostics.Log("DesktopLogin", "ブラウザでのログインが完了しませんでした（タイムアウト）");
                FailToast("ログインが完了しませんでした", "ブラウザでログインをやり直してください");
                return;
            }

            var token = await DesktopLogin.ExchangeCodeAsync(code, CancellationToken.None);
            if (string.IsNullOrEmpty(token))
            {
                Diagnostics.Log("DesktopLogin", "token-exchange に失敗しました");
                FailToast("ログインに失敗しました", "もう一度お試しください");
                return;
            }

            var core = wv.CoreWebView2;
            if (core == null)
            {
                // タブが閉じられていた場合。CookieManager はプロファイル共通だが、
                // ここでは参照できないため失敗として扱う（レビュー指摘 M3）。
                FailToast("ログインを反映できませんでした", "タブが閉じられたためです。もう一度お試しください");
                return;
            }

            // Cookie 期限はサーバー側の maxAge（JWT_EXPIRES_IN=30d）に合わせる。
            // ※ CoreWebView2Cookie に 5 引数のコンストラクタは**無い**（2026-10-24 独立レビューで
            //   NuGet 実物のメタデータを照合して確認）。CookieManager.CreateCookie を使う。
            //   Expires は **UNIX エポックからの秒（double）**（DateTime ではない）。
            //   SameSite は既定の Lax のまま（アプリ内は全て同一サイトなので実害なし。
            //   Strict にするには CoreWebView2CookieSameSiteMode が要るが、種名の確証が
            //   取れないためコンパイルリスクを避けて未指定）。
            var cookie = core.CookieManager.CreateCookie("session", token!, "koinoyamai.love", "/");
            cookie.Expires = (DateTime.UtcNow - DateTime.UnixEpoch).TotalSeconds + 30 * 24 * 3600;
            cookie.IsSecure = true;
            cookie.IsHttpOnly = true;
            core.CookieManager.AddOrUpdateCookie(cookie);
            Diagnostics.Log("DesktopLogin", "セッションを注入しました（再読込します）");
            DispatcherQueue.TryEnqueue(() => { try { core.Reload(); } catch { } });
        }
        catch (Exception ex)
        {
            Diagnostics.Log("DesktopLogin", ex);
            FailToast("ログインに失敗しました", "もう一度お試しください");
        }
    }

    /// <summary>ログイン失敗を通知で知らせる（黙って失敗させない）。</summary>
    private void FailToast(string title, string body)
    {
        DispatcherQueue.TryEnqueue(() => NotificationHelper.ShowToast(title, body));
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
        core.NavigationCompleted += (_, _) =>
        {
            AllowNotifications();
            // touchpad precision scroll は WebView2 がフォーカスを持っている前提で
            // 動作する。ナビゲーション完了時にフォーカスを渡しておく。
            DispatcherQueue.TryEnqueue(() => { try { wv.Focus(FocusState.Programmatic); } catch { } });
        };
        core.SourceChanged += (_, _) => AllowNotifications();

        await core.AddScriptToExecuteOnDocumentCreatedAsync("""
            document.addEventListener('DOMContentLoaded', () => {
                const s = document.createElement('style');
                // display:none は Chromium の touchpad precision-scroll gesture の
                // 認識を壊すことがある（スクロールバー要素がレンダーツリーから
                // 除去されるとジェスチャー検出が変わることがある）。
                // width:0 + 標準プロパティで「見えないが存在する」状態にする。
                s.textContent = 'html { scrollbar-width: none; } ::-webkit-scrollbar { width: 0; height: 0; }';
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
            // ここに URL は無い（CoreWebView2Notification には data/AdditionalInfo が無い。
            //  moreover WinUI アプリには実 web push が届かない＝pushManager を webview2:// で
            // 偽装しており、サーバーは非 http エンドポイントを弾く（services/notification.js）。
            // 実際にURLを運ぶのは下の SSE 経路（HandleWebMessage）。
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

        // 別ウィンドウ要求（target="_blank" / window.open）: 内部なら新タブ、
        // 外部なら既定ブラウザ／登録アプリへ。無条件 AddNewTab だと外部がアプリ内に開いていた
        core.NewWindowRequested += (_, e2) =>
        {
            e2.Handled = true;
            if (IsInternalUri(e2.Uri))
                DispatcherQueue.TryEnqueue(() => AddNewTab(e2.Uri));
            else
                DispatcherQueue.TryEnqueue(() => OpenExternal(e2.Uri));
        };

        // 同一タブ遷移: 外部リンクはアプリ内に読み込まず OS に委譲する。
        // NavigationStarting はメインフレームのみが対象（iframe は FrameNavigationStarting）
        // のため、埋め込み表示には影響しない。
        core.NavigationStarting += (_, e2) =>
        {
            // OAuth の開始（自サイト /auth/google・/auth/discord）は**アプリ内では進めない**。
            // Google は「埋め込みブラウザでのサインイン」をポリシーで止めており、
            // WebView2 内では Google のページで止まって戻ってこない
            // （2026-10-24 実測: アプリからの開始 7 回・コールバック 0 回／通常ブラウザでは成功）。
            // → 既定ブラウザでログインさせ、セッションはループバックで持ち帰る（DesktopLogin）。
            if (TryStartDesktopOAuth(e2.Uri, wv)) { e2.Cancel = true; return; }

            if (IsInternalUri(e2.Uri)) return;
            e2.Cancel = true;
            OpenExternal(e2.Uri);
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

        // ドラッグ開始はタブ自身で受け取る（親で「どのタブか」を推測しなくて済む）
        tab.AddHandler(UIElement.PointerPressedEvent,
            new PointerEventHandler(OnTabItemDragPressed), handledEventsToo: true);

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
        UpdateTabAreaRight();
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
        UpdateTabAreaRight();
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
        UpdateTabAreaRight();
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
                            // 履歴の icon/image は相対パスのことがある（テスト通知など）。
                            // トーストのヒーロー画像は絶対URIが必要なのでここで解決する。
                            const abs = (u) => { try { return u ? new URL(u, location.origin).href : ''; } catch (_) { return ''; } };
                            window.chrome.webview.postMessage(JSON.stringify({
                                type: 'push-notification',
                                id: notif.id,
                                title: notif.title || '',
                                body: notif.body || '',
                                icon: abs(notif.icon),
                                image: abs(notif.image),
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
            var image = root.TryGetProperty("image", out var im) ? im.GetString() ?? "" : "";
            // 通知のURL（トーストの launch に載せる。クリックで既定ブラウザで開く）
            var url   = root.TryGetProperty("url",   out var u) ? u.GetString() ?? "" : "";

            // サムネイル（image）をトーストのヒーロー画像に使う。image は絶対URL。
            // icon は相対URL（/icon.webp）で SetHeroImage の要件（絶対URI）を満たさないためフォールバックしない。
            DispatcherQueue.TryEnqueue(() => NotificationHelper.ShowToast(title, body, image, url));
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

    // トレイアイコンのソース。死なないように保持し、定期再送にも使う。
    private System.Drawing.Icon? _trayIconSource;
    private DispatcherQueueTimer? _trayKeepAliveTimer;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);
    private const int SM_CXSMICON = 49; // トレイ小アイコンの物理幅（DPI反映）

    private void SetupTrayIcon()
    {
        try
        {
            _trayIcon = new TaskbarIcon { ToolTipText = "まいちゃん通知" };

            // 絶対パス解決が必須。Run キー（自動起動）では CWD が System32 になるため
            // 相対パスだと Icon が null のまま ForceCreate され、
            // トレイに「透明な空き四角」が出続ける（v1.8.2 の透明アイコン問題の本命）。
            var ico = Path.Combine(AppContext.BaseDirectory, "Assets", "tray-icon.ico");
            if (File.Exists(ico))
                _trayIconSource = TryLoadTrayIcon(ico);

            // ファイルが読めなかった場合の保険: 実行ファイルからアイコンを抽出する。
            // Icon null のまま Shell_NotifyIcon(NIM_ADD) して透明アイコンが残るのを防ぐ。
            if (_trayIconSource is null)
            {
                try
                {
                    var exe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
                    if (exe is not null && File.Exists(exe))
                        _trayIconSource = System.Drawing.Icon.ExtractAssociatedIcon(exe);
                }
                catch (Exception ex) { Diagnostics.Log("TrayIcon.Fallback", ex); }
            }

            if (_trayIconSource is not null)
                _trayIcon.Icon = _trayIconSource;
            else
                Diagnostics.Log("TrayIcon", "アイコンソースを確保できませんでした");

            _trayIcon.DoubleClickCommand = new SimpleCommand(BringToFront);

            // WinUI の MenuFlyout は H.NotifyIcon が表示すると MenuFlyoutItem.Click が
            // 発火しないことがある（DoubleClickCommand は ICommand なので正常）ため、
            // 右クリックメニューは Win32 の TrackPopupMenu で表示する。
            _trayIcon.RightClickCommand = new SimpleCommand(ShowTrayMenu);
            _trayIcon.ForceCreate(enablesEfficiencyMode: false);

            StartTrayKeepAlive();

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
            Diagnostics.Log("TrayIcon", ex);
        }
    }

    /// <summary>
    /// ICO からトレイに適したサイズのアイコンを読み込む。
    /// トレイの小アイコン物理サイズ（SM_CXSMICON・DPI 反映）に最も近いフレームを使う。
    /// </summary>
    private static System.Drawing.Icon? TryLoadTrayIcon(string icoPath)
    {
        try
        {
            var tray = GetSystemMetrics(SM_CXSMICON);
            if (tray > 0 && tray != 16)
            {
                try { return new System.Drawing.Icon(icoPath, new System.Drawing.Size(tray, tray)); }
                catch { }
            }
            return new System.Drawing.Icon(icoPath, 16, 16);
        }
        catch (Exception ex)
        {
            Diagnostics.Log("TrayIcon.Load", ex);
            return null;
        }
    }

    /// <summary>
    /// アイコン定義を 2 分ごとに再送する。
    /// Explorer 再起動直後の TaskbarCreated 取りこぼしや DPI 変更後の
    /// 「透明になったトレイアイコン」を自動修復する（checked: H.NotifyIcon は
    /// IconSource==null のとき OnDpiChanged で再描画しないため）。
    /// </summary>
    private void StartTrayKeepAlive()
    {
        if (_trayIconSource is null) return;
        _trayKeepAliveTimer?.Stop();
        _trayKeepAliveTimer = DispatcherQueue.CreateTimer();
        _trayKeepAliveTimer.Interval = TimeSpan.FromMinutes(2);
        _trayKeepAliveTimer.IsRepeating = true;
        _trayKeepAliveTimer.Tick += (_, _) =>
        {
            try
            {
                if (_trayIcon is { } icon && _trayIconSource is { } src)
                    icon.UpdateIcon(src);
            }
            catch { }
        };
        _trayKeepAliveTimer.Start();
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
        // 先に Dispose（内部で Shell_NotifyIcon(NIM_DELETE)）でトレイを消してから
        // 落とさないと「透明な空きアイコン」が残る。消し込み後、WinUI3 の
        // Environment.Exit / Dispose 経由の終了はデッドロックすることがあるため
        // Process.Kill で確実に落とす。
        try { _trayIcon?.Dispose(); }
        catch { }
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
