# AGENTS §11 コーディング/設計規約

> `AGENTS.md` から分割した詳細（§番号は AGENTS.md と共通）。索引と必読ルールは リポジトリ直下の `AGENTS.md`。

## 11. コーディング/設計規約（最小限・事故に直結するもの）

> 網羅的なスタイル規約ではない。「破ると事故る」ものだけ。迷ったら既存コードに倣う。

- **TZ は `Asia/Tokyo` 固定**: `server.js` / `main.js` 冒頭で `process.env.TZ = ... "Asia/Tokyo"`。
  日時はこれ前提（naive `new Date()` の解釈・曜日配置）。実行環境の TZ に依存させるな。
- **bind は `127.0.0.1`**: API/ワーカー内 Express は loopback 限定（前段 nginx/cloudflared 経由）。
  例外は YouTube Webhook(3001) のみ（外部フックのため 0.0.0.0 のまま）。**安易に広げるな**。
- **dotenv は環境ディレクトリ固定**: `require("dotenv").config({ path: path.join(__dirname, ".env") })`。
  path 無しの `config()` は staging が本番 `.env` を読む事故になる（`§6.6`）。`.env` の重複キーは先頭勝ち（`§3`）。
- **`/admin` は `login.html` のみ静的配信**。認証コード（admin.js/webauthn.js）は `lib/` に置く（ソース露出防止, `§6.6`）。
- **webui は CSP `script-src 'self'`**: インライン JS 不可 → 新規 JS は `webui/js/*.js` に置き
  `?v=<?= @filemtime(...) ?>` で読込。基本スタイルは非 minify 側（`css/*.css` 等）に。`style.min.css` に入れても効かない。
- **通知送信は `src/core/notify-sign.js` 経由**: `signNotifyPayload(secret, bodyString)` で**送信する生 JSON 文字列**に署名し
  `x-notify-hmac` + `x-notify-timestamp` を付与（`§3`, `§6.5`）。API 側は生ボディで検証・`timingSafeEqual`。`==` 比較に戻すな。
- **fail-closed**: トークン/秘密が未設定なら認証系は 503/401 で閉じる（通すな）。
- **外部入力は型と上限を検証してから使う（2026-10-23 追加）**: 共通ヘルパは **`lib/validate.js`**
  （`str` / `num` / `bool` / `enumOf` / `arr` / `objKeys` / `httpUrl` / `publicHttpUrl`・依存ゼロ・`ValidationError` を投げる）。
  - 検証は **認証・HMAC 検証の後**に置くこと（前に置くと認証バイパスになる）。
  - 実害の中心は「例外が出る」ことではなく **静かな失敗**。例: `/api/notify` の `data.title` が
    数値だと sqlite3 のバインドがエラーになり、**記録も送信もされないまま `success` を返す**。
    そこで違反は **400 で原因を返す**（`§5.2` の「壊れても気づけるように」と同じ考え方）。
  - **未知キーは弾かない**（新フィールドを足すだけで既存経路を壊さないため）。既知フィールドの
    **型と上限だけ**を検証する。上限は既存クライアントを妨げない値にする
    （現行: `data.title` 500 / `data.body` 4000 / URL 系 2048 / `type`・`settingKey` 50）。
  - 適用済み: `routes/notify.js`（`/api/notify` の `data`・`/api/internal/twitter/analysis` の長さ）、
    `lib/admin.js`（ログイン入力・同名ヘッダが**配列**で来た場合）。
  - **SSRF 対策（push エンドポイント）**: web push は**クライアントが指定した URL へサーバーが POST する**。
    `routes/subscriptions.js` の登録時と `services/notification.js` および `src/core/milestone.js` の
    **送信直前**の 3 箇所で `publicHttpUrl()`（http/https かつ**公開ホスト**）を検証する。
    拒否: loopback / private / link-local（`169.254.169.254` 含む）/ multicast / broadcast /
    Tailscale（100.64/10）/ `localhost`・単一ラベル・`.local` 等。IPv6 は `URL.hostname` が
    **角括弧付き**で返すので括弧を外し、**nibble 列**で判定する（`geoip.isPrivateIp` は圧縮表記しか見ない）。
    **IPv4-mapped の 16 進表記（`[::ffff:a9fe:a9fe]`）は IPv4 として判定する**（数え違えるとメタデータが素通り）。
    ⚠️ **非 http（デスクトップアプリの `webview2://` 等）は従来どおり受理する**
    （送信時にスキップされ HTTP は一切飛ばない。400 にすると WinUI 版が壊れる）。
    ⚠️ 残る限界: ホスト名が公開 IP に**解決されるか**までは見ない（DNS rebinding）。
    本番の登録 7 件は影響 0 件（http 5 件＝公開 push サービス 3 ホスト / 残り 2 件は `webview2://` の偽＝ガードより先にスキップ）。
    - **送信前の DNS 解決検証（2026-10-24・issue #76）**: `lib/push-endpoint-guard.js`（`pushGuard.check()`）
      が **送信直前**に `dns.promises.lookup(..., { all: true })` で解決し、**すべての解決先**が
      `isRoutableHost` を通らなければ**送信しない**（`services/notification.js` と `src/core/milestone.js` の
      2 送信経路すべて。`webpush.sendNotification` より前であることを回帰テスト [17] で固定）。
      - 上の「残る限界」は**これで解消**（ホスト名の文字列検証だけでは塞げない DNS rebinding を遮断）。
        実測: `fcm.googleapis.com` / `updates.push.services.mozilla.com` / `web.push.apple.com` は許可、
        `127.0.0.1` に解決する FQDN は `non-public-ip(::1)` で拒否。
      - **fail-closed**: 解決不能（ENOTFOUND）・時間切れ（既定 3 秒）も**拒否**する。拒否は
        `console.warn("[push-guard]", {reason, host, addresses})` で可視化（黙って消さない）。
      - **既存の登録行は削除しない**（404/410 の削除とは別経路）。DNS 一時障害で端末の受信能力を失わせない。
      - 30 秒の DNS キャッシュ（既定。`PUSH_GUARD_CACHE_TTL_MS`）と並行呼び出しの束ね込みあり。
      - **`PUSH_GUARD_DISABLED=1` で無効化できる**が、無効化すると issue #76 の経路が復活する。
        既定は**有効**（回帰テストで「無効化は opt-in であること」を固定）。設定したら必ず戻す。
        - ⚠️ **無効化インスタンスは「実際に `check()` を呼んで動く」こと**を回帰テストで固定する
          （2026-10-24 レビュー指摘 B-1: 判定関数をクロージャ内に置いていたため無効化時に
          `ReferenceError` となり、**例外が握りつぶされて全通知が黙って全滅**する状態だった）。
      - env のチューニング（`PUSH_GUARD_CACHE_TTL_MS` / `PUSH_GUARD_TIMEOUT_MS`）も回帰テストで確認。
      - タイムアウトのタイマーは **`unref` しない**（unref だと「lookup が返ってこない」ときに
        イベントループが空になりプロセスが静かに抜ける＝2026-10-24 実測）。代わりに **finally で必ず `clearTimeout`** する。
      - 接続先の pin は**不可**（web-push は独自エージェント）。検査で閾値を上げるのが目的。
  - 併せて実施: `/api/android/send-test` に 5 回/分のレート制限（**無認証の FCM リレー化**を防ぐ）と
    `deviceName` の型・上限検証 / OAuth エラー応答を `text/plain`（クエリを HTML にしない）/
    YouTube webhook の不正 `published`（`new Date` は Invalid Date でも truthy → 24 時間フィルタを素通り）/
    `routes/rag.js` の transcript 取得 `video_id` を書式検証 + `encodeURIComponent`。
  - 追加するときは `npm test` の `[14]` に「違反 → 400」「未知キーは通す」「内部宛は拒否」の両方を固定すること。
- **型は TypeScript を入れずに `// @ts-check` + JSDoc で持つ（2026-10-23 判断）**:
  - **全面移行しない**。`webui/js`（13k 行）はバンドラー無しの直配信（CSP `script-src 'self'` +
    `?v=filemtime`）、`scripts/`（6.5k 行）は cron が `NODE_BIN` で `node` 直実行、
    `pi-vector-service` は 32bit Pi 向け依存ゼロ実装。ビルドステップを増やすと
    「配信バイト == ディスクのバイト」（`§7.1`）と `check-drift` の前提が崩れる。
  - 導入済み: `src/core/notify-sign.js` / `lib/admin.js` / `lib/validate.js` / `services/geoip.js`。
    **回帰テストが `@ts-check` の存在と「TypeScript を依存に入れていない」を固定している**。
  - 検証は開発時のみ `npx -p typescript tsc --noEmit --allowJs --checkJs --skipLibCheck`（依存は追加しない）。
    `@types` を入れていないのでモジュール解決エラー（`TS2307`）は出るが、それ以外は実エラー。
    引数の型違いは実際に検出される（2026-10-23 実測 3 件）。
- **PHP は「読まない・実行しない」を原則にする（2026-10-21 追加・`§5.1`）**:
  - **`$_POST` / `$_FILES` / `$_REQUEST` を読む PHP を書かない**。
    php-fpm は `enable_post_data_reading=Off`（pool の `php_admin_value`）で
    **POST ボディを読まないようにしている**＝multipart パーサ層（PHP コア RCE の入口）が動かない。
    POST が必要になったら「`enable_post_data_reading` を緩める」ではなく、
    **Node API（`:8080`）側に受け皿を作る**（API は JSON parsed 済みで検証も書ける）。
  - **`mb_*`（mbstring）を直接呼ばない**。mbstring は未導入（未バックポート CVE-2026-6104 の回避）。
    UTF-8 の長さ・検索は `webui/_mb.php` の `mai_utf8_len()` / `mai_utf8_strpos()` を使う。
  - **`eval` / `system` / `exec` / `shell_exec` / `unserialize` / 動的 include を書かない**。
    `disable_functions` / `open_basedir` は**多層防御の1枚**であり、アプリ層も無害で保つこと。
  - この 3 条件は **回帰テスト [10]** で機械的に検査される（`npm test`）。
- **検知経路は状態を報告する（壊れても気づけるように）**: 通知・検知の主要な経路は
  `POST /api/internal/scraper-status`（`x-notify-token`）へ状態を報告し、
  管理画面（`GET /api/scraper-status`）と Discord で確認できるようにする。
  2026-10-20 に「PubSubHubbub の webhook が 18 日間死んでいた」ことを後から見つかったのは、
  壊れていることを示す仕組みが無かったため（`AGENTS.md §6.8`）。
- **秘密情報をコミットしない**: `.env`・鍵・cookie 等。`.gitignore` 済みでも `git add -A` に注意。
- **DB 書込ロック耐性**: SQLite は `busy_timeout`/`timeout` を設定し、長時間書込はリトライ（nassy `§8` の load 由来）。
  - 接続は `db.configure("busyTimeout", 5000)` を設定する（`services/database.js` 以外も全部）
  - **コールバックなしの `db.run()` はエラーでプロセスを落とす**
    （node-sqlite3 は Statement の 'error' イベントを emit し、リスナが無ければ uncaught exception になる）。
    `services/db-guard.js` が Database.prototype に既定のエラーコールバックを差すので、
    これを require している（`server.js` / `main.js` / `services/context.js`）。
    **新しい DB 実装でも require を忘れないこと**
- **ネイティブビルドは Node v24 優先**: 全プロセスが v24.22.1（`§5`）。
  ビルドと実行の Node を揃えること（別の版でビルドして別の版で実行すると ABI 不一致）。
  `PATH` は `~/.nvm/versions/node/v24.22.1/bin` を先頭に置く。
- **nginx の `add_header` は Location に 1 つでもあれば server レベルを継承しない（2026-10-21 実測）**:
  - 公開 vhost は Cache-Control / Pragma / Expires を Location ごとに書いていたため、
    server レベルに置いていた **CSP / X-Frame-Options などが PHP 配信ページ（サイトの本体）
    から全く出ていなかった**（クリックジャッキング無防備・CSP による XSS 緩和なし）。
  - 対処: 共通スニペット `scripts/nginx/templates/snippets/mai-security-headers.conf.tmpl` を
    `/etc/nginx/snippets/mai-security-headers.conf` に置き、**自前の add_header を持つ
    Location から include する**。include 済みの状態は各 vhost のテンプレートに
    取り込み済みで、変更はテンプレート編集 → `scripts/nginx/deploy.sh` で反映する
    （旧 `apply-security-headers.py` は退避済み）。
  - ⚠️ **スニペットを配置せずに設定を差替えると `nginx -t` が失敗してサイト全体が止まる**。
    `deploy.sh` は生成一式（スニペット含む）を検証してから配置するので順序は保たれる。
  - **CSP は現時点で `script-src 'unsafe-inline'` を含める**（2026-10-21 headless Chrome で
    11 ページ実測）:
    - webui にはインライン `<script>`（`index.php` の Google Fonts 読み込みなど）と
      **インラインハンドラ（`onclick=` 等 15 箇所）**があり、
      `script-src 'self'` / `script-src-attr 'none'` だと
      **全ページのログイン/ログアウトボタンと週次ナビゲーションが動かなくなる**（実測）。
    - 外部 JS は `cdnjs.cloudflare.com`（wave.php の pixi.js）と `unpkg.com`
      （test.php の lottie-player）を使うため許可している。
    - **future work**: インライン script / ハンドラを `webui/js/*.js` へ外部化し、
      `script-src 'unsafe-inline'` を外す。`§11` の「webui は CSP `script-src 'self'`」の
      最終形。対象一覧は `scripts/nginx/templates/snippets/mai-security-headers.conf.tmpl` のコメントを参照。
    - CSP を変更するときは **headless Chrome で 11 ページの実測**を必ず行う
      （`grep -c "<script>" webui/*.php` だけでは判定できない）。
  - **Node API へ proxy する Location は include しない**（API 側は helmet が同等のヘッダを返す。
    二重になると CSP が intersection になる）。
  - **新しい Location を追加したら include 漏れを確認すること**（`curl -I` で実ヘッダを見る）。
  - ⚠️ **HSTS は Cloudflare 側で `max-age=0` に上書きされている**（実測）。
    origin のヘッダはブラウザに届かない。エッジ側で有効化するには
    Cloudflare ダッシュボードの Edge Certificates → HTTP Strict Transport Security を変更する。
- **nginx の IP 単位のレート制限は使えない（2026-10-21 実測）**:
  この nginx には **real_ip 設定が無く**、アクセスログの送信元が**全件 127.0.0.1** になっている
  （cloudflared がローカル接続している）。IP 単位の `limit_req` / `limit_conn` は
  **全ユーザーまとめて絞る**ことになるので公開ページには入れない。
  - 入れるなら先に real_ip を設定する（Cloudflare の IP レンジを `set_real_ip_from` に追加し、
    `real_ip_header CF-Connecting-IP;` / `real_ip_recursive on;` を http ブロックに置く）。
  - **Express 側のレート制限は実クライアント IP 単位**で正しく機能している
    （`trust proxy = "loopback"` + nginx が X-Forwarded-For を渡すため `req.ip` が復元される）。
- **アップロードサービス（`/var/www/html/upload`・本リポジトリ外）**:
  - **`UPLOAD_KEY` のゲートは無効（2026-10-22 ユーザー判断）**。`/var/www/html/upload/.env` の
    `UPLOAD_KEY=` は空。tailnet 限定（nginx の allowlist）で二重防御は不要と判断された。
    値を入れても構文は壊れないが、`~/upload-key.txt` は削除済み。
    キーを設定すると `server.js` の `if (!UPLOAD_KEY) return next();` でゲートが有効化され、
    401 ページ（`?key=…`）が出てブラウザに Cookie（30日）が残る。
  - **保存拡張子は許可リスト制**（画像/動画/音声/PDF のみ）。クライアント申告の拡張子を
    そのまま使うと `.html` を名送出せて media ドメインで stored XSS になりうるため。
  - 外部からは到達できない（`/etc/nginx/media.conf` の `location / { return 403; }`）だが、
    アップロード UI は LAN/Tailnet のみ（`192.168.1.72` の server に allowlist）。
  - **Discord 専用 scope（`?scope=discord`）は ID が 128bit**（`crypto.randomBytes(16)`）。
    通常の media scope は 32bit のまま（公開メディアなので無意味）。
    理由は下の「Discord 専用メディア」項の「UA 判定は防御にならない」ため
    （推測不能な URL ＝ capability URL にする）。
- **Discord 専用メディア（`/dmedia/`）の保護 — 4 層**
  1. **到達経路は tunnel のみ**（2026-10-22 実測で確定）:
     `discord.honna-yuzuki.com` の DNS は CNAME で cloudflared tunnel（`mai` トンネル）を指し、
     tunnel のリモート設定にも `discord.honna-yuzuki.com → http://localhost:80` がある。
     origin の `:80` はインターネットから到達できない（access.log の全 rotation 約30万行で
     peer は `127.0.0.1` / LAN / Tailscale のみ）。
     ⚠️ **`/etc/cloudflared/config.yml` のローカル ingress は使われていない**
     （tunnel にリモート設定があるとそちらが優先される。cloudflared のログの
     `ingressRule=4` が「リモート設定の 4 番目 = koinoyamai.love」を指すのが証拠。
     ローカル設定の 4 番目は catch-all で `http_status:404`）。
     → 路由を変更したいときは **API（`~/.cloudflared/cert.pem` のトークン）でリモート設定を編集**する。
  2. **nginx 側でも tunnel のみに限定**（`/etc/nginx/discord.conf` の `location ^~ /dmedia/`）:
     `allow 127.0.0.1; allow ::1; deny all;` を入れる。cloudflared は 127.0.0.1 から接続するため
     経路は確保される。allow/deny は `scripts/nginx/templates/discord.conf.tmpl` に
     取り込み済みで、変更はテンプレート編集 → `scripts/nginx/deploy.sh` で反映する
     （旧 `apply-dmedia-tunnel-only.sh` は退避済み）。
     **2026-10-22 適用済み**（PR #70 / 反映確認: 公開URL+Discordbot=200 / 通常UA=403 /
     localhost=200 / LAN IP=403 / LAN `/upload/dmedia`=403）。
     バックアップは `/etc/nginx/discord.conf.bak-dmedia-tunnel-only-*`。
  3. **UA 判定は「防御」ではなく、og:video 経由でのみ使う（2026-11-07 復旧）**:
     `if ($http_user_agent !~* "Discordbot") { return 403; }` は UA をクライアントが自由に
     設定できるため、`curl -A "Discordbot"` で取得できてしまう（実測: 200 / 実ファイル）。
     2026-11-07 に直リンク .mp4 配信ではインライン再生が壊れること（Discord 上の再生は
     Discordbot UA ではなく Firefox 風 UA で来て 403）が実測され、一旦 UA 判定を外した。
     しかし「URL を知っていれば誰でも直接見れる」状態になったため、**og:video ページ
     （`/watch/<id>`）経由に戻した**。`/dmedia/` の UA 制限は og:video 経由のときだけ
     有効（Discord は og:video をプロキシ再生するため origin から来るのは
     Discordbot UA だけ）。
     → 実保護は **URL 側の 128bit ランダム ID**（1 と同じ「推測不能な URL」方式）。
     `/etc/nginx/discord.conf` で Discordbot UA 制限を復活済み（`/watch/`・`/thumb/`
     のロケーションも追加）。`/dmedia/` のアクセスは
     `/var/log/nginx/dmedia.log`（dmediafmt・UA 入り）に記録される。
  4. **upload サービス側でも Host を照合する**（2026-10-22）:
     nginx の LAN/Tailnet 用 vhost（`location ^~ /upload/` → `proxy_pass http://127.0.0.1:3100/`）は
     パス置換で `/upload/dmedia/xxx` を `/dmedia/xxx` にしてしまう → そのままでは
     **LAN から Discord 専用メディアを読めてしまう**（独立レビューで発覚）。
     そこで upload サービスが `/dmedia` の **Host** を照合する
     （`DISCORD_PUBLIC_BASE_URL` の host 以外は 403）。
     discord vhost は `proxy_set_header Host $host` で `discord.honna-yuzuki.com` を渡す。
  5. **Discord への共有は og:video ページ（`/watch/<id>`）を使う（2026-11-07 復旧）**:
     Discord 公式仕様でタグ経由のインライン動画プレイヤーを確実に出すのは HTML + OGP。
     upload サービス `GET /watch/<id>` が `og:type=video.other` + `og:video` +
     `twitter:card=player` を持つ HTML を返し、`GET /thumb/<id>.jpg` が og:image
     用のサムネイル（ffmpeg で 1 フレーム、初回は自動生成）を返す。
     `/dmedia/*.mp4` には Discordbot UA 制限を復活させてある。
     → Discord bot のプロキシ再生のみが通る。ブラウザの直リンク（`.mp4` を直接開く）は
     403 になる（URL 共有で見れる状態にはならない）。
     ※ Discord へ渡すべき URL は `/watch/<id>`（`GET /api/list` の `watchUrl` も参照）。
  - 教訓: 「tunnel 経由」はルーティング設定だけでは保証にならない。
    **origin の listen を 127.0.0.1 限定にするか、nginx で許可リストを入れる**こと。
    **nginx の別 vhost が同じ upstream にパス置換で繋いでいたら、そこも封鎖が必要**。

