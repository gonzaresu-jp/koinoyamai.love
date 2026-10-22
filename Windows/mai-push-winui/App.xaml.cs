using Microsoft.UI.Xaml;
using Microsoft.Windows.AppNotifications;

namespace MaiPushWinUI;

public partial class App : Application
{
    private static Mutex? _mutex;
    private MainWindow? _window;

    // 通知クリックの処理が完了したことを知らせる（起動直後に表示，判断するため）
    private readonly TaskCompletionSource<bool> _notificationHandled =
        new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

    public App()
    {
        // WebView2 ユーザーデータをローカル AppData に固定
        // Q: など UNC/ネットワークドライブ起動時でも EnsureCoreWebView2Async が失敗しなくなる
        System.Environment.SetEnvironmentVariable(
            "WEBVIEW2_USER_DATA_FOLDER",
            System.IO.Path.Combine(
                System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                "MaiPush", "WebView2"));

        // シングルインスタンスガード（Electron の app.requestSingleInstanceLock() 相当）
        _mutex = new Mutex(true, "MaiPushWinUI_v2_Instance", out bool createdNew);
        if (!createdNew)
        {
            // 既に起動中 → そのまま終了（既存プロセスはトレイに残っている）
            _mutex.Dispose();
            Environment.Exit(0);
        }

        InitializeComponent();
        Diagnostics.LogStartup();
        Diagnostics.RegisterRestartOnCrash();
        Diagnostics.RegisterWerDumpDirectory();

        // ---- グローバル例外ログ（0xc000027b 対策の観測用）----
        UnhandledException += (_, e) =>
        {
            Diagnostics.Log("Application.UnhandledException", e.Exception);
            e.Handled = true; // クラッシュで即死しない（トレイ常駐を優先）
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Diagnostics.Log("AppDomain.UnhandledException", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Diagnostics.Log("UnobservedTaskException", e.Exception);
            e.SetObserved();
        };

        try
        {
            AppNotificationManager.Default.NotificationInvoked += OnNotificationInvoked;
            AppNotificationManager.Default.Register();
        }
        catch
        {
            // アンパッケージアプリで AUMID 未設定の場合は非致命的
        }
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();

        // --hidden 引数があればトレイに格納したまま起動（自動起動時など）
        if (Environment.GetCommandLineArgs().Contains("--hidden"))
        {
            _window.HideToTray();
            return;
        }

        // 通知クリックで起動された場合（アプリが停止していたとき）は、
        // ブラウザを開くだけでアプリのウィンドウは前面に出さない。
        if (IsNotificationLaunch())
        {
            _ = ActivateAfterNotificationAsync();
            return;
        }

        // 通常の起動は即座に表示する（従来どおり）
        _window.Activate();
    }

    /// <summary>
    /// 通知クリックで起動されたか（AppNotification による起動）を判定する。
    /// 判定できない場合は通常の起動として扱う。
    /// </summary>
    private static bool IsNotificationLaunch()
    {
        try
        {
            var activated = Microsoft.Windows.AppLifecycle.AppInstance.GetCurrent().GetActivatedEventArgs();
            return activated.Kind ==
                   Microsoft.Windows.AppLifecycle.ExtendedActivationKind.AppNotification;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 通知の到着を待ってから、必要ならウィンドウを前面に出す。
    /// ブラウザで内容を開いた場合は、アプリは前面に出さない（フォーカスを奪わない）。
    /// </summary>
    private async Task ActivateAfterNotificationAsync()
    {
        bool openedExternally = false;
        try
        {
            // 通知が届かないケース（不正な起動など）で永久に待たないよう上限を設ける
            openedExternally = await _notificationHandled.Task.WaitAsync(TimeSpan.FromSeconds(3));
        }
        catch
        {
            openedExternally = false;
        }

        if (openedExternally) return;   // ブラウザで開いた → アプリは出さない

        var win = _window;
        if (win is null) return;
        win.DispatcherQueue.TryEnqueue(() =>
        {
            try { win.Activate(); }
            catch { }
        });
    }

    private void OnNotificationInvoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args)
    {
        // 通知本体 / 「ダウンロード」ボタン → URL を既定ブラウザで開く
        // （URL が無い通知は従来どおり「アプリを前面に出す」）
        bool openedExternally = false;
        if (args.Arguments.TryGetValue("url", out var url) &&
            Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
            (uri.Scheme == "http" || uri.Scheme == "https"))
        {
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.ToString())
                {
                    UseShellExecute = true
                });
                openedExternally = true;
            }
            catch
            {
                // 開けなかった場合はフォールバック（アプリを前面に出す）
                openedExternally = false;
            }
        }

        // 起動直後の判定（ActivateAfterNotificationAsync）にも渡す
        _notificationHandled.TrySetResult(openedExternally);

        // ブラウザを開いた場合はアプリを前面に出さない（ブラウザのフォーカスを奪わない）
        if (openedExternally) return;

        _window?.DispatcherQueue.TryEnqueue(() => _window?.BringToFront());
    }

    public static MainWindow? CurrentWindow => ((App)Current)._window;
}
