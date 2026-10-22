using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace MaiPushWinUI;

internal static class NotificationHelper
{
    // トースト失敗のログは連発を制限する（通知が連投されると UI スレッドの
    // 同期ファイル書き込みが連発し、操作がもたくなり log.txt が溢れる / Issue #17）
    private static readonly Diagnostics.ThrottledFault _toastFaultLog = new(5000);

    /// <summary>
    /// 画像付き Windows トースト通知を表示する。
    /// imageUrl が null でも本文のみで表示できる。
    /// </summary>
    /// <remarks>
    /// 例外を握りつぶすこと。WinRT コールバック（CoreMessaging / DispatcherQueue 経由）内で
    /// 未処理例外を投げると stowed exception (0xc000027b) としてプロセスごと落ちるため
    /// WER で CoreMessagingXP.dll / combase.dll のフォールトが多発していた（v1.8.2 修正）。
    /// </remarks>
    /// <param name="url">
    /// 通知の対象 URL。**トーストの launch 属性に載せる**（AddArgument）。
    /// 指定すると、通知本体をクリックしたときに
    /// AppNotificationActivatedEventArgs.Arguments["url"] として届くので、
    /// App 側は「既定ブラウザで URL を開く」処理ができる。
    /// これがないと同じ通知は「アプリを前面に出すだけ」になり、
    /// 中身（YouTube 等）が開かなくて困る（2026-10-22 実測）。
    /// </param>
    public static void ShowToast(string title, string body, string? imageUrl = null, string? url = null)
    {
        try
        {
            var builder = new AppNotificationBuilder()
                .AddText(title)
                .AddText(body);

            if (!string.IsNullOrEmpty(imageUrl) && Uri.TryCreate(imageUrl, UriKind.Absolute, out var imgUri))
            {
                // ヒーロー画像（通知上部に大きく表示）
                builder.SetHeroImage(imgUri);
            }

            // 本体クリックで「既定ブラウザで URL を開く」ための launch 引数。
            // （https/http 以外は無視＝OS に渡さない）
            if (IsHttpUrl(url))
            {
                builder.AddArgument("url", url!);
            }

            AppNotificationManager.Default.Show(builder.BuildNotification());
        }
        catch (Exception ex)
        {
            // トースト失敗は致命的ではない。ログだけ残す。
            _toastFaultLog.Report("ShowToast", $"title={title} image={imageUrl} {ex.Message}");
        }
    }

    /// <summary>http / https の URL だけを受け付ける（OS には他の scheme を渡さない）</summary>
    internal static bool IsHttpUrl(string? url)
    {
        if (string.IsNullOrEmpty(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        return uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps;
    }

    // 通知の URL は **SSE 経路**（MainWindow.HandleWebMessage）が
    // webview メッセージとして運ぶ。CoreWebView2Notification には
    // data/AdditionalInfo が無いので、ここでは URL を組み立てない。
}
