# AGENTS §8 nassy 側パイプライン

> `AGENTS.md` から分割した詳細（§番号は AGENTS.md と共通）。索引と必読ルールは リポジトリ直下の `AGENTS.md`。

## 8. nassy 側パイプライン（2026-09-27 systemd 化）— 本番 worker の依存先
配信終了後の **動画DL → 字幕 → チャプター** は elza ではなく **nassy** で実行される。
`main.js` と `src/scrapers/youtube.js` は検知した直後に `sendInternalUrl()`（`src/scrapers/youtube.js:163`）で
`POST http://192.168.1.70:1700/` を送り、nassy の常駐サーバが受け取って処理する。

- **nassy = 192.168.1.70 = 192.168.1.93 = 100.65.152.57（Tailscale）**は同一マシン。
  `ssh yuzuki@nassy` は公開鍵登録済みで接続可。**sudo 不可**。
- 受信サーバは **`koinoyamai-download.service`（systemd user unit）** で管理。
  - `~/.config/systemd/user/koinoyamai-download.service`、`WorkingDirectory=/mnt/3TB/恋乃夜まい_YT_Data`
  - `enabled` + `Linger=yes` → **ブート自動起動**。`Restart=always`。
  - **ログ = journald（永続）**: `journalctl --user -u koinoyamai-download.service -f`
  - 状態は `retry_state.json` に永続化済み → **再起動しても再試行を引き継ぐ**。
- 検証: `curl -s -X POST http://192.168.1.70:1700/ -H 'Content-Type: application/json' -d '{"url":"https://www.youtube.com/watch?v=<ID>"}'`
  → `{"ok":true,"videoId":"...","delaySec":5}` が返れば受信側は正常。
- **過去の事故（2026-09-19〜27）**: `download.py` を手動起動したまま 9 日間放置し、
  ① stdout が `socket:[...]` に紐付いて `[WORKER] Received notification` 等が**どこにも残らない**、
  ② 9/21 更新の新コード（`postprocess_after_download`＝DL後処理）が**未反映のまま放置**され
  `postprocess.log` が 9/19 で停止、の 2 件が起きていた。systemd 化で解消済み。
  **手動 `python download.py` で起動しないこと。**

