using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace MaiPushWinUI;

/// <summary>
/// 障害診断ユーティリティ。
/// - CrashLog: %LOCALAPPDATA%\MaiPush\log.txt に例外・起動情報を記録
/// - WER LocalDumps: 0xc000027b (stowed exception) が発生した際のミニダンプを取得可能にする
/// - RegisterApplicationRestart: クラッシュ時に Windows がアプリを自動再起動するよう登録
/// </summary>
internal static class Diagnostics
{
    private static readonly object LogLock = new();

    private static string LogPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MaiPush", "log.txt");

    public static void Log(string source, string message)
    {
        try
        {
            lock (LogLock)
            {
                TrimIfNeeded();
                File.AppendAllText(LogPath,
                    $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{source}] {message}" + Environment.NewLine);
            }
        }
        catch { }
    }

    public static void Log(string source, Exception? ex)
    {
        try
        {
            lock (LogLock)
            {
                TrimIfNeeded();
                File.AppendAllText(LogPath,
                    $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{source}]{Environment.NewLine}" +
                    $"{(ex is null ? "(no exception object)" : ex.ToString())}{Environment.NewLine}{Environment.NewLine}");
            }
        }
        catch { }
    }

    /// <summary>ログ肥大防止（1MB 超なら末尾 256KB 以外を削る）</summary>
    private static void TrimIfNeeded()
    {
        try
        {
            var fi = new FileInfo(LogPath);
            if (fi.Exists && fi.Length > 1_000_000)
            {
                var tail = File.ReadAllText(LogPath, System.Text.Encoding.UTF8);
                int cut = Math.Max(0, tail.Length - 256_000);
                File.WriteAllText(LogPath, tail[cut..], System.Text.Encoding.UTF8);
            }
        }
        catch { }
    }

    /// <summary>
    /// クラッシュ後の自動再起動を登録。
    /// RESTART_NO_PATCH / RESTART_NO_REBOOT を付けて、パッチ適用・再起動再開時は再起動しない。
    /// コマンドラインに --hidden を付けて再起動時はトレイに格納する。
    /// </summary>
    public static void RegisterRestartOnCrash()
    {
        try
        {
            const uint restartNoPatch = 4u;
            const uint restartNoReboot = 8u;
            RegisterApplicationRestart("--hidden", restartNoPatch | restartNoReboot);
        }
        catch (Exception ex)
        {
            Log("RegisterRestartOnCrash", ex);
        }
    }

    /// <summary>
    /// WER LocalDumps を設定して、0xc000027b / AVE などのネイティブフォールト時に
    /// %LOCALAPPDATA%\MaiPush\dumps へミニダンプを残す（将来の根本解析用）。
    /// </summary>
    public static void RegisterWerDumpDirectory()
    {
        try
        {
            var dumpFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MaiPush", "dumps");
            _ = Directory.CreateDirectory(dumpFolder);

            using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(
                @"Software\Microsoft\Windows\Windows Error Reporting\LocalDumps\MaiPush.exe");
            key?.SetValue("DumpFolder", dumpFolder, Microsoft.Win32.RegistryValueKind.ExpandString);
            key?.SetValue("DumpCount", 5, Microsoft.Win32.RegistryValueKind.DWord);
            key?.SetValue("DumpType", 2, Microsoft.Win32.RegistryValueKind.DWord); // 2 = FullDump
            key?.Close();
        }
        catch (Exception ex)
        {
            Log("RegisterWerDumpDirectory", ex);
        }
    }

    /// <summary>起動環境（バージョン・CWD・exe パス）をログに書き出す。不具合再現時の最初の手がかり。</summary>
    public static void LogStartup()
    {
        var exe = Environment.ProcessPath
            ?? Process.GetCurrentProcess().MainModule?.FileName
            ?? Assembly.GetEntryAssembly()?.Location;
        Log("Startup",
            $"v{(typeof(Diagnostics).Assembly.GetName().Version)} pid={Environment.ProcessId} " +
            $"cwd={Environment.CurrentDirectory} exe={exe} --hidden={Environment.GetCommandLineArgs().Contains("--hidden")}");
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint RegisterApplicationRestart(string? commandLine, uint flags);
}
