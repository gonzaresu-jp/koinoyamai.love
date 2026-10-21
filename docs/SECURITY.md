# セキュリティ引き継ぎ・現状（SECURITY.md）

更新日: 2026-09-22（旧 SECURITY_HANDOFF.txt を検証結果込みで本ファイルへ移行・改善）
ブランチ: `feature/security-hardening-20260922`（第1弾・本番昇格済み）→ `feature/sec-round2-20260922`（第2弾・検証中）

## 検証結果（2026-09-22 時点）

- staging(8081) に本ブランチをデプロイ済み。deploy-staging.sh の smoke 全 PASS。
- **回帰テスト 19/19 PASS**（`node scripts/ops/regression-test.js --port 18099`、一時DB・実push抑止）。
- SSE 保護を 8081 実プロセスで確認: 同一クライアント 5接続まで 200 / 6・7接続目 429 / 解放後 200 復帰。
- 回帰テストが**既存潜在バグを検出・修正**: SSE の Origin 判定が `Set.some()` を呼んでおり、
  同一オリジン EventSource（Origin ヘッダなし）で常に TypeError→500 になっていた → `Set.has()` に修正。
- ファイル権限是正済み（本番・staging 両方）: `.env` → 600、`backups/` → 750・中身 640。
  変更後も本番/staging の `/api/health` は 200。
- **本番昇格完了（2026-09-22 承認済み・実施）**: `promote.sh` で main へ ff 昇格（@2ce75f4）＋pm2再起動。
  本番smoke 4/4 PASS、`/api/notify` tokenなし401（実送なし）、SSE上限を本番でも確認（5接続200/6・7接続目429）。
  再起動後10分監視: エラー新規発生なし。
  ※ promote.sh の `git push` はサーバー側にGitHub認証情報が無く失敗するため、pushのみ認証済み環境から実施する運用に注意。
- 既知のテスト時ノイズ: 新規空DBでの初回起動時、`updateSchedule()` が `initDatabase()` のテーブル作成と
  競合し `no such table: events` を一度出すことがある（既存DBでは発生しない・本番影響なし）。
- 参考: 修正済みの旧SSEバグ（`Set.some` → 同一オリジン EventSource が常に500）は、
  本番エラーログに過去 **11,930件** 記録されていた（デスクトップの再接続ループで継続発火）。修正後は0件。

## 最初に読むもの

- **AGENTS.md は必読。** ポート位相、通知テスト禁止、本番再起動の承認制、依存関係更新の禁止事項がある。
- 本番: `/var/www/html/koinoyamai.love`、API **8080**、pm2: `mai-push-api` / `mai-push-worker`
- staging: `/home/yuzuki/koinoyamai.love-test`、API **8081**、pm2: `mai-push-api-test`（`DISABLE_NOTIFICATIONS=1` 固定）
- コマンド実行前に必ず所有者確認:

```bash
ss -ltnp | grep -E ':8080|:8081'
pm2 pid mai-push-api; pm2 pid mai-push-api-test
readlink /proc/<pid>/cwd
```

2026-09-22 実測: 8080 = `/var/www/html/koinoyamai.love`（本番）、8081 = `/home/yuzuki/koinoyamai.love-test`（staging）。

## 反映済みの対策（検証済み）

- OAuth state はランダム・単発・5分失効。デスクトップのJWT受け渡しは60秒の単発code交換。
- `/api/notify` は `NOTIFY_API_TOKEN` と `NOTIFY_HMAC_SECRET` が未設定なら **503** で拒否。
- 秘密値の分離: `NOTIFY_API_TOKEN` / `NOTIFY_HMAC_SECRET` / `INTERNAL_API_TOKEN`。`ADMIN_NOTIFY_TOKEN` は通知/内部APIでは不使用。
- HMAC 比較は `crypto.timingSafeEqual`。署名対象は `{timestamp}.{生ボディ}`（v2、リプレイ対策に±300秒）。
- Electron は `webSecurity=true`。OAuth callback はループバックのみ許可。
- CSRF Origin 判定は完全一致。DB/JSバックアップの誤コミット抑止済み。`package-lock.json` はGit管理。
- **nginx（2026-09-22 外部実測 404 / 2026-10-19 パス改名）**: `location ^~ /koinoyamai.love/ { deny all; }`（旧 `/mai-push/`）、ドットファイル deny、
  `.env|.db|.bak|...` 拡張子 deny が有効 → `/backups/*.db`・`/.env`・`/data.db` はWeb非公開。
- **データ保護（2026-09-22 実施）**: 本番・staging の `.env` を 600 へ、`backups/` を 750・中身 640 へ変更済み。
  ※ `backups/` は gitignore 済みだが **Web公開ツリー内（/var/www/html 配下）** にある。
  nginx の deny で守られているが、`backup.sh` の出力先を Web 外（例: `/var/lib/mai-push/backups`）へ移すのが望ましい。

## 2026-09-22 追加ハードニング（本ブランチ）

| 対象 | 変更 |
|---|---|
| `server.js`（SSE `/api/events/stream`） | 全体接続数上限 `SSE_MAX_CLIENTS`(既定500)・同一送信元上限 `SSE_MAX_PER_CLIENT`(既定5)・接続寿命 `SSE_MAX_AGE_MS`(既定30分)・`retry:` ヒント付与。超過は **429**。送信元キーは前段(nginx/cloudflared)経由のときだけ X-Forwarded-For 末尾を使い、直結では TCP ピア（XFF偽造対策） |
| `routes/notify.js` | トークン比較を `timingSafeEqual` 化 |
| `routes/scraper-status.js` | `POST /api/internal/scraper-status` を `NOTIFY_API_TOKEN` に統一・未設定時 **503**・timing-safe比較。旧実装は「トークン未設定なら認証なしで書込可」＋ADMINトークンを受入れていた |
| `services/context.js` | `LOCAL_API_TOKEN` の `ADMIN_NOTIFY_TOKEN` フォールバックを**廃止**（`POST /api/internal/scraper-status` の送信者はコード上存在せず、worker は直接DB更新のため影響なし確認済み） |
| `main.js` | ワーカー内 `/api/notify` のトークン比較を timing-safe 化 |
| `webui/js/rss-reader.js` | **XSS修正**: 外部RSSの title/desc/link/enclosure を未エスケープで innerHTML に流していた → エスケープ＋ `http(s):` URL検証＋ textContent 描画に変更 |
| `scripts/ops/regression-test.js` | 新規。sqlite3@6 昇格前の回帰テスト（下記） |

**trust proxy の評価**: `app.set("trust proxy", 1)` は現行トポロジ（nginx 直結 `/api/` では XFF 未送出、
cloudflared 経由では `X-Real-IP`＋クラウドフレアが付与した XFF）で実クライアントIPを正しく取る。
nginx が `/api/` に XFF を送出しない限り、レート制限のキーは cloudflared 付与値（偽造不可）に依存する。
nginx 設定変更時は `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` を足す場合は要注意
（nginx 以降で信頼ホップ数の再調整が必要）。

## sqlite3@6 昇格の手順（回帰テストは完成済み）

現状 `npm audit --omit=dev`: critical 1（sqlite3@5 依存ツリーの tar）/ high 9 / total 21。
**`npm audit fix --force` をテストなしで実行しない（AGENTS.md）**

1. 本番 `data.db` と staging `data-test.db` を Web公開外・制限付きの場所へバックアップ。
2. ✅ 回帰テスト実装済み・**staging で 21/21 PASS（2026-09-24）**: `scripts/ops/regression-test.js`（`npm test` に接続）
   （notifications / subscriptions / scraper_status の INSERT/SELECT/lastID・UPSERT、
   `/api/health`、notify: tokenなし401 / HMACなし401 / 誤HMAC 401 / timestampなし401 / 期限切れ401 / 完全認証で `suppressed:true`、
   内部scraper-status認証、token-exchange 無効code 400、SSE 上限429）
3. staging だけで `sqlite3@6` を更新（`npm install sqlite3@6`）。
4. `node --check` → staging pm2 再起動 → **回帰テスト実行:**

```bash
node scripts/ops/regression-test.js --port 18099
```

5. staging 8081 で smoke（health / scraper-status / events）＋ブラウザ目視。
6. 受入後、作業者が**本番反映と `--update-env` 再起動を明示承認**。
7. 本番 `/api/health` 200 確認後、10分間 pm2 ログと通知失敗を監視。

注意: 回帰テストは一時DBを自分で作るので本番DBを触らない。ただし**本番(8080)ツリーで実行しない**
（Web公開ディレクトリ内に一時DBを作るため。staging 作業ツリーで実行すること）。

## innerHTML 棚卸し（2026-09-22 実施・主要ファイル）

- ✅ **修正済み**: `webui/js/rss-reader.js`（外部RSS → XSS可だった）
- ✅ **問題なし（esc/escapeHtml + URL検証済み）**: `weekly-schedule.js`（escapeHtml + `toSafeHttpUrl` で
  thumbnail/url を検証、`encodeURIComponent` 経由で data属性）、`admin-ai.js`、`twitter-media-dashboard.js`
  （`file_url` はサーバー生成の `/api/twitter-media/file/:id` のみ、tweet_text は escapeHtml）
- ⚠️ **要改善（低〜中リスク）**:
  - `historyService.js` lightbox（710-717行）: `data-media-url` 属性値をそのまま src に展開。
    値は自画面でサーバーから受けたもの（DBの `local_path` 由来はサーバー側で `/file/:id` 化済み）だが、
    `toSafeHttpUrl` 相当の検証を足すとより堅い。
  - `heatmap.js` / `notification-stats.js`: data-date/data-count は自前生成の数値・日付でJS-XSS実質不可。
    テンプレ文字列の内側に来る将来の変更には注意。
  - `admin-*.js` / `status-page.js`: 管理者のみ閲覧・管理API由来。esc使用済みが大半。
    今後外部入力を扱う場合は escapeHtml 経由に統一。
- 運用ルール: 新規コードで外部/DB由来の文字列を innerHTML に入れない（textContent か escapeHtml）。

## 2026-09-22 第2弾ハードニング（feature/sec-round2-20260922・本番未反映）

### 重大回帰の発見（HMAC必須化の送信側未追従）
- `/api/notify`/`/api/internal/twitter/analysis` はトークン＋HMAC必須だが、**全送信モジュールが未追随**。
- 実測（本番8080にライブプローブ）: 正トークン＋誤HMAC→401 Invalid、正トークン＋HMACなし→401 Missing。
  送信側コード（src/scrapers/twitter.js: `X-Notify-Token` のみ / main.js: `X-Signature` はAPIの受付ヘッダ `x-notify-hmac|x-hmac-signature` 外）は**必ず401になる**。
- ログ上は最後の再起動（2026-09-22 03:37JST）より前の成功行が残存して見えていただけで、
  以降は新着が無く送信試行ゼロのため失敗が可視化されていない（= 次の新着で静かに失敗する状態）。
- 本作業で修正: `src/core/notify-sign.js`（共通HMAC署名ヘルパー）を新設し、
  twitter/twitcasting/fanbox/youtube/bilibili/main.js の全送信を `X-Notify-Hmac`（生hex）に統一。
  **staging(8081) で実環境E2E確認済み**: 送信者形式のHMAC付与で `suppressed:true`(200)、
  HMACなしで401。`/api/internal/twitter/analysis` も同様に200/401を確認。

### その他の変更（本ブランチ・本番未反映）
| 対象 | 変更 |
|---|---|
| `package.json` | `"sqlite3": "^6.0.1"`（**staging で実体 npm install 済み・回帰テスト 19/19 PASS**、本番は承認後に反映） |
| `scripts/ops/backup.sh` | DB/.env の保存先を Web公開ツリー外 `/var/lib/mai-push/backups` へ移動（nginx deny 単一依存を解消） |
| `main.js` | ワーカー内 `/api/notify` を **fail-closed**（トークン未設定時 503、server.js と統一） |
| `server.js` | `trust proxy 1` → `"loopback"` に限定（同一ホスト前段のみ信頼、直結クライアントの XFF 偽造を無効化）。SSE送信元キーと同じ方針 |
| `server.js` | **helmet を全 static マウント（/pushweb /admin /webui）より前に移動**（従来は /pushweb・/admin が非防備だった） |
| `routes/notify.js` | `/api/internal/twitter/analysis` に `verifyNotifyHmac` を追加（旧: トークンのみ） |

### .env 重複キー除去（本番・staging 両方、2026-09-22 実施）
- `ADMIN_USERNAME` / `SESSION_SECRET` が2重定義（dotenv先頭勝ち）。両者の値は**同一**だったため後発行のみ削除。
- ⚠️ **`RAG_CHAT_MODEL` も重複し値が異なる**（dotenvは先頭勝ちのため 2 個目の値は無効）。
  実効値のまま据え置き（判断保留）。**モデル変更を試みた痕跡なら意図が反映されていない**ので要確認。
- 編集前ファイル: `~/.env.bak-dupkeys-20260922`（本番・staging 各自）。
- 注: .env はプロセス起動時読込のため、この編集の実効は次回の `pm2 restart --update-env` 時。

### staging の node_modules 構成変更（2026-09-22）
- 従来: staging の `node_modules` は本番への **symlink**（deploy-staging.sh が npm install を行わない前提）。
- 今回: staging の symlink を外し **実体 npm install（sqlite3@6）** に変更。以後 staging で依存を変える場合は
  `/home/yuzuki/koinoyamai.love-test` で `npm install` し、`package-lock.json` の反映分を本番ツリーでコミットする。

## 追加で残っているリスク

- [ ] **`RAG_CHAT_MODEL` の .env 重複**（値が不一致のまま。実効 = 先頭行）。どちらを採用するか要判断。
- [ ] `backup.sh` は `/var/lib/mai-push/backups` への移動を**反映済み**だが、サーバー側で
      `mkdir -p /var/lib/mai-push/backups` と旧 `$BASE/backups` の退避・cron 動作確認は未実施（承認後に実施）。
- [ ] SSE 429 時のクライアント挙動（EventSource 自動再接続）を実デバイスで一応確認。
- [ ] `services/context.js` の `LOCAL_API_TOKEN`（現環境変数 `LOCAL_API_TOKEN` のみ）を使う箇所が
      将来出たら、`NOTIFY_API_TOKEN` へ統一する。
- [ ] nginx `/api/` に将来 `X-Forwarded-For` を足す場合は trust proxy 設定を見直す（上記）。

## 補助ファイル

- `scripts/ops/regression-test.js`: sqlite3@6 昇格ゲート用回帰テスト（`--port` で起動ポート指定）。
- staging `.env` は `DISABLE_NOTIFICATIONS=1` 固定。**この設定を 1 に戻すな**。
- `/tmp/verify_sec.sh`・`/tmp/ensure_env.js` は旧セッションの補助スクリプト。実行前に内容と対象ポートを確認。

## YouTube Webhook（公開エンドポイント・2026-10-20）

- **公開 Drain**: `POST/GET https://koinoyamai.love/youtube-webhook`
  - PubSubHubbub の hub はインターネットから callback に到達する必要があるため公開する
  - **共有シークレット必須**: クエリの `token` が `YOUTUBE_WEBHOOK_TOKEN` と一致しない場合は **403**
    - 比較は `crypto.timingSafeEqual`（長さ不一致は短絡）
    - トークン未設定（fail-closed）でも 403
    - hub はカスタムヘッダーを付けられないため、クエリのみで受け付ける
  - 保護の補助: 受け付ける entry 数と動画ID形式（`^[A-Za-z0-9_-]{11}$`）を検証
  - nginx 側：该パスは `access_log off` かつ `error_log ... notice`
    （callback URL にトークンが含まれ、`$request` や debug レベルの error log に
    残ると秘密が漏れるため）
  - **注意**: `location` 単位の `error_log` では止まらない。nginx はルーティング前の
    http フェーズでリクエスト行を debug レベルで記録するため、**http レベルの
    `error_log` を debug 以上にしないことが必須**（2026-10-21 実測・適用済み）。
    漏れた場合は `bash ~/rotate-youtube-webhook-token.sh` でローテーションする
- **運用**: `AGENTS.md §6.8`（callback は公開 URL 必須・トークン必須・nginx 手順・検証手順）

## PHP ランタイム（php-fpm 8.3）— 2026-10-21 の緊急 RCE

### 何が起きているか

| 項目 | 内容 |
|---|---|
| CVE | **CVE-2026-109618 / CVE-2026-109619**（PHP コアの RCE） |
| 深刻度 | **CVSS v4.0 = 9.2（Critical）** |
| リリース | **2026-10-21 14:00 UTC = JST 23:00**（PHP チーム事前告知。embargo 泄露で 1 日前倒し） |
| 影響範囲 | 報告では **PHP 5 以降すべて**（公式 advisory の確定はリリース時） |
| 詳細 | **未公開**（リリース時に公開）。in-the-wild 悪用報告は 2026-10-21 時点でなし |
| リリース前の最新 | 8.2.34 / **8.3.35** / 8.4.26 / 8.5.11（いずれも 2026-09-24 版） |
| 今夜の修正版 | **8.3.36 相当**（各系列の次版）。**確定は ChangeLog-8.php で機械判定する**（`apply-php-security-patch.sh` が実施） |
| 出典 | php.net 事前告知 / CERT-EU 2026-018 / watchTowr FAQ / Ars Technica |

### 本サーバへの影響評価（2026-10-21 実測）

| 観点 | 実測 | 判定 |
|---|---|---|
| バージョン | `php8.3-fpm 8.3.6-0ubuntu0.24.04.12`（noble-security） | **未修正 → 影響あり** |
| 稼働 SAPI | **php-fpm のみ**（`php-cgi` バイナリ無し。apache2 はパッケージ未導入＝dpkg `un`・unit なし・非稼働。`/usr/sbin/apache2` に残骸バイナリは残る） | 攻撃面は nginx→FPM の HTTP のみ |
| 公開経路 | nginx :1717 / :80 ← cloudflared トンネル（`koinoyamai.love` → :1717、`test.koinoyamai.love` → :80）+ Cloudflare プロキシ | インターネットから到達可能 |
| アプリコード | `webui/*.php` 18 ファイル。`eval` / `unserialize` / 動的 include / `system` 系は**ゼロ** | アプリ層のトリガーは無い。リスクは PHP コア層 |
| hardening | `disable_functions` **空** / `open_basedir` **未設定** / `allow_url_fopen=On` / `expose_php=Off` / `display_errors=Off` | **RCE 成立後の被害は大きい**（任意コマンド実行・任意ファイル読み書きが可能） |
| 旧版 PHP | `php8.1-*` は**導入されていたが削除済み**（dpkg `rc`・設定だけ残存）。`masked` かつ inactive（upstream 8.1 は 2025-12-31 EOL → 修正は来ない） | 起動しなければ問題なし。追加の --------
削除は任意 |
| 自動更新 | `unattended-upgrades` enabled、`noble-security` 許可 | Canonical の USN 公開後に自動で入る（ただし数日かかる） |

### 適用手順

```bash
# 1) dry-run（root 不要）— upstream リリース状況・Ubuntu の candidate を確認
bash scripts/php/apply-php-security-patch.sh

# 2) 適用（sudo 必要）
sudo bash scripts/php/apply-php-security-patch.sh --apply          # Ubuntu archive に修正がある場合
sudo bash scripts/php/apply-php-security-patch.sh --apply --ppa    # Ubuntu 未投入の場合（ondrej/php PPA）

# 3) 検証
bash scripts/php/verify-php-security-patch.sh
```

- **判定は `php -v` で見ない。** Ubuntu は upstream の security パッチをバックポートするため、
  バージョン文字列は `8.3.6` のまま（`-0ubuntu0.24.04.NN` だけ上がる）。
  正しくは **Debian changelog に CVE ID が載っているか** で判定する（`verify-php-security-patch.sh` が自動化）。
- **upstream の修正版は `https://www.php.net/ChangeLog-8.php` から機械判定する**
  （リリース案内ページ `releases/8_3_XX.php` には CVE ID が載らない・URL も不安定）。
  判定するのは「CVE を含む**最小**の 8.3.x」（`>=` 比較の基準）。
  2026-10-21 時点: latest 8.3.x = 8.3.35（8.2=8.2.34 / 8.4=8.4.26 / 8.5=8.5.11）。今晚は 8.3.36 相当。
  ※ Ubuntu の `8.3.6-0ubuntu0.24.04.12` は 8.3.35 の CVE 11 件中 **10 件**をバックポート済みだが、
  upstream 8.3.32 の CVE-2026-12184 / 8.3.33 の CVE-2026-9672 / 8.3.35 の CVE-2026-17545（Windows 専用）は
  **未収録**。Canonical の USN を待つ運用ではこの差も考慮すること。
- **スクリプトは fail-closed。** upstream の修正版を検出できない・candidate が変わらない・
  シミュレーションに削除（Remv）が出る・シミュレーション自体が失敗する場合は
  **いずれも exit 1** で「完了」を出さない。
  `--force` は **upstream 判定（ChangeLog 取得失敗・HTML 構造変化）を飛ばす**ためだけの escape hatch で、
  Ubuntu に更新が無い場合は `--ppa` が必要になる。
- `apt-get upgrade`（全体）はしない。`php8.3-*` だけを `--only-upgrade` で上げる。
- 適用前のバージョンは `/var/lib/mai-push/php-rollback-<時刻>.txt` に記録（ロールバック手順つき）。
  ロールバックは dpkg の exact 依存（`php8.3-common (= 同版)`）のため**全パッケージを同版で指定**し、
  ダウングレード，所以 `--allow-downgrades` が必要。
- PPA（`--ppa`）は他パッケージ（`php8.1-*` 等）に影響しうるため、実行前に dry-run の
  シミュレーション出力を確認すること。**PPA 追加は恒久設定が残る**ため、戻す場合は:
  `sudo rm -f /etc/apt/sources.list.d/php.list && sudo apt-get update`
- ラッパ: `~/apply-php-security-patch.sh` / `~/verify-php-security-patch.sh`（本番ツリーを優先して実体を解決）。

### パッチ前の緩和策（2026-10-21 夜〜リリースまで）

詳細が未公開のため「トリガーの防止」はできないが、**成立後の被害拡大**は抑えられる。

1. `disable_functions` に `exec,system,shell_exec,passthru,popen,proc_open,pcntl_exec,dl` を追加
   → 任意コマンド実行の抑止（`/etc/php/8.3/fpm/php.ini`）
2. `open_basedir` を webui の docroot + `/tmp` + `/var/lib/mai-push` に限定 → 任意ファイル読み書きの抑止
3. nginx の PHP location に `limit_req` / `limit_conn` を追加
4. Cloudflare 側で一時的なレート制限 / WAF ルール追加（ダッシュボード操作）
5. `nginx access.log` と `/var/log/php8.3-fpm.log` の注視

### 監視・検知

- `verify-php-security-patch.sh` は git 管理外の `.php` 混入（webshell 简易チェック）と
  EOL 版 PHP の稼働も併せて確認する。
- 適用後は `journalctl -u php8.3-fpm -n 50` と `nginx access.log` を 10 分程度目視する。


---

## 脆弱性・更新の自動監視（security-watch）— 2026-10-21 追加

### なぜ作ったか

これまで PHP / Node.js / npm 依存 / OS パッケージの脆弱性は
**管理者が偶然チェックした時しか発見されなかった**。
特に 2026-10-21 の PHP コア RCE（CVE-2026-109618 / CVE-2026-109619）は
「誰かがタイムラインを見た」ことで対処できたが、
検知の主体は人であり、**運用の仕組みとして検知が成立していない**状態だった。

`scripts/security/security-watch.js` はこの状態を解消するため、
**日次 cron で 4 系統を機械判定し、新規に検出されたものだけを通知する**。

### 監視対象と判定方法

| 系統 | データソース | 判定 |
|---|---|---|
| Node.js | `https://nodejs.org/dist/index.json` | 導入版より新しいリリースに `security: true` があれば重大。`NODE_EOL` 表で EOL 判定 |
| PHP 8.3 | `https://www.php.net/ChangeLog-8.php` ＋ `/usr/share/doc/php8.3-fpm/changelog.Debian.gz` | upstream の CVE 集合 − Ubuntu 側 changelog の CVE 集合 ＝ 未バックポート。**バージョン比較はしない**（下記） |
| npm 依存 | `npm audit --json` | critical=重大 / high=警告 / moderate・low=情報 |
| OS パッケージ | `apt-get -s dist-upgrade` | `noble-security` pocket からの未適用更新 |

### PHP はバージョン比較では判定できない

Ubuntu は upstream のバージョン文字列（`8.3.6`）を固定したまま、
**Debian リビジョン**（`-0ubuntu0.24.04.12`）でセキュリティ修正をバックポートする。
そのため「導入版 < upstream 最新版」だけでは
**バックポート済みでも常に差分が出てしまう**。

正の判定は **CVE 集合の包含関係**で行う:

```
未適用 = {upstream 8.3.x（base より新しい）の CVE} − {Ubuntu 側 changelog に記載された CVE}
```

さらに、Ubuntu が遡及的に言及しない古い CVE で誤検出しないよう、
upstream 側の公開日が 365 日以内のものだけを対象にする。

> 実測（2026-10-21 / 導入版 `8.3.6-0ubuntu0.24.04.12`）:
> 未適用 3 件 = CVE-2026-12184（upstream 8.3.32）/ CVE-2026-9672（8.3.33）/ CVE-2026-17545（8.3.35, Windows 専用）

#### 365 日ウィンドウのトレードオフ

- 基準は「upstream の**リリース日**」（CVE の公開日ではない）。
- upstream が 1 年以上リリースしない／Ubuntu のバックポートが 1 年以上遅れる場合、
  該当リリースの CVE はまとめて対象外になる（= 見落とす可能性）。
- 誤検出（Ubuntu が言及しない古い CVE で大量警報を出す）を避けるためのトレードオフ。
  この問題を検知する手段として、「upstream 最新版リリース日 − 導入版」の乖離を
  warning として出す案がある（未実装）。

#### fail-closed

- upstream の取得・解析結果が空（ページ構造の変化や CDN 障害）は「対応済み」にしない。
  **監視失敗（error）**として扱い、`exit code 2` を返す。
- Ubuntu 側 changelog に CVE が 1 件も無い場合も同様に error（大量誤検出を防ぐ）。

### 通知経路

| 行き先 | 内容 | 備考 |
|---|---|---|
| Discord | 指摘の詳細（CVE ID・URL・パッケージ名を含む） | `DISCORD_BOT_TOKEN` / `DISCORD_CHANNEL_ID`（healthcheck.sh と同じ Bot API 方式） |
| 管理画面 / 公開 status ページ | **カテゴリと件数だけ** | `/api/internal/scraper-status` は**公開エンドポイント**なので CVE ID を流さない |
| 運用ログ | 全詳細 | `logs/security-watch-YYYYMMDD.log` |

### .alert fatigue 対策（重要）

- **初回は全件を通知しない**。ベースライン登録のみ（概要 1 通）。
  既に存在する指摘を一斉に鳴らすと通知が埋もれて本当に重要なものを見落とすため。
- 承受できる指摘は `--ack` で承認する。承認済みはサマリにだけ残り、通知対象外になる。
- 重大（critical）の指摘が 7 日以上続く場合は「継続中」として 1 回だけ再通知する。
- 検知できた項目は**再通知しない**（解消したら次の実行で状態から消える）。

### 運用コマンド

```bash
node scripts/security/security-watch.js --list                    # 現在の指摘と承認済み一覧
node scripts/security/security-watch.js --ack <key> --note "理由"  # 承認（以降の通知対象外）
node scripts/security/security-watch.js --unack <key>             # 承認解除
node scripts/security/security-watch.js --dry-run                  # 通知せず判定だけ
node scripts/security/security-watch.js --json                     # 判定結果を JSON
```

- 状態ファイル: `data/security-watch-state.json`（`/data` は gitignore 済み）
- 実行: `bash scripts/ops/security-watch-cron.sh`（cron は `30 4 * * *`）
- 解析ロジックのユニットテスト: `scripts/ops/regression-test.js` の `[9]`

### 検知と通知のみ（適用はしない）

`security-watch` は **検知と通知まで**を行う。
パッチインストール・`npm update`・pm2 の再起動は**行わない**（§5.2）。
適用は人が判断して行う。PHP の適用手順は上記の「PHP ランタイム」節を参照。

### 監視そのものが壊れていないか

判定できなかった項目は「正常」ではなく **監視失敗（fail-closed）** として扱い、
`exit code 2` を返す。外部 API の一時的な障害で「正常」と誤判定しない
（php.net の CDN は時折 504 を返すため、リトライを入れる）。

---

## 未バックポート PHP CVE の対応方針（2026-10-21 決定）

security-watch が検出した、upstream には修正版があるのに **Canonical（Ubuntu）側が
バックポートしていない** PHP 8.3 の CVE 3 件:

| CVE | upstream 修正版 | 備考 |
|---|---|---|
| CVE-2026-12184 | 8.3.32 | |
| CVE-2026-9672 | 8.3.33 | |
| CVE-2026-17545 | 8.3.35 | Windows 専用（当サーバは Linux なので影響なし） |

### 方針: **A. Canonical のバックポートを待つ**（ondrej/sury PPA は導入しない）

- ondrej/sury PPA には `php8.3-fpm 8.3.35-1+ubuntu24.04.1+deb.sury.org+1` があり、
  3 件すべてを含むことは確認済み。
- しかし **第3者 APT リポジトリの恒久追加**になるため導入しない
  （他パッケージ（php8.1 系等）への･影響と恒久設定が残ることを許容できない）。
  導入した場合の戻し方: `sudo rm -f /etc/apt/sources.list.d/php.list && sudo apt-get update`
- Canonical がバックポートすると `php8.3-*` が security pocket に現れ、
  security-watch の `os:security:php8.3-fpm` がそれを検出する。
  適用後は PHP 側の指摘も自動的に解消扱いになる（監視が検知する）。
- ⚠️ **CVE-2026-109618 / CVE-2026-109619（PHP コア RCE・CVSS v4.0 9.2）は別件**。
  upstream の修正版が 2026-10-21 23:00 UTC（JST 23:00）にリリースされる予定で、
  `scripts/php/apply-php-security-patch.sh` がその 2 件を対象にしている。

### 待つ間の実行時緩和策（`~/apply-php-hardening.sh` で適用）

1. `disable_functions = exec,system,shell_exec,passthru,popen,proc_open,pcntl_exec,dl`
   → Web 経由の任意コマンド実行を止める
2. `open_basedir = <本番docroot>:<staging docroot>:/tmp:/var/lib/php/sessions:/var/lib/mai-push`
   → 任意ファイル読み書きを止める

適用前の確認（いずれも grep で実測）:

- `webui/*.php` は exec 系関数を使わない（0 件）
- `webui/*.php` は絶対パスを参照しない（require は `/head.php` 等の相対のみ）
- `webui/*.php` はファイルに書き込まない（`file_put_contents` 等 0 件）

### ⚠️ nginx のレート制限は適用しない

上の緩和策案に含れていた「nginx の PHP location に `limit_req` / `limit_conn`」は
**適用するとサイト全体を壊す**ため行わない。

実測（2026-10-21）:

- この nginx には **real_ip 設定が無く**、アクセスログの送信元は**全件 127.0.0.1** になっている
  （cloudflared がローカル接続している）。
- したがって IP 単位のレート制限は**全ユーザーまとめて絞る**ことになる。
- レート制限を入れるなら先に real_ip を設定する必要がある:
  Cloudflare の IP レンジを `set_real_ip_from` に追加し、
  `real_ip_header CF-Connecting-IP;` / `real_ip_recursive on;` を http ブロックに設定する。
- RCE の主防御は `disable_functions` / `open_basedir` であり、
  レート制限は主防御ではない。

### 併せて適用する OS の security pocket 更新（`~/apply-os-security-updates.sh`）

`ca-certificates` / `liblzma5` / `xz-utils` / `libprotobuf32t64` / `python3-jwt` の 5 件。
**apt-get upgrade 全体はしない**（google-chrome / tailscale / cloudflared / xserver-* まで
巻き込まれ、PHP や nginx の版まで変動する恐れがあるため）。対象は security pocket のみに限定する。
再起動が必要なサービス（openssl / systemd / nginx / libc6）は今回の更新に含まれない。

## 旅先ディスプレイ（`/display/`・2026-10-21 追加）

- **公開パス**: `https://koinoyamai.love/display/`（読み取り専用の静的ページ）
- サンフランシスコ旅行中にまいちゃんの予定・通知と**現地/日本の時刻**を確認するためのもの。
  実体とビルド元は private リポジトリ `gonzaresu-jp/smart-display`。
- **セキュリティ上の要点**:
  - 同一オリジン配信にしてあり、画面は `/api/...` を絶対パスで叩く
    （API の CORS 許可オリジンが `koinoyamai.love` 等に限定されているため）。
    **別オリジン（GitHub Pages 等）に置くとブラウザがブロックする。**
  - nginx の Location に `add_header` を**書かない**ことで server レベルの
    CSP / X-Frame-Options / HSTS 等を継承させている（`AGENTS.md §11`）。
  - 認証・secret は一切使わない。表示する情報は公開 API（`/api/history` / `/api/history/stream`（SSE）/
    `/api/events/weekly`）のみで、書き込み系 API には触れない。
  - 配置先は `/var/www/html/smart-display/`（git 管理ツリー外・644/755）。
    git 管理ツリーに入れると `check-drift.sh` の「未コミット変更」で引っかかる。
- 適用: `sudo bash scripts/nginx/apply-display-location.sh --apply`（冪等・fail-closed）

### 公開 PHP ページの隔離（メンテナンスモード）

- **何をするか**: `sudo bash scripts/nginx/apply-maintenance.sh --on` で、**公開 PHP ページへの
  到達を nginx 側で 503 にする**（`location ~ \.php$ { error_page 503 /__maintenance.html; return 503; }` を
  server ブロックの開き括弧直後に入れて、既存 `location ~ \.php$` より先にマッチさせる）。
- **なぜ**: CVE-2026-109618 / CVE-2026-109619（CVSS v4.0 9.2・**詳細未公開**）は回避策が不明なため、
  CERT-EU の推奨（パッチが間に合わない場合は公開アプリを隔離する）に従う。
- **止まるもの**: PHP で描画される公開ページのみ。
  **止まらないもの**: API（`/api/`）・ワーカー・**通知（push）**・静的ファイル。
  → 通知は届き続け、デスクトップアプリも通常どおり動く（Node 側は PHP コアの影響を受けない）。
- **注意**:
  - `location = /status.php` のような**完全一致** location は regex より優先される。
    対象 vhost（1717 / staging）には無いが、増加する場合は確認すること。
    elza vhost（:80）の旧 PHP は別 PR #50 の `scripts/nginx/apply-php-exec-guard.sh` で 404 化する。
  - メンテナンスページは **サイト既存の `/error/`**（`webui/error/index.html`・静的 HTML）。
    別途ファイルを配置しないため権限の問題は発生しない（PHP も実行しない）。
- **復旧**: `sudo bash scripts/php/patch-and-resume.sh`（パッチ適用 → パッチ状態のみ検証 →
  メンテナンス解除 → pm2 再開 → 最終確認）。検証の途中でサイトの応答を期待しないこと
  （メンテナンス中は 503 が正しい。`verify-php-security-patch.sh --patch-only` を使う）。
