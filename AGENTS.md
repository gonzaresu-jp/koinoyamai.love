# AGENTS.md — AIエージェント向け 運用安全規則（mai-push）

このリポジトリで作業するAI/エージェントは**必ず本ファイルを読むこと**。
過去に複数回の重大事故が確認されている（2026-09-21〜22）。

## 1. ポート位相（最重要・間違えやすい）
- **本番API = PORT 8080**（pm2: `mai-push-api`, `/var/www/html/mai-push/server.js`）
- **staging API = PORT 8081**（pm2: `mai-push-api-test`, `/home/yuzuki/mai-push-test/server.js`, NODE_ENV=development）
- **本番ワーカー = `mai-push-worker`**（pm2, `/var/www/html/mai-push/main.js`、Webhook 3001）
- `curl localhost:8081` は**staging**である。本番検証を 8081 で行うと**stagingの旧コードを本番と誤認**する（実際に起きた）。
- 検証前に必ず `ss -ltnp | grep -E '8080|8081'` と `pm2 pid` で**ポートの実所有者PID→パス**を確認してから叩け。

## 2. 通知API（/api/notify）— 本番で実送テスト禁止
- **本番(8080)への POST /api/notify は実ユーザーにpushが届く**（web push + FCM）。テスト送信による誤爆が実際に発生した。取り消し不能。
- 通知の動作確認は **必ず staging(8081)** で行うこと。staging `.env` は `DISABLE_NOTIFICATIONS=1` 固定（実送抑止・履歴のみ）。**この設定を1に戻すな**。
- stagingで抑制確認済みのレスポンス: `{"success":true,"suppressed":true,...}` が返れば auth 経路は正常。

## 3. 認証仕様（2026-09 codex セキュリティ改修＋09-24 HMAC v2後）
- `/api/notify` ヘッダ: `x-notify-token: $NOTIFY_API_TOKEN` + `x-notify-hmac` + **`x-notify-timestamp`（UNIX秒、必須）**
- HMAC v2 署名対象: `"{timestamp}.{rawBody}"` の SHA256 hex（**受信した生ボディ**で検証。JSON作り直し禁止）。
  送信側は必ず `notify-sign.js` の `signNotifyPayload(secret, bodyString)`（`{hmac, timestamp}` を返す）を使い、
  送信する JSON 文字列そのものに署名すること。`X-Signature` は API 側で読まれない。
- タイムスタンプ許容±300秒（リプレイ対策）。超過・欠落は401。
- env 3値は**環境ごとに別々のランダム値**を `.env` に設定（コミット対象外・`.env` は gitignore）: `NOTIFY_API_TOKEN` / `NOTIFY_HMAC_SECRET` / `INTERNAL_API_TOKEN`。未設定時 `/api/notify` は **503**。
- `ADMIN_NOTIFY_TOKEN` は通知/内部APIでは**もう使われない**（管理者専用）。
- OAuth: `state` はランダム単発5分失効（`/auth/token-exchange` で60秒単発code→JWT交換）。**stateやJWTがURLに平文で残らない**。
- HMAC比較は `crypto.timingSafeEqual` 使用。自前で `===` 比較に戻すな。

## 4. ワーカー二重起動防止（StartGuard）
- `main.js` は `[StartGuard]` プロセスロック（`/tmp` 等、`NODE_ENV` で test/prod 分離）を持つ。
- **pm2稼働中に手で `node main.js` を起動するとロックで拒否される**（仕様）。検証で二重起動させるな。

## 5. 依存関係
- **sqlite3 は 6.0.1 に昇格済み（2026-09-22 本番反映）**。npm audit critical は解消。
  依存を触る際は必ず staging で「実体 node_modules の npm install → 回帰テスト(21/21) → smoke」を通すこと。
- 本番プロセスは **Node v22.12.0**（nvm）で稼働。ネイティブモジュールをビルドする際は
  `PATH` を v22 優先にして `npm install` すること（v18 でビルドするとABI不一致が起きる）。
- `package-lock.json` は Git 管理対象。除外するな。`npm audit fix --force` は回帰テスト通過後にのみ。

## 6. 検証の作法
- 変更後は `node --check <file>` → pm2 再起動（`--update-env`）→ **正しいポート**で `/api/health`。
- 本番 pm2 再起動は作業者の明示承認後にのみ実施。
- DB・history.json を触るテストは本番でやるな。staging でやれ。

## 6.5 第2ラウンド反映（2026-09-22、本番昇格済み main @ fb4449f）
- **HMAC 送信側は `notify-sign.js`（`signNotifyPayload`）で統一済み**。`/api/notify` へ送る
  コードを書くなら必ず `X-Notify-Hmac`（生hex）を付けること。`X-Signature` は API 側で読まれない。
  ※ 2026-09 の HMAC 必須化直後は全送信モジュールが未追随で、実は next-new-content で401する状態だった（修正済み）。
- `/api/internal/twitter/analysis` もトークン + HMAC 必須（twitter.js 送信側は同期済み）。
- `main.js` のワーカー内 `/api/notify` は **fail-closed（トークン未設定時 503）**。
- **sqlite3 は 6.0.1 に昇格済み**（npm audit critical 解消）。`npm audit fix --force` 禁止は解除されたが、
  依存を触る際は必ず staging で「実体 node_modules の npm install → 回帰テスト → smoke」を通すこと。
- **staging の node_modules は実体**（本番への symlink を廃止）。staging で依存変更した場合、
  `package-lock.json` の反映分を本番ツリーでコミットすること。
- **backups は `/var/lib/mai-push/backups`**（Web公開ツリー外）。`backup.sh` が日次 03:00 に保存。
  Web ツリー内の `backups/` は存在しない（退避済み）。
- `trust proxy` は `"loopback"`、helmet は全 static より前。`.env` は重複キー禁止（先頭勝ちで無効化される罠）。

## 6.6 第3ラウンド反映（2026-09-24、外部評価対応）
- API(8080/8081)・ワーカー内Express(3002/3003) は **`127.0.0.1` にbind**（nginx/cloudflared は loopback 経由）。
  YouTube webhook(3001) のみ外部フックのため 0.0.0.0 のまま。`ss -ltnp` で確認すること。
- `main.js` の dotenv は **`path.join(__dirname, ".env")`**（固定パスだと staging が本番 .env を読む事故）。
  `require("path")` を dotenv より前に置くこと。
- `/admin` の Express 静的配信は廃止。**login.html のみ明示配信**し、認証コード（admin.js/webauthn.js）は
  `lib/` に移動（nginx の alias も同dir直配信のため、移動が必須）。
- `/api/system-info` は公開（CPU%・メモリ%・loadavg・稼働時間・RSSのみ。**ホスト名/ディスク/OS詳細は返さない**）。status ページのリソース欄は誰でも閲覧可能。
- `/api/ask`（公開）は 5回/分＋質問500文字上限。管理者用 `/api/admin/ask` は対象外。
- 回帰テストは `npm test`（scripts/regression-test.js、HMAC v2＋timestamp検証含む 21 項目）に接続済み。
- pm2-logrotate 導入済み（20M・10世代・圧縮）。

## 6.7 admin は Tailnet 専用（2026-10-10 追加）
- **管理画面の正規エントリは `https://elza.poitou-mora.ts.net/admin.html`（tailscale serve・tailnet のみ・自動認証）**。
  公開ドメイン（koinoyamai.love / mai）の `/admin`・`/admin.html`・`/admin/login/` は **ts.net へ 302 リダイレクトが仕様**
  （Ctrl+K パレットのショートカット用。`/api/admin` は **403** のまま）。
  （nginx: `allow 192.168.0.0/16` + `100.64.0.0/10` で deny 時に `error_page 403 = @to_elza_*` → 302。
  cloudflared 由来の loopback はリダイレクト。**302/403 を障害と誤診しないこと。**）
  LAN/Tailnet 直撃は従来通りローカル配信（tailscale 停動時の保険）。
  elza vhost は tailscale serve の受け皿（`127.0.0.1` 許可）＋
  webui 静的配信（`/css/`・`/js/admin-`・`/migration.js`・fontawesome）付き。
- LAN 保険: `http://192.168.1.72:1700/admin/login/`（WebAuthn は http 非対応のためパスワードのみ）。
  `/api/` の `Host` は **`$http_host`**（`$host` に戻すとポートが落ちて POST が CSRF 403 になる）。
- **tailscale funnel は OFF（再有効化しない）**。`funnel off` は serve config ごと消えるため、
  消えた場合は `sudo tailscale serve --bg --yes --https=443 http://127.0.0.1:80` で tailnet only に立て直す。
- **tailnet 経由は自動認証（2026-10-10 追加）**: tailscale serve 経由（nginx の remote_addr=127.0.0.1）の
  ときだけ nginx が `X-Tailnet-Admin` に秘密値（`.env` の `TAILNET_ADMIN_SECRET` ＝ nginx map
  `$tailnet_admin` と同一値）を付与し、`lib/admin.js` の `isTailnetAdmin()` が一致時に
  パスワード/パスキーを省略する（`requireAuth` / `isAdminRequest`）。**ts.net ではログイン不要**
  （login.html は `/api/admin/verify` ok で自動リダイレクト）。他経路は空/不一致のため偽装不可。
- パスキー: 自動認証により **ts.net では不要**（任意フォールバックとして残存。RP は `.env` の
  `WEBAUTHN_RP_ID_EXTRA` / `WEBAUTHN_ORIGIN_EXTRA`。他ドメインとは RP が別）。
- nginx へは `~/apply-admin-tailnet.sh` と `~/apply-admin-autoauth.sh`
  （アンカー文字列カウント検証付きパッチ）で反映。
  復旧用バックアップ: `/etc/nginx/nginx.conf.bak-admin-*` / `.bak-autoauth-*`。funnel/serve は tailscale CLI（要 sudo）。

## 7. 自動化スクリプト（2026-09-26 追加）— AI はこれを使う
手動でのミスを防ぐため、以下を実装済み。**作業の対応するフェーズで必ず実行すること。**

### 7.1 デプロイ後の検証（必須）
```bash
bash scripts/verify-deploy.sh webui/<file>          # 静的ファイル
bash scripts/verify-deploy.sh webui/<file>.php      # PHP（バイト比較はskip）
```
- **配信バイト数 vs ディスクのバイト数**を機械比較し、nginx の `open_file_cache` による
  切り詰め（応答が途中で切れ `<script>` が消える）を検出する。**HTTP 200 を返しても
  気づけないので必ずこのスクリプトを使うこと。** 検出したら自動でTTL待ちして再試行する。
- 公開 HTML の `</html>` 欠落と `<?php` のにじみ出しも検出する。

### 7.2 ポート位相の検証（本番操作の**前**に必須）
```bash
bash scripts/assert-port.sh prod        # 8080 が本番ツリーか
bash scripts/assert-port.sh staging     # 8081 が staging ツリーか
```
- ポート → PID → 実行スクリプトパスを照合する。**不一致なら exit 1 で停止**。
- AGENTS.md §1 の事故（`curl localhost:8081` で本番と誤認）を防ぐ。

### 7.3 push 前の自動検査（pre-push フック、有効化済み）
`core.hooksPath = scripts/hooks` により、push 時に自動で：
- ステージ・コミット対象の `.js` に対し `node --check`
- `.php` に対し `php -l`
- 回帰テスト `npm test`（21項目、約4秒）
- 構文エラーがあれば push を拒否。回避は `git push --no-verify` または `SKIP_PREPUSH_REGRESSION=1`。

### 7.4 staging/本番のドリフト検出
```bash
bash scripts/check-drift.sh            # 乖離の有無と是正コマンドを表示
bash scripts/check-drift.sh --quiet    # cron 用（出力最小）
```
- git ブランチの乖離、Service Worker バージョン、主要ファイルの md5 一致、
  未コミット変更を検査する。**exit 0=乖離なし / 1=乖離あり**。
- 毎晩 00:05 の `update-subscribers-and-commit.sh` が作る `webui/data` のみの
  自動コミットによる behind は**正常と判定**（誤検出しない）。
- **cron 登録済み**（1日1回 06:30、0.14秒。ログは `logs/drift.log`）:
  ```
  30 6 * * * cd /var/www/html/mai-push && ./scripts/check-drift.sh --quiet >> logs/drift.log 2>&1
  ```
  乖離があった場合のみログに記録される（--quiet は出力を stderr に出すため、
  乖離なしは無言で exit 0）。

### 7.5 日次データ更新（cron 実装済み・手動介入不要）
```
5 0 * * * cd /var/www/html/mai-push && ./scripts/update-subscribers-and-commit.sh >> logs/subscribers.log 2>&1
```
- `scripts/update-subscribers.js` で YouTube 登録者数を取得し `webui/data/*.txt` に追記、
  そのまま **commit + push** する。`webui/data` は ignore 済みだが追跡済みのため `git add -u` を使う。
- 登録者数が変わらない日は空コミットを作らない。**自動pushは他作業と競合しないよう
  データ変更があった日のみ**。push 失敗時はログに記録し exit 1。

### 7.6 改行コード
`.gitattributes` で `text=auto eol=lf` を設定済み。LF→CRLF 混入で作業ツリーが
dirty になる事故（2026-09-26、main.js を含む8ファイル）を防止。既存の CRLF ファイルは
遅延正規化。バイナリ拡張子は `binary` と明示。

## 8. nassy 側パイプライン（2026-09-27 systemd 化）— 本番 worker の依存先
配信終了後の **動画DL → 字幕 → チャプター** は elza ではなく **nassy** で実行される。
`main.js/youtube.js` は検知した直後に `sendInternalUrl()`（`youtube.js:155-166`）で
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

## 9. 未確定メモ（2026-10-03）
- **RAG回答モデル候補: OpenRouter × Nous Hermes 3 Llama 3.1 70B**（検討中・未実装）。
  無検閲応答が目的。実装する場合は `routes/rag.js` の `chat()`（RAG_CHAT_PROVIDER 分岐）に
  OpenRouter（OpenAI互換 `https://openrouter.ai/api/v1/chat/completions`）を追加する想定。
- **本番チャットの埋め込みは稼働中（2026-10-10 確認）**: `llama-embed.service`（llama.cpp・
  OpenAI互換 `:8082`・`embeddinggemma-2`）と `pi-vector.service`（`:6333`・simpleベクトルDB）が
  systemd user で稼働し、`services/vectordb.js`（`.env` の `VECTOR_DB_BACKEND=simple` /
  `VECTOR_DB_URL=http://127.0.0.1:6333`）経由で `routes/rag.js` が検索する。
  実測 `vectordb.isEnabled=true` / `embeddings.isEnabled=true` → `/api/ask` は埋め込み・検索とも動作。
  ベクトル実体は `/var/lib/mai-push/pi-vector/vectors.jsonl`（2026-10-10 時点 10,857件・176MB）。
  ※ 旧「EMBEDDING_ENDPOINT（ollama bge-m3）停止で `/api/ask` が 503」の記述は**失効（解消済み）**。
  ※ `pi-vector-service/` は 32bit Pi 向け依存ゼロ実装を母艦へ移設したもので**削除禁止**。
    unit は `~/.config/systemd/user/pi-vector.service`（`Restart=always`・enabled）。
    `ExecStart` は Node v20.18.1（本番は v22.12.0）だが依存ゼロコードのため実害なし。
  ※ 「ローカルLLM運用は不可（ユーザー指示）」は**回答生成LLMに限る**。埋め込みは上記の通り
    ローカル（llama.cpp）で稼働しており、この指示の対象外。
- **TTS速度調整**: `/api/admin/chat/speak` の `num_steps`(1〜4、body優先) / env `CHAT_TTS_NUM_STEPS`（本番・stagingとも `2` 設定済み・2026-10-03）。
  1=最速（6.3秒音声で約3秒短縮・要音質確認）、4=TTS既定。admin まいAIタブの「品質」セレクタで A/B 可。
- **TTSストリーミングは latent-slice 方式（2026-10-03 導入）**: SSE時のみ全文1回 MeanFlow → ラテンツを
  コンテキストマージン付き（ctx=6フレーム・SNR80dB）で連続スライス逐次デコード。文ごとのMeanFlow固定費
  （≈3.3秒）と再生途端の無音ギャップを除去（実測 初回音声7.9→5秒・総時間17.1→13.5秒）。
  knob: env `IRODORI_STREAM_SLICES_ENABLED=false`（旧・文単位合成へ即復帰）/ `IRODORI_STREAM_SLICE_SECONDS=2.5`
  / `IRODORI_STREAM_FIRST_SLICE_SECONDS=1.5` / `IRODORI_STREAM_SLICE_CONTEXT_FRAMES=6`。
  - **ハザード: venv パッチ必須** — `return_latent` は `.venv/.../irodori_tts/inference_runtime.py`（venv内・
    Git管理外）に直接パッチ済み。`uv sync` / `uv add` で**消えて latent ストリームは起動エラー级に fallback**
    する（app側はTypeError→ RuntimeErrorでerrorイベントに倒す防御あり）。venv再構築後は必ず再パッチすること。
- **TTSで検証済み・不採用レコード**: ①`IRODORI_COMPILE_MODEL=true`（torch.compile）＝warmup242秒・
  meanflow 3.7→74〜126秒の20倍悪化。二度と入れない。②decode static int8＝SNR9-12dBで音質棄却、
  weight-only int8＝透明だが速度+0〜2%、dynamic int8＝遅化。meanflowは既に公式int8-weight-only。
  ③ディスクリートGPUなし（iGPU UHD630）。NEOドライバ導入済み・OVでGPU認識もするが decode は
  **CPU比 -65〜-195%（全面的にCPUが勝つ）** → iGPU不採用。GPU有効化は新規購入のみ。

## 10. WinUI アプリ（Windows/mai-push-winui）デプロイ注意

- **実行ファイルはローカルドライブから起動すること（2回目の事故: 2026-10-13）**
  - `Q:\` などのネットワーク共有（UNC パス含む）から起動すると `EnsureCoreWebView2Async` が
    COMException で失敗し WebView2 が一切描画されない。
  - ビルド出力: `$(LOCALAPPDATA)\MaiPushWinUI\` に固定済み（`BaseOutputPath` + `PublishDir`）。
  - `dotnet publish` 後の正規パス: `%LOCALAPPDATA%\MaiPushWinUI\publish\まいちゃん通知.exe`
  - **ネットワークドライブ上の publish/ ディレクトリからは起動しないこと**。
- **トレイアイコンのパスは必ず `AppContext.BaseDirectory` 起点の絶対パスにすること（v1.8.2 教訓）**
  - Run キー（自動起動）で起動したプロセスの CWD は `C:\Windows\System32` になる。
    相対パス `Assets\tray-icon.ico` は File.Exists=false → TaskbarIcon.Icon=null のまま
    ForceCreate → Shell_NotifyIcon に空ハンドル → **トレイに「透明な空きアイコン」が残る**。
  - 同様に `_appWindow.SetIcon()` も相対パスは自動起動時に失敗する。
- **トースト表示（NotificationHelper.ShowToast）は例外を握りつぶすこと**
  - WinRT コールバック（CoreMessaging / DispatcherQueue 経由）内での未処理例外は
    stowed exception (0xc000027b) としてプロセスごと落ちる。WER では
    combase.dll (E_INVALIDARG/E_FAIL) × CoreMessagingXP.dll / Microsoft.UI.Xaml.dll の
    フォールトが多発していた（v1.8.2 で診断強化: `%LOCALAPPDATA%\MaiPush\log.txt` に例外ログ、
    WER LocalDumps でミニダンプ収集、RegisterApplicationRestart で自動再起動）。
- **Release publish は self-contained（csproj の `<SelfContained>`）**
  - framework-dependent publish でインストールすると、グローバル .NET 構成が揃わない環境・
    InstallDelete 後のタイミングで「No frameworks were found」で自動起動失敗する。

最終更新: 2026-10-17（§10 v1.8.2 不安定問題修正メモ：トレイ透明アイコン=相対パス、クラッシュ=stowed exception 対策）
最終更新: 2026-10-13（§10 WinUI ネットワーク起動禁止を追記）
最終更新: 2026-10-10（§9 埋め込み停止中→稼働中に訂正 / CollabPoll 修正・md整理は別コミット）
最終更新: 2026-10-03（チャット読み上げ追加 / TTS systemd化・int8＋ONNX高速化 / latent-sliceストリーミング・不採用レコード / AGENTS.md §9 追加）
