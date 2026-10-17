using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace MaiPushWinUI;

internal static class NotificationHelper
{
    /// <summary>
    /// 画像付き Windows トースト通知を表示する。
    /// imageUrl が null でも本文のみで表示できる。
    /// </summary>
    /// <remarks>
    /// 例外を握りつぶすこと。WinRT コールバック（CoreMessaging / DispatcherQueue 経由）内で
    /// 未処理例外を投げると stowed exception (0xc000027b) としてプロセスごと落ちるため
    /// WER で CoreMessagingXP.dll / combase.dll のフォールトが多発していた（v1.8.2 修正）。
    /// </remarks>
    public static void ShowToast(string title, string body, string? imageUrl = null)
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

            AppNotificationManager.Default.Show(builder.BuildNotification());
        }
        catch (Exception ex)
        {
            // トースト失敗は致命的ではない。ログだけ残す。
            Diagnostics.Log("ShowToast", $"title={title} image={imageUrl} {ex.Message}");
        }
    }
}
