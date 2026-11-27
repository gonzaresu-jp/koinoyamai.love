# AGENTS §6.5〜6.9 反映記録・bind・admin/Tailnet・YouTube Webhook・旅先ディスプレイ

> `AGENTS.md` から分割した詳細（§番号は AGENTS.md と共通）。索引と必読ルールは リポジトリ直下の `AGENTS.md`。

## 6.5 第2ラウンド反映（2026-09-22、本番昇格済み main @ fb4449f）
- **HMAC 送信側は `src/core/notify-sign.js`（`signNotifyPayload`）で統一済み**。`/api/notify` へ送る
  コードを書くなら必ず `X-Notify-Hmac`（生hex）を付けること。`X-Signature` は API 側で読まれない。
  ※ 2026-09 の HMAC 必須化直後は全送信モジュールが未追随で、実は next-new-content で401する状態だった（修正済み）。
- `/api/internal/twitter/analysis` もトークン + HMAC 必須（`src/scrapers/twitter.js` 送信側は同期済み）。
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
- 回帰テストは `npm test`（scripts/ops/regression-test.js、HMAC v2＋timestamp検証＋YouTubeフィード補助ロジック＋webhookトークン検証を含む 281 項目・2026-11-09 時点）に接続済み。
- pm2-logrotate 導入済み（20M・10世代・圧縮）。

## 6.7 admin は Tailnet 専用（2026-10-10 追加）
- **管理画面の正規エントリは `https://elza.poitou-mora.ts.net/admin.html`（tailscale serve・tailnet のみ・自動認証）**。
  公開ドメイン `koinoyamai.love` の `/admin`・`/admin.html`・`/admin/login/` は **ts.net へ 302 リダイレクトが仕様**
  （Ctrl+K パレットのショートカット用。`/api/admin` は **403** のまま）。
  （nginx: `allow 192.168.0.0/16` + `100.64.0.0/10` で deny 時に `error_page 403 = @to_elza_*` → 302。
  cloudflared 由来の loopback はリダイレクト。**302/403 を障害と誤診しないこと。**）
  LAN/Tailnet 直撃は従来通りローカル配信（tailscale 停動時の保険）。
  elza vhost は tailscale serve の受け皿（`127.0.0.1` 許可）＋
  webui 静的配信（`/css/`・`/js/admin-`・fontawesome）付き。
- **旧ドメイン `mai.honna-yuzuki.com`（nginx :1700）は全パス301で `koinoyamai.love` へ集約（2026-10-19、例外なし）**。
  旧 `/api`・`/auth`・`/dl`・`/pushweb`・`/admin` の例外は撤廃（旧アプリは非対応／新ドメインへ誘導）。
- LAN 保険: `http://192.168.1.72:1717/admin/login/`（旧 `:1700` は全301のため `:1717` を使用。WebAuthn は http 非対応のためパスワードのみ）。
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
- **まいAI チャット（`/chat.html`・`/chat.js`・`/icon.webp`・`/icon-192.webp`）も elza vhost では tailnet/LAN 限定（2026-11-06 追加）**:
  `location = /admin.html` と同じ allowlist（`127.0.0.1` / `::1` / `192.168.0.0/16` / `100.64.0.0/10`）で
  webui を root にする `location` を追加する。
  適用は `sudo bash scripts/nginx/apply-mai-chat-elza.sh --apply`（dry-run なら引数なし・冪等）。
  これが無いと elza vhost の root（`/var/www/html`）に chat 系ファイルが無く
  **admin.html の「まいAI チャットを開く」が 404** になっていた（2026-11-06 実測）。
  `/css/chat.css`・fontawesome・`/api/admin/chat/*` は既存の location（`/css/`・fontawesome・`/api/admin`）で配信される。

### 6.8 YouTube Webhook（PubSubHubbub）

- **callback URL はインターネットから到達できる公開 URL であること**
  - hub（`pubsubhubbub.appspot.com`）は callback を検証してから購読する。
    tailnet 専用 URL（`elza.poitou-mora.ts.net`）だと検証が 504 → 購読が 409 で失敗し、
    **webhook 経路が静かに死ぬ**（2026-10-20 実測: 最終配信 2026-10-02、購読は恒久失敗）。
    検知は RSS / プレイリスト経路だけに依存していた
  - 公開 callback は `https://koinoyamai.love/youtube-webhook?token=<YOUTUBE_WEBHOOK_TOKEN>`
- **トークンで保護する（必須）**
  - `YOUTUBE_WEBHOOK_TOKEN` が未設定なら webhook は **fail-closed（403）**。
    公開に晒す以上、トークン無しでは第三者に通知を撃たせない
  - hub は callback URL に `hub.mode` / `hub.challenge` 等を**追記**するため、
    クエリの `token` はそのまま維持される
- **nginx には公開 vhost 用のプロキシが必要**
  - 適用は `sudo bash ~/apply-youtube-webhook.sh --apply`（dry-run なら引数なし）
  - 適用後は `curl -i 'https://koinoyamai.love/youtube-webhook?hub.challenge=TEST'`
    が **403**（トークンなし）であること。200 なら保護が漏れている
- **購読は「成功から12時間ごと、失敗していれば30分後」に再試行する**
  - 3 日周期だと hub の一時障害で最長3日そのまま続き、検知が RSS 経路に依存し続ける
  - hub への負荷を抑えるため平时は12時間、失敗時だけ30分に短く再試行する
  - さらに main.js の 03:00 毎日更新（`subscribeAllChannels`）でも補充される
- **購読失敗は明示的に警告する**（`購読リクエスト成功/失敗` を件数付きでログ）。
  以前はこの失敗がログに埋もれて 18 日 unnoticed だった
- **検知の冗長経路（RSS + Data API プレイリスト）を必ず残す**
  - `docs/ARCHITECTURE.md §3.2`。webhook が死んでも配信開始を取りこぼさない

#### 適用手順（この順でやる。順序を誤ると購読が 409 になる）

```bash
# 1) トークンを生成して本番 .env に追記（.env は gitignore 済み）
#    ※ .env は「重複キーは先頭勝ち」なので、既存キーのある場合は追記しない
ENV=/var/www/html/koinoyamai.love/.env
grep -q '^YOUTUBE_WEBHOOK_TOKEN=' "$ENV" || \
  printf 'YOUTUBE_WEBHOOK_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$ENV"

# 2) ワーカーを再起動（トークンはモジュール読み込み時に読む）
#    先に再起動して fail-closed（403）にしてから nginx を開く
pm2 restart mai-push-worker --update-env

# 3) nginx の公開ルートを適用（hub からの到達経路が無いと購読は失敗する）
sudo bash ~/apply-youtube-webhook.sh          # dry-run
sudo bash ~/apply-youtube-webhook.sh --apply  # 適用（backup 付き・nginx -t 済み）
```

#### 検証（保護と正常系の両方）

```bash
# 保護: トークンなし → 403
curl -i 'https://koinoyamai.love/youtube-webhook?hub.challenge=TEST'
# 正常系: トークンあり → 200 + challenge がそのまま返る
TOKEN=$(grep '^YOUTUBE_WEBHOOK_TOKEN=' /var/www/html/koinoyamai.love/.env | cut -d= -f2)
curl -i "https://koinoyamai.love/youtube-webhook?hub.challenge=TEST&token=$TOKEN"
# 購読の成否（成功 2/2 が出れば復旧）
pm2 logs mai-push-worker --lines 50 | grep '購読リクエスト成功\|成功 [0-9]/'
```

- `PUBLIC_URL` は `https://koinoyamai.love` であること（未設定なら同値にフォールバック）。
  別の値だと callback が別のホストを指し、購読は 409 になる
- nginx のアクセスログにトークンが残らないよう、`/youtube-webhook` は `access_log off` にする
  （`$request` にクエリ文字列が含まれるため）
- **⚠️ `location` 単位の `error_log` では止まらない（2026-10-21 実測）**
  - nginx は**ルーティング前の http フェーズ**でリクエスト行を debug レベルで記録するため、
    `location` に `error_log ... notice` を入れても**リクエスト行（?=トークン）が error.log に残る**
  - 必須は **http レベルの `error_log` を debug 以上にしないこと**
    （`error_log /var/log/nginx/error.log notice;` にする。debug のままだと全リクエストの
    クエリ文字列が平文で残り、ログも肥大する。2026-10-21 適用済み）
  - 漏れたトークンは**ローテーションする**（`bash ~/rotate-youtube-webhook-token.sh`）。
    ログをローテートしただけでは、漏出済みトークンは有効なまま
- 補助スクリプト（`~/` に置いている）:
  - `apply-youtube-webhook.sh` … 公開ルートの適用（dry-run / 適用。冪等・失敗時は自動復元）
  - `verify-youtube-webhook.sh` … 復旧確認（403 / 200+TEST / 購読 2/2 / ログ非漏出）
  - `rotate-youtube-webhook-token.sh` … トークンローテーション（.env 差し替え→再起動→再購読）
  - `fix-nginx-token-leak.sh` … http レベルの error_log を debug→notice ＋ ログローテート（sudo）

### 6.9 旅先ディスプレイ（`/display/`）— 2026-10-21 追加

- **https://koinoyamai.love/display/** = サンフランシスコ旅行中に
  まいちゃんの予定・通知と**現地（America/Los_Angeles）と日本（Asia/Tokyo）の時刻**を
  確認するための静的ページ。対象端末は Surface Pro 5（2736×1824 / 3:2）。
- **実体とビルド元は別リポジトリ**（private `gonzaresu-jp/smart-display`）。
  成果物は `/var/www/html/smart-display/` に置き、nginx の
  `location ^~ /display/ { alias /var/www/html/smart-display/; index display.html; }` で配信する。
  - nginx の location 追加: `sudo bash scripts/nginx/apply-display-location.sh --apply`
    （`display-location.conf` が実体。冪等・fail-closed・`nginx -t` 失敗時は自動復元）
  - 資産のビルド・配置: smart-display リポジトリの `bash scripts/deploy-display.sh --apply`
    （`npm run build:display` → rsync → 644/755）
- **同一オリジンで配信するのが要点**:
  - 画面は `/api/...` を**絶対パス**で叩く（`API_BASE = ''`）。
    API の CORS 許可オリジンは `server.js` の `allowedCorsOrigins`（`koinoyamai.love` /
    `test.koinoyamai.love` / `PUBLIC_URL` / localhost 系）に限られるため、
    **別オリジンで配信するとブラウザがブロックする**。
    同一オリジン配信にすることで **CORS 許可オリジンの変更が不要になる**
    （許可オリジンへ追加する運用も可能だが、公開オリジンを増やす avoidable なので採らない）。
  - `add_header` を Location に**書かない**ことで server レベルの CSP 等を継承させる（`§11`）。
- **git 管理ツリーに入れない**: 配置先を `/var/www/html/smart-display/`（リポジトリ外）に置くと、
  本番ツリーが dirty にならず `check-drift.sh` に引っかからない。
- ⚠️ **API の `start_time` はタイムゾーン表記が混在している**
  （`"2026-10-18T23:45:51"` = JST naive / `"...Z"` = UTC）。
  素の `new Date(str)` はブラウザのローカル TZ で解釈され**現地では16時間ずれる**。
  smart-display 側は `parseServerTime()` で「オフセット無ければ JST (+09:00)」に統一している。
  新しい画面を作るときは**必ず `Intl.DateTimeFormat` の `timeZone` を明示**する
  （端末の TZ 設定に依存させない）。

