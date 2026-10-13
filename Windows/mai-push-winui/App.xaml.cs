using Microsoft.UI.Xaml;
using Microsoft.Windows.AppNotifications;

namespace MaiPushWinUI;

public partial class App : Application
{
    private static Mutex? _mutex;
    private MainWindow? _window;

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
            _window.HideToTray();
        else
            _window.Activate();
    }

    private void OnNotificationInvoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args)
    {
        // 「ダウンロード」ボタン → URL を既定ブラウザで開く
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
            }
            catch { }
        }

        _window?.DispatcherQueue.TryEnqueue(() => _window?.BringToFront());
    }

    public static MainWindow? CurrentWindow => ((App)Current)._window;
}
