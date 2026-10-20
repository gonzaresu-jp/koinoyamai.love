# アーキテクチャ早見表（ARCHITECTURE.md）

このファイルは「**エージェント／新規参加者が1ファイルで全体像と"どこを見るか"を掴む**」ための入口です。
運用の安全規則・禁止事項は `AGENTS.md`、個別機能の詳細は各 `docs/*.md` を参照してください。

- 対象: **サーバ(Node.js) + webui** を中心（Android/WinUI/nassy は概要のみ）
- 深さ: 概要マップ + file→役割索引（行番号は最小限。実装の真実は各ファイル）
- 更新: 手動（構成を変えたら本ファイルも更新する）

> 迷ったら: 「§4 file→役割」で目的のファイルを引き、無ければ `grep`。運用手順は `AGENTS.md`。

---

## 1. システム概要

まいちゃん（VTuber「恋乃夜まい」）関連の**配信・投稿を検知して Web Push / FCM / SSE で通知**するサービス。
加えて、Twitter 予定の自動抽出、YouTube アーカイブ（字幕・チャプター・全文検索）、RAG チャット、管理画面を提供する。

登場人物（プロセス）:

| 役割 | 実行ファイル | 説明 |
|---|---|---|
| API サーバ | `server.js` | Web UI/API。ルーター登録・認証・SSE・レート制限の本体 |
| ワーカー | `main.js` | 各プラットフォーム監視（スクレイパー）と通知発火。`/api/notify` も内包 |
| Discord Bot | `discord-bot.js` | 監視・アラート・Discord 通知 |
| フロント | `webui/` | PHP テンプレート + 静的 JS（`/webui`・nginx 直配信） |
| 外部 | nassy 192.168.1.70 | 配信後の動画DL→字幕→チャプター生成（`AGENTS.md §8`） |

---

## 2. プロセス・ポート（重要）

| プロセス | PORT | bind | 実行パス | 備考 |
|---|---|---|---|---|
| `mai-push-api`（本番） | 8080 | 127.0.0.1 | `/var/www/html/koinoyamai.love/server.js` | nginx/cloudflared 経由 |
| `mai-push-api-test`（staging） | 8081 | 127.0.0.1 | `/home/yuzuki/koinoyamai.love-test/server.js` | `NODE_ENV=development`・`DISABLE_NOTIFICATIONS=1` |
| `mai-push-worker`（本番） | 3002 | 127.0.0.1 | `/var/www/html/koinoyamai.love/main.js` | スクレイパー本体 |
| `mai-push-worker-test` | 3003 | 127.0.0.1 | `/home/yuzuki/koinoyamai.love-test/main.js` | 手動起動運用 |
| YouTube Webhook | 3001 | 0.0.0.0 | `src/scrapers/youtube.js startWebhook` | PubSubHubbub。外部フックのため唯一 0.0.0.0 |
| `discord-bot` | – | – | `/var/www/html/koinoyamai.love/discord-bot.js` | |

- 定義は `ecosystem.config.js`。API は **Node v22.12.0（nvm）** 固定、ワーカーは既定 node。
- **`curl localhost:8081` は staging**。本番検証と誤認しないこと（`AGENTS.md §1`）。検証前に `bash scripts/deploy/assert-port.sh prod|staging`。

---

## 3. 主要データフロー

### 3.1 通知（配信検知 → push）
```
スクレイパー(main.js が起動: youtube/twitter/twitcasting/fanbox/bilibili/… )
  → 変化を検知し payload 生成
  → POST {NOTIFY_API_URL}=/api/notify  （src/core/notify-sign.js で HMAC v2 署名 + token + timestamp）
  → routes/notify.js
      ├─ notifications に INSERT（履歴）
      ├─ services/notification.js: web push（VAPID）+ FCM（Android）
      ├─ services/sse.js: history-updated を SSE 配信
      └─ services/history.js: history.json を更新
```
- 認証: ヘッダ `x-notify-token` + `x-notify-hmac` + `x-notify-timestamp`。**生ボディ**に署名（`AGENTS.md §3`）。
- `DISABLE_NOTIFICATIONS=1` の環境では実 push せず履歴のみ（staging の既定）。
- ワーカー内 `main.js` の `/api/notify` は **fail-closed（トークン未設定時 503）**。

### 3.2 スクレイパー（`main.js` が起動）
- 各モジュールは `init(notifyConfig)` を受け取り、検知時に `/api/notify` へ送る。
- YouTube は Webhook(3001) + RSS ポーリング + 終了検知。Twitter/TwitCasting は `startWatcher`。Bilibili は live/dynamic。Fanbox/Twitch/ytcommunity/gipt も `main.js` から起動。
- 検知後、`src/scrapers/youtube.js sendInternalUrl()` が **nassy(192.168.1.70:1700)** へ動画DL→字幕→チャプターを依頼（`AGENTS.md §8`）。

### 3.3 週間スケジュール / 予定抽出
- `weekly/` がプラットフォーム（youtube/twitch/twitcasting）を取得し `updateSchedule()` で `events` を upsert。
- Twitter 解析（`src/scrapers/gemma-analyzer.js` → `src/scrapers/twitter.js`）が配信告知から予定を抽出し `routes/user-schedules.js` 経由で登録。詳細は `docs/SCHEDULE-FEATURES.md`。

### 3.4 アーカイブ / RAG
- アーカイブ本体は **nassy の `api.py`（8766）**。`routes/archive.js` / `routes/admin-archive.js` は上流プロキシ（サーキットブレーカー付き）。仕様は `docs/ARCHIVE-ADMIN-SPEC.md`。
- RAG: `routes/rag.js` が `services/embeddings.js` + `services/vectordb.js`（`VECTOR_DB_BACKEND`）で検索し回答生成。`/api/ask`（公開）・`/api/admin/ask`（管理）。`AGENTS.md §9` 参照。

---

## 4. file → 役割索引

### 4.1 ルート（エントリポイントのみ）
| ファイル | 役割 |
|---|---|
| `server.js` | API 本体。static/CSRF/SSE/レート制限/ルーター登録/health。`127.0.0.1` bind |
| `main.js` | ワーカー。スクレイパー起動・`/api/notify`(fail-closed)・Webhook(3001)・cron・StartGuard |
| `discord-bot.js` | Discord Bot 本体（pm2 `discord-bot` のエントリ） |
| `ecosystem.config.js` | pm2 定義（prod/staging の全プロセスと env）。`script:` は上記エントリを指す |
| `build.mjs` | webui の esbuild バンドル（ルートJSとは無関係） |

> ルート直下は**エントリとビルドのみ**。スクレイパー・共有コアは `src/` 配下（2026-10-19 移動）。

### 4.1b `src/`（スクレイパー・共有コア）
**`src/scrapers/`**（`main.js` が起動する監視モジュール。`init(notifyConfig)` を受ける）
| ファイル | 役割 |
|---|---|
| `youtube.js` | YouTube 監視。`startPolling/startWebhook/init/…`。nassy 依頼(`sendInternalUrl`) |
| `twitter.js` | Twitter 監視。`check/startWatcher`。予定解析連携 |
| `twitcasting.js` | TwitCasting 監視。`startWatcher/checkLiveStatus/sendNotify/syncEventToSchedule` |
| `fanbox.js` | Fanbox 投稿監視。`startPolling/checkFanboxPosts` |
| `twitch.js` | Twitch ポーリング。`startTwitchPolling` |
| `bilibili-live.js` / `bilibili-dynamic.js` | Bilibili 直播/动态 監視 |
| `ytcommunity.js` | YouTube コミュニティ投稿監視 |
| `gipt.js` | gipt（チケット等）監視 |
| `twitter-media-saver.js` | Twitter メディア保存 |
| `gemma-analyzer.js` | Gemini でツイート解析（予定抽出）。`services/ai-quota` 使用 |

**`src/core/`**（ルート／他層から共有されるコア）
| ファイル | 役割 |
|---|---|
| `notify-sign.js` | `/api/notify` 用 HMAC v2 署名生成（送信側は必ずこれを使う） |
| `browser.js` | Puppeteer 共有プール（userDataDir キー） |
| `milestone.js` | 記念日通知スケジューラ（`MilestoneScheduler`） |
| `discord-alert.js` | 監視/アラート共通（`attachGlobalCrashHandlers`/`startSystemMonitor`） |
| `schedule-drift-monitor.js` | スケジュール乖離の監視 |
| `user-routes.js` | ユーザー系ルーター束ね（`register(app, db, authLimiter)`） |
| `migrate.js` | DB マイグレーション（CLI: `node src/core/migrate.js`） |
| `auth.js` | 認証ヘルパー（`routes/user-*.js`・`routes/android.js` が使用） |

### 4.2 `routes/`（Express ルーター。`register(app, db)`）
| ファイル | 主なエンドポイント |
|---|---|
| `notify.js` | `POST /api/notify`, `/api/internal/twitter/analysis`（認証中核） |
| `admin.js` | `/api/admin/login|logout|verify|notify` |
| `admin-archive.js` | `/api/admin/archive/*`（nassy 管理・編集/削除/要約） |
| `admin-twitter-stats.js` | `/api/admin/mai-state`, `/api/admin/twitter/stats` |
| `archive.js` | `/api/archive/*`（videos/search/transcript/chapters/minutes/buzzwords…） |
| `ai-usage.js` | `/api/ai-usage` |
| `android.js` | `/api/android/register|send-test|settings` |
| `events.js` | `/api/events*`, `/api/admin/events*`, `/api/admin/weekly-message` |
| `history.js` | `/api/history`, `/api/notifications/stats*` |
| `rag.js` | `/api/ask`, `/api/search`, `/api/admin/ask`, `/api/admin/chat/*`（TTS含） |
| `scraper-status.js` | `/api/scraper-status`, `/api/internal/scraper-status` |
| `subscriptions.js` | プラットフォーム購読設定、VAPID 公開鍵、テスト送信 |
| `system.js` | `/api/system-info`（公開・リソースのみ） |
| `twitter-media.js` | `/api/twitter-media*` |
| `user-auth.js` | `/auth/google|discord`(OAuth), `/auth/token-exchange`, `/auth/logout` |
| `user-profile.js` | `/api/user/me|oshi|notification-settings|devices|link-subscription` |
| `user-schedules.js` | `/api/user/schedules*` |
| `user-internal.js` | `/api/internal/events/{create,find-duplicate,update}` |
| `user-helpers.js` | 共有ヘルパー（登録なし） |

> OAuth は `state` 単発 + `/auth/token-exchange`（60秒単発 code→JWT）。`AGENTS.md §3`。

### 4.3 `services/`（共有ロジック）
| ファイル | 役割 |
|---|---|
| `context.js` | プロセス共有コンテキスト（`app`/`db`/`sseClients`/`fcmMessaging` 等） |
| `database.js` | `initDatabase()`（テーブル定義・マイグレーション） |
| `notification.js` | VAPID/web push/FCM/管理者通知/ハッシュ判定 |
| `sse.js` | SSE 配信（`sendSseEvent`） |
| `history.js` | `history.json` 更新 |
| `scheduler.js` | 定期タスク（`startPeriodicTasks`） |
| `milestone.js`（`src/core/`・再利用） | 記念日スケジューラ |
| `minutes-sync.js` | 要約(`video_minutes`)→ベクトルDB 同期 |
| `embeddings.js` | 埋め込み生成クライアント |
| `vectordb.js` | ベクトルDBクライアント（バックエンド切替） |
| `vector-sync.js` | SQLite→ベクトルDB 増分同期 |
| `mai-state.js` | 活動傾向の推定（管理「まいAI」タブ） |
| `twitter-stats.js` | ツイート統計 |
| `pressure.js` | 気圧予測（管理表示用） |
| `system-cpu.js` | CPU/リソース計測 |
| `ai-quota.js` | AI 呼び出しのクォータ/使用量 |

### 4.4 `lib/`・`weekly/`
| ファイル | 役割 |
|---|---|
| `lib/admin.js` | 管理者認証（`requireAuth`/`isAdminRequest`/tailnet 自動認証） |
| `lib/webauthn.js` | パスキー(WebAuthn)ログイン。**`/admin` 外に配置**（ソース露出防止） |
| `weekly/index.js` | `updateSchedule`/`upsertEvent` |
| `weekly/{youtube,twitch,twitcasting}.js` | プラットフォーム別 予定取得 |
| `weekly/event-upsert.js` | `events` への upsert |

### 4.5 `webui/`（フロント）
| 対象 | 役割 |
|---|---|
| `head.php` / `header.php` / `footer.php` | 共通テンプレート（`header.php` に JST 表示・認証 JS） |
| `index.php` | トップ（通知履歴・アクティビティ） |
| `status.php` | システム稼働状況（`/api/system-info` 利用） |
| `archive.php` | YouTube アーカイブ（検索/字幕/チャプター） |
| `wave.php` | 「揺れるまいちゃん」（PixiJS 演出） |
| `logs.php` / `updatelogs.php` | ログ・コード成長グラフ |
| `info.php` / `guide.php` / `future.php` | 案内/FAQ/将来 |
| `download.php` | アプリDL（`dl/*.json` 参照） |
| `twitter-media.php` | Twitter メディア |
| `admin.html` / `chat.html` / `compare.html` | 管理/チャット/比較の各画面 |
| `js/` | 画面別 JS。`index-*`, `admin-*`, `wave-*`, `header-auth.js`, `header-jst.js`, `pushService.js`, `palette.js` 等 |
| `css/`, `style.css`, `sp.css` | スタイル。`css/header.css` は非 minify で `?v=filemtime` 読込 |
| `data/` / `dl/` / `dist/` / `fontawesome-free-*` | データ・配布物・生成物 |
| `firebase-messaging-sw.js`, `manifest.json` | SW/PWA |

- **CSP は `script-src 'self'`**（nginx `scripts/nginx/mai-test.conf` 等）。インライン JS 不可 → 新規 JS は `/js/*.js` に置く。
- 公開 HTML の反映は `bash scripts/deploy/verify-deploy.sh webui/<file>` でバイト比較（`open_file_cache` 切詰め検出、`AGENTS.md §7.1`）。同スクリプトは配信ファイルが other 読み取り可か（php-fpm から読めるか）も検査する。

### 4.6 `scripts/`（運用）
- **`deploy/`**: `deploy-staging.sh` / `promote.sh`（staging→prod）/ `verify-deploy.sh` / `assert-port.sh` / `check-drift.sh` / `sync-test-db.sh` / `restart.sh`
- **`ops/`**: `regression-test.js`（`npm test`）/ `health-check.js`（`npm run health`）/ `backup.sh` / `healthcheck.sh` / `count-lines.sh` / `check-native.{sh,js}` / `minutes-gen*` / `update-subscribers*`
- **`tools/`**: `build-android-apk.sh` / 単発メンテ（`dedupe-media`・`mine-personality`・`twitter-stats`・`whisper-subs`・`render-compare-html`・`fix-notification-platform`）
- **`hooks/`**（pre-push）/ **`nginx/`**（vhost）/ **`archive/`**（旧スクリプト・参照用）
> すべて**リポジトリ直下から実行**する前提（root は `dirname/../..` で解決）。cron はフルパスで `scripts/{deploy,ops}/...` を指す。

---

## 5. DB（SQLite）主要テーブル

定義: `services/database.js`。本番/ staging は別 DB（`DB_FILE_NAME`）。
`notifications` / `subscriptions` / `android_devices` / `scraper_status` / `scheduled_notifications` / `events` / `weekly_messages` / `video_transcripts` / `yearly_buzzwords` / `vector_sync_state` / `video_minutes` / `chat_sessions` / `chat_prefs` / `chat_messages`
管理系: `admin_passkeys` / `admin_sessions` / `twitter_media`
> アーカイブ（動画/字幕/チャプター）の本体 DB は nassy 側（`AGENTS.md §8`, `docs/ARCHIVE-ADMIN-SPEC.md`）。

---

## 6. 設定・認証

- env は環境ごとに別（`AGENTS.md §2,§3`）。主なキー: `NOTIFY_API_TOKEN` / `NOTIFY_HMAC_SECRET` / `INTERNAL_API_TOKEN` / `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` / `JWT_SECRET` / `SESSION_SECRET` / `PUBLIC_URL` / `COOKIE_SECURE`（他に VAPID・FCM・`DB_FILE_NAME`・`DISABLE_NOTIFICATIONS`・`VECTOR_DB_*`・`TAILNET_ADMIN_SECRET` 等）。テンプレは `.env.example`。
- 通知 API 認証: **token + HMAC v2 + timestamp（±300秒）**。比較は `timingSafeEqual`。
- 管理画面: 正規は **Tailnet（`elza.poitou-mora.ts.net`）で自動認証**。公開ドメインの `/admin*` は ts.net へ 302、`/api/admin` は 403（`AGENTS.md §6.7`）。
- TZ は `Asia/Tokyo` 固定（`server.js`/`main.js` 冒頭）。

---

## 7. 「やりたいこと → 読むファイル」索引

| やりたいこと | 最初に見る場所 |
|---|---|
| 通知の発火/抑制を変える | `routes/notify.js`, `services/notification.js`, `main.js`(notifyConfig) |
| 通知の署名/認証 | `src/core/notify-sign.js`, `routes/notify.js`, `AGENTS.md §3` |
| 新プラットフォーム監視を足す | `main.js`（起動部）+ 新規 `src/scrapers/<platform>.js`（`init(notifyConfig)` 実装） |
| YouTube 監視/Webhook | `src/scrapers/youtube.js`（`startPolling`/`startWebhook`/`init`） |
| 予定抽出（Twitter解析） | `src/scrapers/gemma-analyzer.js`, `src/scrapers/twitter.js`, `routes/user-schedules.js`, `docs/SCHEDULE-FEATURES.md` |
| 週間スケジュール | `weekly/`, `events` テーブル, `routes/events.js` |
| アーカイブ API | `routes/archive.js`, `routes/admin-archive.js`, `docs/ARCHIVE-ADMIN-SPEC.md` |
| RAG/チャット/TTS | `routes/rag.js`, `services/embeddings.js`, `services/vectordb.js`, `AGENTS.md §9` |
| 管理画面/認証 | `routes/admin.js`, `lib/admin.js`, `lib/webauthn.js`, `webui/admin.html` |
| ユーザー/購読/デバイス | `src/core/user-routes.js`, `routes/user-*.js`, `routes/subscriptions.js`, `routes/android.js` |
| フロント UI | `webui/*.php`, `webui/js/`, `webui/css/` |
| DB スキーマ | `services/database.js`, `src/core/migrate.js` |
| デプロイ/検証/回帰 | `scripts/*`, `AGENTS.md §6-7`, `docs/DEVELOPMENT-WORKFLOW.md` |
| セキュリティ | `docs/SECURITY.md`, `AGENTS.md §2-3,§6.6-6.7` |

---

## 8. 落とし穴（必読・抜粋）

- ポート位相: **8080=本番 / 8081=staging**。取り違え事故あり（`AGENTS.md §1`）。
- **本番(8080)への `POST /api/notify` は実ユーザーに届く**。動作確認は staging(8081) のみ（`§2`）。
- `.env` 重複キーは先頭勝ちで無効化される。環境ごとに別値（`§3`）。
- nassy の DL 後処理は **systemd 管理**。手動 `python download.py` 禁止（`§8`）。
- webui は **CSP `script-src 'self'`**（インライン JS 不可）＋ `open_file_cache` 切詰め注意（`§7.1`）。
- アプリ（Android/WinUI）は別ツリー。WinUI は**ネットワークドライブから起動しない**（`§10`）。

---

## 9. 関連ドキュメント

- `AGENTS.md` … 運用手順・安全規則（最初に読む）
- `docs/SECURITY.md` … セキュリティ現状・ハードニング履歴
- `docs/DEVELOPMENT-WORKFLOW.md` … staging/prod デプロイフロー
- `docs/SCHEDULE-FEATURES.md` … 予定抽出・スケジュール機能の詳細
- `docs/ARCHIVE-ADMIN-SPEC.md` … アーカイブ API 仕様
- `docs/MIGRATION-PLAN.md` … `/srv/mai-push` 移設計画（未実施）
- `README.md` … エンドユーザー向け（通知受け取り設定）
- アプリ: `mai_notification/`（Android）, `Windows/`（WinUI）

---

最終更新: 2026-10-19（初版・サーバ+webui中心）
