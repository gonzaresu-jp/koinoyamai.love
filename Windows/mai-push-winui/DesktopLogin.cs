using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MaiPushWinUI;

/// <summary>
/// システムブラウザで OAuth（Google / Discord）を行い、その結果（セッション）を
/// アプリへ持ち帰るためのループバック受信機とトークン交換。
///
/// なぜ必要か:
///   Google は「埋め込みブラウザ（WebView）でのサインイン」をポリシーで止めている。
///   WebView2 内で /auth/google を進めると、Google のページで止まって戻ってこない
///   （2026-10-24 実測: アプリからの開始 7 回・コールバック 0 回。通常ブラウザでは成功）。
///   UA を Chrome に偽装しても通らない。
///
/// 仕組み:
///   1) 既定ブラウザで /auth/google を開く。ただし returnTo を
///      http://127.0.0.1:&lt;空きポート&gt;/callback に差し替える。
///   2) ブラウザでログインが完了すると、サーバーは **Cookie ではなく単発コード**
///      （60 秒で失効）をその URL に載せて返す（routes/user-auth.js の
///      isAllowedDesktopCallback が loopback の returnTo をそのように扱う）。
///   3) このクラスのループバック受信機がコードを受け取り、
///      POST /auth/token-exchange でセッショントークンに交換する。
///   4) 呼び出し側はそのトークンを WebView2 の Cookie へ注入して再読込する。
///
/// GCP 側の登録変更は**不要**（redirect_uri は常に
/// https://koinoyamai.love/auth/google/callback のまま。loopback は returnTo にしか使わない）。
///
/// ループバックは TcpListener で実装する（HttpListener は非管理者での URL ACL 問題を
/// 避けるため使わない）。1 回限り・180 秒で失効。
///
/// 受け入れ済みのリスク（レビュー M2・2026-10-24）:
///   ポートはエフェメラルで事前予測はできないが、ローカルの別プロセスがスキャンして
///   偽のコード（書式だけ正しい）を送ると、この 1 回限りの受信が消費されて
///   **ログインが失敗する**（DoS のみ。セッションの盗難は起きない: 交換先は本番固定で、
///   サーバーが発行した 60 秒の単発コードでなければ 400 になる）。
///   同じ経路で攻撃者自身のコードを差し込む**ログイン CSRF** も理論上ありうるが、
///   単一ユーザーのデスクトップ用途として受け入れる。恒久久対策はサーバー側の PKCE 対応。
/// </summary>
internal static class DesktopLogin
{
    private const string SiteOrigin = "https://koinoyamai.love";
    private const int TimeoutMs = 180_000;          // ブラウザ側でユーザーが操作する時間
    private const int ReceiveTimeoutMs = 10_000;

    // サーバー側は crypto.randomBytes(32).toString('base64url') を返す（43文字）
    private static readonly Regex CodeRe =
        new("^[A-Za-z0-9_-]{20,200}$", RegexOptions.Compiled);

    /// <summary>127.0.0.1 の空きポートで「1 回限り」の受信を開始したもの。</summary>
    public sealed record Waiter(int Port, Task<string?> Code);

    /// <summary>
    /// ループバック受信を開始する。Port はすぐに使える（ブラウザへ渡してよい）。
    /// Code は「1 回の /callback?code=…」を受け取るまで待つ（失敗・タイムアウトは null）。
    /// </summary>
    public static Waiter StartWaiter()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var tcs = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);

        _ = Task.Run(() =>
        {
            try
            {
                var deadline = Environment.TickCount64 + TimeoutMs;
                while (Environment.TickCount64 < deadline)
                {
                    if (!listener.Pending()) { Thread.Sleep(200); continue; }
                    using var client = listener.AcceptTcpClient();
                    var code = HandleRequest(client);
                    if (code != null) { tcs.TrySetResult(code); return; }
                }
                tcs.TrySetResult(null);   // タイムアウト
            }
            catch
            {
                tcs.TrySetResult(null);
            }
            finally
            {
                try { listener.Stop(); } catch { }
            }
        });

        return new Waiter(port, tcs.Task);
    }

    /// <summary>
    /// 受信した単発コードをセッショントークンに交換する。失敗時は null。
    /// </summary>
    public static async Task<string?> ExchangeCodeAsync(string code, CancellationToken ct)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            var content = new StringContent(
                JsonSerializer.Serialize(new { code }), Encoding.UTF8, "application/json");
            using var resp = await http.PostAsync($"{SiteOrigin}/auth/token-exchange", content, ct);
            if (!resp.IsSuccessStatusCode) return null;
            var json = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("token", out var t) && t.ValueKind == JsonValueKind.String
                ? t.GetString()
                : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>1 リクエストだけを処理し、正しければコードを返す。</summary>
    private static string? HandleRequest(TcpClient client)
    {
        try
        {
            client.ReceiveTimeout = ReceiveTimeoutMs;
            using var stream = client.GetStream();

            // 1 行目が分割されて届く場合もあるため、"\n" が揃うまで読む
            // （分割読み込みでコードが途中で切れて黙って失敗するのを防ぐ / レビュー指摘 M1）
            var buf = new byte[2048];
            var total = 0;
            while (total < buf.Length)
            {
                var read = stream.Read(buf, total, buf.Length - total);
                if (read <= 0) break;
                total += read;
                if (Array.IndexOf(buf, (byte)'\n', 0, total) >= 0) break;
            }
            if (total <= 0) return null;

            var firstLine = Encoding.ASCII.GetString(buf, 0, total).Split('\n')[0].Trim();
            var parts = firstLine.Split(' ');
            if (parts.Length < 2) { Respond(stream, 400, "不正なリクエストです"); return null; }

            var target = parts[1];
            var q = target.IndexOf('?');
            if (q < 0 || target[..q] != "/callback") { Respond(stream, 404, "Not found"); return null; }

            var code = QueryParam(target[(q + 1)..], "code");
            if (string.IsNullOrEmpty(code) || !CodeRe.IsMatch(code))
            {
                Respond(stream, 400, "コードがありません");
                return null;
            }

            Respond(stream, 200, "ログインしました。この画面は閉じて、アプリへ戻ってください。");
            return code;
        }
        catch
        {
            return null;
        }
    }

    private static string? QueryParam(string query, string key)
    {
        foreach (var pair in query.Split('&'))
        {
            var kv = pair.Split(new[] { '=' }, 2);
            if (kv.Length == 2 &&
                string.Equals(Uri.UnescapeDataString(kv[0]), key, StringComparison.OrdinalIgnoreCase))
                return Uri.UnescapeDataString(kv[1]);
        }
        return null;
    }

    private static void Respond(NetworkStream stream, int status, string message)
    {
        var reason = status == 200 ? "OK" : status == 400 ? "Bad Request" : "Not Found";
        var html =
            "<html><head><meta charset=\"utf-8\"></head>" +
            "<body style=\"font-family:sans-serif;padding:2em\">" +
            $"<h2>{(status == 200 ? "ログインしました" : "エラー")}</h2>" +
            $"<p>{message}</p></body></html>";
        var body = Encoding.UTF8.GetBytes(html);
        var head = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status} {reason}\r\n" +
            "Content-Type: text/html; charset=utf-8\r\n" +
            $"Content-Length: {body.Length}\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n");
        stream.Write(head, 0, head.Length);
        stream.Write(body, 0, body.Length);
        stream.Flush();
    }
}
