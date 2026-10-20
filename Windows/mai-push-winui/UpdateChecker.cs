using System.Text.Json;

namespace MaiPushWinUI;

internal static class UpdateChecker
{
    private const string FeedUrl = "https://koinoyamai.love/dl/desktop.json";
    private static readonly Version CurrentVersion = new(1, 8, 5);

    public static async Task CheckAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            var json = await http.GetStringAsync(FeedUrl);
            using var doc = JsonDocument.Parse(json);

            if (!doc.RootElement.TryGetProperty("version", out var verEl)) return;
            if (!Version.TryParse(verEl.GetString(), out var latest)) return;
            if (latest <= CurrentVersion) return;

            var url = doc.RootElement.TryGetProperty("url", out var urlEl)
                ? urlEl.GetString() : FeedUrl;
            var notes = doc.RootElement.TryGetProperty("notes", out var notesEl)
                ? notesEl.GetString() ?? "" : "";

            // アップデート通知（クリックでブラウザ開く）
            var builder = new Microsoft.Windows.AppNotifications.Builder.AppNotificationBuilder()
                .AddText($"まいちゃん通知 v{latest} が利用可能")
                .AddText(notes)
                .AddButton(new Microsoft.Windows.AppNotifications.Builder.AppNotificationButton("ダウンロード")
                    .AddArgument("url", url ?? ""));

            Microsoft.Windows.AppNotifications.AppNotificationManager.Default
                .Show(builder.BuildNotification());
        }
        catch
        {
            // 更新チェック失敗は無視
        }
    }
}
