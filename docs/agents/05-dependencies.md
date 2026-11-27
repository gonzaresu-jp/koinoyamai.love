# AGENTS §5 依存関係・PHP ランタイム・security-watch・ハニーポット

> `AGENTS.md` から分割した詳細（§番号は AGENTS.md と共通）。索引と必読ルールは リポジトリ直下の `AGENTS.md`。

## 5. 依存関係
- **sqlite3 は 6.0.1 に昇格済み（2026-09-22 本番反映）**。npm audit critical は解消。
  依存を触る際は必ず staging で「実体 node_modules の npm install → 回帰テスト（`npm test`） → smoke」を通すこと。
- **依存更新の反映は `scripts/deploy/npm-deploy.sh` で行う（2026-10-21 追加）**:
  - `git pull` は **package-lock.json しか更新しない**。node_modules が旧版のままでは
    「lockfile 上は安全 / 実際のコードは脆弱」という食い違いが起きる。
    `npm audit` も lockfile 基準なので、**この乖離を放置すると security-watch が
    「critical 解消」と誤報する**（偽の安全感）。
  - `bash scripts/deploy/npm-deploy.sh`（dry-run）→ `--apply` で乖離を検出・修正する。
    pm2 を停止 → `npm install` → 乖離とモジュールのロードを検証 → 再起動、まで自動。
    失敗時は lockfile を git から戻して復旧する。
    - **停止したアプリは EXIT の trap で必ず再起動する（2026-10-23 追加）**:
      依存更新の反映時に、**ロード確認が exit 1 して再起動前にスクリプトが終了**し、
      **本番 3 プロセス（`mai-push-api` / `mai-push-worker` / `discord-bot`）が止まったまま**
      になった（実測）。`trap ... EXIT` を入れ、検証失敗・構文エラー・中断（Ctrl+C）でも
      再起動するようにした。**停止後は再起動経路が trap のみ**であることを確認すること。
    - **ロード確認は firebase-admin v14 / puppeteer v25 の API を検査する**:
      `require("firebase-admin").messaging`（名前空間 API）は **v14 で `undefined`**。
      この古い検査が残っていると **更新が成功しても必ず exit 1 になる**（上記の事故の原因）。
      `firebase-admin/app` の `initializeApp` / `getApps` / `cert`、
      `firebase-admin/messaging` の `getMessaging`、`puppeteer.launch` を検査する。
      依存のメジャーを上げたら**このスクリプトと CI の `.github/workflows/ci.yml` の
      smoke も同時に更新する**（2026-10-23 は CI の smoke も同じ箇所で赤になった）。
  - `npm ci` は node_modules を全削除するため**本番では使わない**（レジストリ障害時に
    依存ごと無くなる）。`npm install` を使う。
  - **乖離判定は `scripts/deploy/check-node-modules-drift.js`（全パッケージ比較）に集約**（2026-10-24）:
    `npm-deploy.sh` の install 判定と `check-drift.sh` の `[3.5]` が同じヘルパを使う。
    lockfile の全 `node_modules/*` をディスクの `package.json` と照合し、
    **exit 0=乖離なし / 10=乖離あり / 1=判定不能（fail-closed）**・0 件なら無出力。
    optional / dev / peer は「無くてよい」が、**必須の欠損は報告**する。
    ※ 以前は固定 9 パッケージ（`proxy-addr` 等）だけを見ていたため、`body-parser` / `qs` /
    入れ子 `undici` の更新を「乖離なし」と誤判定し install をスキップした（2026-10-24 実測）。
    監視対象を列挙する方式は依存を足すたびに漏れるので、**新規に固定リストを足さないこと**。
    判定不能（lockfile 破損・ヘルパ不在）は install も再起動もしない（回帰テスト [16] で固定）。
  - `check-drift.sh` は `package-lock.json` の md5（`[3]`）と上記ヘルパ（`[3.5]`）で乖離を検出する。
    `--quiet`（cron）でも **乖離・判定不能は stderr に残す**（`notice()`。無言で死なせない）。
- **2026-10-21 の依存更新（npm audit fix・force なし）**:
  | パッケージ | 変更 | 備考 |
  |---|---|---|
  | proxy-addr | 2.0.7 → 2.0.8 | **critical 解消**（express の trust proxy 経由の IP スプーフィング） |
  | undici | 7.22.0 → 7.30.1 | high 解消（利用は cheerio 経由のみ。`globalThis.fetch` は Node 内蔵） |
  | follow-redirects | 1.16.0 → 1.16.1 | high 解消 |
  | @fastify/busboy | 3.2.0 → 3.2.3 | high 解消 |
  | sharp | 0.35.4 → 0.35.5 | libvips 1.3.3 → 1.3.4。ネイティブ再ビルド |
  | esbuild | 0.28.0 → 0.28.2 | patched 版 |
  | **firebase（クライアント SDK）** | **削除** | **未使用だった**（Node 側は firebase-admin のみ。webui は gstatic の CDN 版）。削除で advisory 3 件と推移 45 パッケージが消えた |
  | gaxios | 6.7.1 → 6.3.0 | **ダウングレード**。gaxios 6.4.0+ が脆弱な uuid を依存し 6.x に修正版が無いための意図的な pin 解決 |
  - 監査結果: **total 28 → 17**（critical **1 → 0** / high 18 → 10 / moderate 7 → 6 / low 2 → 1）
  - 残 17 件のうち **16 件を 2026-10-23 に解消**（下記。残るのは `@simplewebauthn/server` の low 1 件）。
- **2026-10-23 の依存更新（direct 2 件のメジャー更新を含む）**:
  | パッケージ | 変更 | 備考 |
  |---|---|---|
  | ip-address | 10.7.2 → 10.7.4 | moderate 解消（GHSA-rxp7-6hxx-x8q5・IPv6 ゾーンIDの二次時間 DoS）。非破壊 |
  | **firebase-admin** | 12.7.0 → **14.5.0** | high 2 + moderate 5 解消。node-forge / `@google-cloud/*` の多くが推移から消える |
  | **puppeteer** | 24.43.1 → **25.16.0** | high 8 解消（Chrome 156.0.8078.47）。`@puppeteer/browsers` 3.x で extract-zip / proxy-agent / basic-ftp / get-uri / pac-proxy-agent が消える |
  | **puppeteer-extra / puppeteer-extra-plugin-stealth** | **削除** | **コード参照 0 件**（`src/scrapers/ytcommunity.js` のコメントのみ）。v3.3.6 は puppeteer 25 非対応 |
  - 監査結果: **total 17 → 1**（critical 0 / high 0 / moderate 0 / low 1）。残るのは
    `@simplewebauthn/server` の low 1 件（GHSA-6hxq-p678-4hr2・attestation 連鎖の検証。
    `lib/webauthn.js` は `attestationType: 'none'` なので該当経路を使っていない）。13.3.3 への更新は別途。
  - ⚠️ **firebase-admin v14 は名前空間 API を廃止した**（`admin.messaging` / `admin.credential.cert` が
    `undefined` になる。2026-10-23 実測）。`services/notification.js` は `firebase-admin/app` の
    `initializeApp` / `getApps` / `cert` と `firebase-admin/messaging` の `getMessaging` を使う。
    **v12 の書き方に戻すと FCM 初期化が静かに失敗し、Android への push が 0 件になる**（ログは
    `FCM init failed: ...` なので気づきにくい）。
  - ⚠️ **puppeteer v22 以降で `browser.isConnected()` は廃止**（`browser.connected` プロパティ）。
    未修正だと `TypeError: browser.isConnected is not a function`。`page.waitForTimeout()` も廃止
    （`src/scrapers/gipt.js` は `typeof` 判定で `setTimeout` にフォールバックしている）。
  - 依存を上げたら **`allowScripts` の pin も更新する**（`puppeteer@24.43.1` の stale な pin は削除し
    `puppeteer@25.16.0` に差し替え）。`npm install-scripts ls` が
    「No packages with unreviewed install scripts」であることを確認する。
  - Chrome の実体は共有キャッシュ `~/.cache/puppeteer/chrome/linux-<ver>/`。**旧版の Chrome を消すと
    ロールバックできなくなる**ので、ディスクが厳しいとき以外は残す（puppeteer の postinstall は
    既にキャッシュがあればダウンロードしない＝本番デプロイでネットワークに依存しない）。
  - ⚠️ **puppeteer 25 は ESM のみで、Node 22.12 未満では `require()` が `ERR_REQUIRE_ESM` で即死する**（puppeteer の engines は `>=22.12`、firebase-admin 14 は `>=22`）。`main.js` はスクレイパー経由で `src/core/browser.js` を**最初に読み込む**ため、interpreter を間違えると**ワーカーだけ起動不能**になる（API は動く＝部分障害で気づきにくい）。`ecosystem.config.js` の `interpreter` を絶対パスで明示すること（§5 冒頭）。
  - **コードと依存は同時に反映する**（`scripts/deploy/npm-deploy.sh --apply`）。今回のように API 移行を
    伴う更新を片方だけ反映すると、起動しない／静かに壊れる。
- **2026-10-24 の依存更新（security-watch が当日検出した high 2 件を即日修正）**:
  | パッケージ | 変更 | 備考 |
  |---|---|---|
  | body-parser | 2.3.0 → 2.4.0 | high 解消（GHSA-27r3-jxmh-p828・圧縮リクエスト本体の後ろの余分なバイト列による DoS）。`express@5.1.0` が `^2.2.0` を要求しており範囲内＝非破壊 |
  | undici（入れ子 3 箇所） | 6.28.1 → 6.29.1 | **high 1 + moderate 1** 解消（GHSA-xjj6-f33q-929c = 過大な content-encoding でエラー未処理 / **high**、GHSA-4qv8-2p9j-2685 = EventSource パーサのメモリ無制限 DoS / **moderate**。npm はパッケージ単位で最大深刻度を採るため `undici` は high と表示される）。`discord.js` / `@discordjs/rest` / `node-gyp` の入れ子。親の要求は `^6.27.0` / `^6.25.0` で範囲内。**ルートの `undici@7.30.1`（cheerio 経由）は元から脆弱範囲外** |
  - 連鎖更新: **qs 6.16.0 → 6.16.1**（body-parser 2.4.0 が `qs: ^6.16.1` を要求）。advisory は無く、parse/stringify の不具合修正。
    このほかのノードは変化なし（追加・削除 0 件。`node_modules` は公開 tarball とバイト一致を確認）。
  - `npm audit fix`（**--force なし**）で解消。監査結果 total 3 → **1**（残るのは `@simplewebauthn/server` の low 1 件のみ）。
  - 検証: staging で実 `npm install` → `npm test` 245 passed → staging API 再起動して `/api/health` 200・`/api/notify` が **plain も gzip も 401（認証で停止＝body パースは正常）** → **マージ後**に本番で `scripts/deploy/npm-deploy.sh --apply`（pm2 停止→`npm install`→ロード検証→再起動）で反映する（`git pull` だけでは node_modules は旧版のまま残る）。
  - ⚠️ `npm audit fix --force` は `@simplewebauthn/server@14.0.3` への**メジャー更新**を提案するが、`lib/webauthn.js` は attestation 経路を使っておらず low のため**実行しない**。
  - security-watch の cron は **04:30**（06:30 は check-drift）。**04:30 より後に公開された advisory は翌朝 04:30 まで通知されない**（実例: 2026-10-24 の本 2 件は JST 05:53 / 07:13 公開）。疑わしい時は `node scripts/security/security-watch.js --dry-run` で再判定する（通知・状態更新はしない）。
- **`npm audit fix --force` は禁止**。npm の `fixAvailable` は信用せず、
  ダウングレード提案（例: `firebase` → 9.14.0）はセキュリティ後退なので却下する。
- **Node.js は v24.22.1 に統一（2026-10-21 反映）**。全プロセスで同じ版を使う。
  - v24.22.1 は **2026-10-21 リリースの security release**（CVE-2026-105481/105482/105483/106069/106073/106074/111497
    + OpenSSL 3.5.9 / NSS 3.131.1 / c-ares 1.34.9 / timezone 2026e / undici 7.30.1）。
  - API（`mai-push-api` / `mai-push-api-test`）/ ワーカー（`mai-push-worker` / `mai-push-worker-test`）/
    `discord-bot` = **v24.22.1**（`ecosystem.config.js` の `interpreter` で**全プロセス明示指定**）
  - systemd `pi-vector.service` = v24.22.1（`~/.config/systemd/user/pi-vector.service` の `ExecStart`）
  - **pm2 デーモン（God Daemon）も v24.22.1 にする**（systemd `pm2-yuzuki.service` の
    `Environment=PATH` の先頭に nvm の bin を追加してある。`pm2 resurrect` で起動する daemon の Node）。
    ※ daemon の Node はアプリの実行 Node には影響しない（全アプリが `exec_interpreter` の絶対パスを保持）が、
    **interpreter 未指定で追加したプロセスが PATH 解決で EOL 版を掴むのを防ぐ**ため揃える。
  - **パッチ版の移行は `scripts/deploy/migrate-node-patch.sh` を使う**（`--from` / `--to` 指定可）。
    `~/migrate-pm2-daemon-node24.sh` / `~/migrate-other-apps-node24.sh` は **v24.22.0 固定で古い**ので
    参照先にならない（_patch 版の適用は本リポジトリ内のスクリプトで統一する_）。
    - 本リポジトリ4本（`mai-push-api` / `mai-push-worker` / `discord-bot` / `mai-push-api-test`）は
      `ecosystem.config.js --only`、他5本は `--interpreter` 明示で起動。
      1本ずつ移行し `/proc/<pid>/exe` とポート応答を検証、失敗したアプリだけ旧版へ戻す。
    - **リポジトリ外**（root 必要・別手順）: systemd `pm2-yuzuki.service` の PATH /
      `pi-vector.service` の ExecStart / `/opt/hitori-twitter/hitori-twitter.service` の ExecStart /
      `/var/www/html/upload/ecosystem.config.js` の interpreter。
      移行スクリプトの完了メッセージに残作業の一覧が出る。
  - **他プロジェクト（fcpass / air-monitor / hitori-twitter / squiish / upload-file）も v24.22.1 に統一（2026-10-21）。**
    同じ pm2 デーモンが管理している別プロジェクト。git 管理外・ネイティブモジュールなし
    （express / multer / qrcode / cors / serve のみ）なので、応答バイト数が一致することを
    確認済み。移行は `scripts/deploy/migrate-node-patch.sh`（本リポジトリ内・dry-run → `--apply`）。
    - `fcpass` :7080 / `air-monitor` :3131 / `hitori-twitter` :3333 / `squiish` :5000 / `upload-file` :3100
    - `upload-file` は `/var/www/html/upload/ecosystem.config.js` を持つ（interpreter も更新済み・バックアップあり）
    - `squiish` は `npm run serve` を起動するため **pm2 の exec は npm 本体**（`.../v24.22.1/bin/npm`）。
      `DEV_PORT=5000` を引き継ぐこと
    - `/opt/hitori-twitter/hitori-twitter.service` は systemd 未導入のテンプレート unit だが、
      `ExecStart` が `/usr/bin/node`（v18 EOL）参照のままだったので v24.22.1 に更新済み
  - cron 実行スクリプト（`update-subscribers-and-commit.sh` / `minutes-gen-cron.sh`）= v24.22.1（`NODE_BIN` で固定）
  - CI（`.github/workflows/ci.yml`）= `node-version: '24'`
  - **過去の既定値（process ごとのバージョン違い）は 2026-10-21 に廃止した。**
    当時は API=v22.12.0 / ワーカー・discord-bot=v20.18.1(EOL) / cron=`/usr/bin/node`=v18.19.1(EOL) と
    3 世代混在していた（`interpreter` 未指定のプロセスは nvm alias に依存していた）。
- **Node の EOL を、手作業で追わないこと**（Node 20 は 2026-04-30 EOL、22 は 2027-04-30 EOL、24 は 2028-04-30 EOL）。
  新しい LTS が出たら v24 系から一段上げて追従する。**26 は 2026-10-28 に LTS 化**するため、それまでは本番採用しない。
- **`interpreter` を省略してはいけない**（既定 node = nvm alias に依存すると、alias を変えた時に
  プロセスごとに版が混在する）。cron も同じく `PATH` 依存は禁（cron の PATH は `/usr/bin/node`=v18 を掴む）。
- **`exec_mode: 'fork'` も省略してはいけない（2026-10-21 実測）**:
  pm2 の **cluster モードでは `interpreter` が無視され**、pm2 デーモン自身の Node で動く。
  実測: `mai-push-worker-test` が cluster になり、`interpreter` に v24.22.0 を指定しているのに
  `/proc/<pid>/exe` が `/usr/bin/node`（v18.19.1）になっていた（`pm2 describe` は v24 を指すので**嘘**）。
  - 判定は必ず実プロセスで確認する: `ls -l /proc/<pid>/exe`（実体）か `pm2 jlist` の `node_version`。
    `pm2 describe` の interpreter 欄だけでは信用できない。
  - `interpreter` を変えたときは `pm2 delete <name>` してから `pm2 start ecosystem.config.js --only <name>`
    （既存定義とのマージで exec_mode が cluster のまま残ることがある）。
- **`interpreter` を変えたら `pm2 save` まで実行すること（2026-10-21 実測・最重要）**:
  systemd の `pm2-yuzuki.service` は `pm2 resurrect` で **`~/.pm2/dump.pm2` から復元する**。
  dump が古いままだと、**再起動後に旧 interpreter（=EOL 版 Node）で Processes が復活する**
  （エラーも出ないため静かに巻き戻る）。
  - 実測: v24 へ更新した直後、dump は `mai-push-worker`/`discord-bot` → `interpreter: "node"`
    （= PATH 解決で `/usr/bin/node` v18.19.1）、`mai-push-api` → v22.12.0 のままだった。
  - `pm2 jlist`（実行中プロセス）だけを見て「OK」と判断していたが、**dump とは別物**。
  - `scripts/deploy/restart.sh` は `pm2 save` と `/proc/<pid>/exe` 検証を内包している
    （`npm run restart:all` / `promote.sh` も同じ経路）。手動で pm2 を触ったときは**必ず `pm2 save`**。
- **`pm2 start ecosystem.config.js`（--only なし）は全アプリを起動する**:
  `mai-push-worker-test` は常時停止運用（x.com 等への負荷）なので、対象を `--only` で明示する
  （`scripts/deploy/restart.sh` の `all` は本番3プロセスだけを対象にしている）。
- ネイティブモジュール（sqlite3 / bcrypt / sharp / esbuild）は N-API のため v22 でも v24 でもロードできる（実測済み）。
  **パッチ版（v24.22.0 → v24.22.1）も同一の `NODE_MODULE_VERSION`（napi 10 / modules 137）で互換**（実測済み）。
  ただし**ビルドと実行の Node を揃える**こと（major/minor を跨ぐ場合は再ビルドが必要）。
  ネイティブモジュールをビルドする際は `PATH` を v24 優先にして `npm install` すること。
- **`package.json` の `allowScripts` を触らないこと**（npm 11 の install script 許可リスト）。
  Node 24 同梱の npm 11 は install script を「警告のみ」で実行するが、将来の Phase 2 で
  unreviewed な package の script をブロックする。sqlite3 / bcrypt は N-API だが **install script 無しでは
  ビルドされない**ため、approving 済みであることを維持する（`npm install-scripts ls` で未承認 0 を確認）。
  依存を追加/更新したら `npm install-scripts approve <pkg>` を実行する（**既定は version pin**。
  version を pin しているので、依存を更新したら承認も更新する:name-only で許可すると
  未レビュー版の install script が自動許可されてしまうため）。
- `package-lock.json` は Git 管理対象。除外するな。`npm audit fix --force` は回帰テスト通過後にのみ。
  ※ npm 11 は lockfile を正規化する（extraneous / optional peer の削除だけ）ことがあるが、
  **依存バージョンの差分は出さない**。差分が出た場合は `git checkout -- package-lock.json` で戻すこと。

### 5.1 PHP ランタイム（php-fpm）
- **PHP は 8.3 系（Ubuntu 24.04 の `php8.3-fpm`）**。`webui/*.php` の配信 SAPI は **php-fpm のみ**
  （`php-cgi` バイナリ無し。apache2 はパッケージ未導入＝dpkg `un`・unit なし・非稼働。
  `/usr/sbin/apache2` に残骸バイナリは残るが web サーバーとしては動いていない）。
  nginx は `/run/php/php8.3-fpm.sock` を向く
  （`scripts/nginx/mai-test.conf` / 本番 `/etc/nginx/nginx.conf`）。
- **PHP コアの緊急 RCE 期間の対応（2026-10-21 追加）**:
  - CVE-2026-109618 / CVE-2026-109619（CVSS v4.0 9.2・**詳細未公開**）は回避策が不明なため、
    CERT-EU の推奨（「パッチが間に合わない場合は公開アプリを隔離する」）に従い、
    **公開 PHP ページへの到達を nginx 側で 503 にする**。
  - 適用: `sudo bash scripts/nginx/apply-maintenance.sh --on`（解除は `--off`）。
    include は server ブロックの開き括弧直後（＝既存 `location ~ \.php$` より前）に入る。
  - **止まるのは PHP 配信のページだけ**。API（`/api/`）・ワーカー・通知（push）・静的ファイルは
    止まらない（＝通知は届き続け、デスクトップアプリも動く）。
  - ⚠️ **`location = /status.php` のような完全一致 location は regex より優先される**。
    該当 vhost（1717 / staging）には無いが、追加する場合は確認すること。
    elza vhost（:80）の旧 PHP（`location = /henkan/henkan.php` 等）は完全一致のため本スニペットでは
    止まらない。**別 PR #50 の `scripts/nginx/apply-php-exec-guard.sh`** で 404 化する
    （elza vhost は Cloudflare トンネル対象外・tailnet 限定のため攻撃面は限定的）。
  - **upstream 版（sury）で運用している間の監視**:
    `scripts/php/check-ubuntu-backport.js`（cron 35 4 * * *）が
    **Ubuntu の CVE トラッカーが示す修正版**と **noble-security の実在版**を突き合わせ、
    Ubuntu 版へ戻せるようになったら通知する。
    ※ security-watch の PHP チェックは「インストール済み changelog に CVE があるか」で判定するため、
    sury 版を入れている間は **Canonical のバックポートを検知できない**（この監視が補完）。
  - **パッチ適用後の復旧は `sudo bash scripts/php/patch-and-resume.sh` 1 本**
    （パッチ適用 → パッチ状態のみ検証 → メンテナンス解除 → pm2 再開 → 最終確認）。
    ※ 検証は `verify-php-security-patch.sh --patch-only` で行う（メンテナンス中は
    サイトの応答が 503 なので、200 を期待する通常モードでは必ず失敗する）。
  - **メンテナンスページはサイト既存の `/error/`**（`webui/error/index.html`・静的 HTML）を使う。
    自前のページを別途配置しないため、www-data の読み取り権限の問題（読めると 404 に
    フォールバックする実測あり）も発生しない。503 のページは PHP を実行しない。
    ※ 適用スクリプトの本文チェックは先頭数文字で判定しない（title に届かず偽の失敗になる）。
- **未バックポートの CVE は「Canonical のバックポートを待つ」方針（2026-10-21 決定）**:
  - security-watch が検出した未適用 3 件:
    **CVE-2026-12184**（upstream 8.3.32）/ **CVE-2026-9672**（8.3.33）/ **CVE-2026-17545**（8.3.35・Windows 専用）
  - **この3件**（CVE-2026-12184 / 9672 / 17545）は未バックポート。
    upstream には修正版があるが **Canonical（Ubuntu）側のバックポートは未リリース**。
  - **ondrej/sury PPA の扱い（2026-10-21 決定）**:
    通常は**導入しない**（第3者 APT リポジトリの恒久追加・他パッケージへの影響があるため）。
    ただし **upstream の修正版が既に出ていて Canonical のバックポートが追いつかない場合**
    （CVE-2026-109618 / 109619 がこのケース）は、**緊急時に限り** upstream 版を入れる。
    - 適用: `sudo bash scripts/php/apply-php-security-patch.sh --apply --ppa`
      （`scripts/php/patch-and-resume.sh --ppa` なら復旧まで一連）
    - 入れる版: upstream の最新 security 修正版（2026-10-21 時点では **8.3.36**）
    - **戻る手順**: `sudo bash scripts/php/rollback-to-ubuntu-php.sh --apply`
      - ⚠️ **`apt-get install --only-upgrade php8.3-fpm` だけでは動かない**
        （upstream 版 8.3.36 > Ubuntu 版 8.3.6-0ubuntu0.24.04.13 なので「すでに最新」で止まる）。
        **バージョンを明示**し `--allow-downgrades` が必要。
      - 設定ファイルの保持（実測 2026-10-22）:
        `/etc/php/8.3/fpm/pool.d/www.conf` = **dpkg の conffile**
        → `-o Dpkg::Options::="--force-confold"` でローカル版を保持
        `/etc/php/8.3/fpm/php.ini` = **ucf 管理**（`/var/lib/ucf/registry`）
        → `--force-confold` は**効かない**。`UCF_FORCE_CONFFOLD=1` を併せて渡す
        → 降格後に `apply-php-hardening.sh --apply` でハードニングを**再適用**する
        （ucf が php.ini を置換していた場合の保険）
      - 戻す前に **ターゲット版に修正CVEが入っているか**を changelog で機械確認する
        （入っていない版へ戻すと RCE が再導入される）。
    - ⚠️ **ロールバックすると upstream 比でカバレッジが 3 件落ちる**（実測 2026-10-22）:
      `CVE-2026-12184` / `CVE-2026-17544` / `CVE-2026-17545` は upstream 8.3.36 では
      修正済みだが **Ubuntu .13 の Debian changelog 基準**では未収録。
      ただし **PPA 導入前（.12）でも同じく未修正**で、ベースライン比では
      109618/109619 のみ改善している＝Accepted Risk。
      - 参照基準が 2 つあるので区別する:
        **upstream ChangeLog-8.php 基準**（security-watch の PHP 判定）= 12184 / 9672 / 17545
        **Debian changelog 基準**（Ubuntu パッケージの收录）= 12184 / 9672 / 17544 / 17545 が不在
      - 17544 は upstream 側リストに元々入っていない＝doc drift（Ubuntu 側 changelog には無い）
    - **Canonical がバックポートをリリース済み**（2026-10-22 実測）:
      `php8.3-common 8.3.6-0ubuntu0.24.04.13`（noble-security）に
      "SECURITY UPDATE: Remote RCE via state corruption issue"（= CVE-2026-109618/109619）が含まれる。
      → **PPA 依存は解除できる**（`scripts/php/rollback-to-ubuntu-php.sh --apply`）。
    - 記録: `updatelogs.php` には「サーバーの実行環境（PHP）を更新した」として記載する
  - 待つ間は **実行時緩和策**を適用する（下記 `scripts/php/apply-php-hardening.sh`）。
    Canonical がバックポートしたら `os:security:php8.3-fpm` が security-watch に
    現れ、適用後に PHP の指摘が解消される（監視が自動で検知する）。
  - ⚠️ **CVE-2026-109618 / 109619（PHP コア RCE・CVSS 9.2）は別件**。
    upstream の修正版が 2026-10-21 **14:00 UTC（JST 23:00）** にリリースされる予定で、
    `scripts/php/apply-php-security-patch.sh` はその 2 件を対象にしている（現在 fail-closed）。
- **nginx の PHP location へのレート制限（limit_req / limit_conn）は適用しない（2026-10-21 実測）**:
  - この nginx には **real_ip 設定が無く**、アクセスログの送信元は**全件 127.0.0.1** になっている
    （cloudflared がローカル接続している）。
  - そのため IP 単位のレート制限は**全ユーザーまとめて絞る**ことになり、**サイト全体を壊す**。
  - レート制限を入れるなら先に real_ip を設定する必要がある:
    Cloudflare の IP レンジを `set_real_ip_from` に追加し、
    `real_ip_header CF-Connecting-IP;` / `real_ip_recursive on;` を http ブロックに設定する。
  - RCE の主防御は `disable_functions` / `open_basedir`（下記）であり、
    レート制限は主防御ではないため、real_ip 未設定のまま入れる意味はない。
- **PHP の実行時緩和策（適用済み・`scripts/php/apply-php-hardening.sh` で再適用可）**:
  - `disable_functions = exec,system,shell_exec,passthru,popen,proc_open,pcntl_exec,dl`
    （`webui/*.php` はこれらの関数を使わない＝grep で 0 件。任意コマンド実行を止める）
  - `open_basedir = <本番docroot>:<staging docroot>:/tmp:/var/lib/php/sessions`
    （**`/var/lib/mai-push` は含めない**：RCE 成立時にベクトルDB や archive を読まれないようするため）
    （PHP は絶対パスを参照せず＝require は /head.php 等の相対のみ、書き込みもなし）
  - `ffi.enable = preload`（既定値も preload。**実行時に `FFI::cdef()` が拒否される**ことを実測確認。
    `disable_functions` の迂回経路を塞ぐ。`ffi.enable=true` に変えるな）
  - **`enable_post_data_reading = Off`（pool の `php_admin_value`）**:
    PHP は既定で `enable_post_data_reading=On` のため、**リクエスト開始時に POST ボディを必ずパースする**
    （multipart パーサの層 = PHP コア RCE の最有力の入口）。
    `webui/*.php` は `$_POST`/`$_FILES`/`$_REQUEST` を読まない（0 件）・method=post のフォームも 0 件なので、
    Off にしても挙動は変わらない＝**パーサ層を丸ごと無効化できる**。
  - `post_max_size = 16M` / `upload_max_filesize = 8M` / `max_file_uploads = 0`
    （元は 4G。アップロードはこのサイトには不要なので上限を sane にする）
  - 適用: `bash scripts/php/apply-php-hardening.sh`（dry-run）→ `sudo bash scripts/php/apply-php-hardening.sh --apply`
    → `bash scripts/php/verify-php-hardening.sh`（実測検証。root 不要）
  - **前提条件は回帰テスト [10] で固定**（`npm test`）:
    POST を読まない / method=post フォームなし / `mb_*` を使わない / eval・exec 等を使わない /
    動的 include なし / `archive.php` の `global $domain` あり。
    **PHP を触るときは [10] を壊さないこと**。
- **mbstring（`php8.3-mbstring`）は意図的に導入しない**:
  - Ubuntu 8.3.6-0ubuntu0.24.04.12 に未バックポートの **CVE-2026-6104**（`mb_convert_encoding` の
    global buffer over-read）の影響を受ける拡張。使わなければ導入しない。
  - 過去 `subtitle-compare.php` が `mb_strlen()` を素で呼び、mbstring 不在で
    **本番が HTTP 500** になっていた（2026-10-21 実測・修正済み）。
  - UTF-8 の長さ・検索だけなら `webui/_mb.php`（`mai_utf8_len` / `mai_utf8_strpos`）で足りる。
    **新しい PHP で `mb_*` を直接呼ばないこと**（回帰テスト [10] が検出する）。
- **旧 PHP（`/var/www/html` 直下）は実行させない**:
  - `elza` vhost（root `/var/www/html`）には `exec()` + `move_uploaded_file()` を含む
    旧 `henkan/henkan.php` 等が残っている。`open_basedir` で今は実行できないが、
    basedir が緩んだ瞬間に無認証の公開 RCE になる。
  - → `sudo bash scripts/nginx/apply-php-exec-guard.sh --apply`
    （elza vhost の PHP 実行を 404 にする。**本番 :1717 と staging :80 は対象外**）。
- **OS の security pocket 更新は `~/apply-os-security-updates.sh` で適用する**（全体 upgrade はしない）。
- **Ubuntu は upstream の security パッチをバックポートする運用**なので、patch を当てても
  `php -v` のバージョン文字列は `8.3.6` のまま（`-0ubuntu0.24.04.NN` のリビジョンだけ上がる）。
  → **適用判定は `php -v` ではなく Debian changelog の CVE 記載で行う**（`verify-php-security-patch.sh` が自動化）。
- **php8.1 系は導入されていたが削除済み**（dpkg `rc`）・`masked` で停止中
  （upstream 8.1 は 2025-12-31 EOL → 緊急修正は来ない）。**起動させない**（nginx も 8.3 しか向かない）。
- **upstream の修正版は `https://www.php.net/ChangeLog-8.php` から機械判定する**
  （リリース案内ページ `releases/8_3_XX.php` には CVE ID が載らない・URL も不安定）。
  判定するのは「CVE を含む**最小**の 8.3.x」（`>=` 比較の基準）。
  2026-10-21 時点: latest 8.3.x = 8.3.35。今晚は 8.3.36 相当。
  ※ Ubuntu の `8.3.6-0ubuntu0.24.04.12` は 8.3.35 の CVE 11 件中 **10 件**をバックポート済みだが、
    upstream 8.3.32 の CVE-2026-12184 / 8.3.33 の CVE-2026-9672 / 8.3.35 の CVE-2026-17545
    （Windows 専用）は**未収録**。「8.3.35 まで入っている」は不正確なので注意。
- **スクリプトは fail-closed。** 修正版を検出できない・candidate が変わらない・削除が絡む場合は
  **exit 1** で「完了」を出さない。`--force` は **upstream 判定だけを飛ばす**ための escape hatch で、
  Ubuntu に更新が無い場合は `--ppa` が必要。
- **緊急パッチの適用は本家スクリプトで**（`sudo` 必要・dry-run → `--apply` の2段。`~/apply-php-security-patch.sh` はラッパ）:
  ```bash
  bash scripts/php/apply-php-security-patch.sh                   # dry-run（root 不要）
  sudo bash scripts/php/apply-php-security-patch.sh --apply       # 適用（Ubuntu archive に修正がある場合）
  sudo bash scripts/php/apply-php-security-patch.sh --apply --ppa # ondrej PPA を使う場合（副作用あり）
  bash scripts/php/verify-php-security-patch.sh                   # 適用結果の検証
  ```
  - `apt-get upgrade`（全体）は**しない**。`php8.3-*` だけを `--only-upgrade` で上げる。
  - 適用前のバージョンは `/var/lib/mai-push/php-rollback-<時刻>.txt` に記録（ロールバック手順つき）。
  - **PPA（`--ppa`）は恒久設定が残る。** 戻す場合は
    `sudo bash scripts/php/rollback-to-ubuntu-php.sh --apply`（§5.1 の「戻る手順」を参照。
    `rm -f` だけでは PPA 由来のパッケージは戻らない）。
  - **2026-10-21 の件**: CVE-2026-109618 / CVE-2026-109619（PHP コア RCE / CVSS v4.0 9.2）が
    2026-10-21 14:00 UTC（JST 23:00）にリリース。詳細と影響評価は `docs/SECURITY.md` を参照。

### 5.2 脆弱性・更新の自動監視（security-watch）
- **目的**: 「管理者が偶然見つけないと気づけない」を解消する。`scripts/security/security-watch.js` が
  **日次 cron**（`30 4 * * *`・`scripts/ops/security-watch-cron.sh`）で 4 系統を機械判定し、
  **新規に検出されたものだけ**を Discord と管理画面へ通知する。
- **監視対象（4 系統）**:
  | 系統 | 判定方法 | 重大度 |
  |---|---|---|
  | Node.js | nodejs.org/dist/index.json の `security` フラグ＋EOL 表 | 修正込みリリース=重大 |
  | PHP 8.3 | upstream ChangeLog-8.php の CVE 集合 − Ubuntu 側 changelog の CVE 集合 | 重大 |
  | npm 依存 | `npm audit --json`（critical=重大 / high=警告 / 他=情報） | 重大・警告 |
  | OS パッケージ | `apt-get -s dist-upgrade` の security pocket 差分 | 警告 |
- **PHP の判定はバージョン比較をしない**（`§5.1` のとおり Ubuntu は upstream のバージョン文字列を
  固定して Debian リビジョンでバックポートするため）。**CVE 集合の包含関係**で判定し、
  古い CVE は公開日ベース（365日）で除外する。
  - **さらに Ubuntu の CVE トラッカーで「対象外」を除外する（2026-10-23 追加）**:
    `https://ubuntu.com/security/cves/<CVE>.json` を引き、`php8.3` × 対象リリース
    （`/etc/os-release` の `VERSION_CODENAME`）の状態を見る。
    - `not-affected` / `ignored`（例: `ignored windows only`）→ **info** に落として要対応から外す
      （summary に「対象外 N 件」とだけ出す）
    - `needed` / `pending` / `deferred` / `released` / `needs-triage` → 従来どおり critical
    - **取得失敗・記載なしは critical**（fail-closed）。tracker は CVE ごとに並列取得し、
      timeout 30 秒 / retry 2（ubuntu.com は応答が遅いことがある）
    - 実例: CVE-2026-12184 = noble の php8.3 は `not-affected`（8.3.23 で混入した不具合で
      noble の 8.3.6 には入っていない）/ CVE-2026-17545 = `ignored`（Windows 専用）。
      修正前は 3 件、修正後は「要対応 1 件（対象外 2 件）」（残る 1 件は GD 由来で
      tracker に php8.3 の記載が無いもの＝`--ack` で承認済み）
  - **「Ubuntu に CVE の記載が無い＝未修正」ではない**ので、`--ack` で承認するときは
    「なぜこの環境に影響しないか」を `--note` に必ず残す（後から判断を追えるようにする）。
- **検知と通知のみ。適用（パッチインストール・npm update・pm2 再起動）はしない**。適用は人が判断して行う。
- **通知の再発火制御**:

  ```bash
  node scripts/security/security-watch.js --list                 # 現在の指摘と承認済み一覧
  node scripts/security/security-watch.js --ack <key> [--note "理由"]  # 承認（以降の通知対象外）
  node scripts/security/security-watch.js --unack <key>          # 承認を解除
  node scripts/security/security-watch.js --dry-run               # 通知せず判定だけ
  ```
  - 初回実行は**全件を通知しない**（ベースライン登録のみ・概要 1 通）。
    既に存在する指摘を一斉に鳴らすと警报が埋もれて alert fatigue になるため。
  - 承受できる指摘は `--ack` で承認する。承認済みはサマリにだけ残す。
  - 重大（critical）の指摘が 7 日以上続く場合は「継続中」として 1 回だけ再通知する。
  - **通知に成功した指摘だけ** `lastNotified` を更新する（通知失敗した指摘は次回も再送する）。
  - **深刻度が上がった**指摘（info → critical 等）は「新規」として通知する。
  - **指摘 key には識別子を含める**（`node:update:24:v24.23.0` / `npm:<pkg>:GHSA-xxx` /
    `os:security:<pkg>`）。バージョンや advisory を含めないと同じ指摘として扱われ、
    新しいリリースが出ても通知されなくなる。
- **fail-closed**: 判定できなかった項目は「正常」ではなく「監視失敗」として扱い、exit code 2 を返す。
  監視そのものが壊れていて気づかない状態を作らない。
  - `npm audit` は失敗時に `{"error":...}` を stdout に出して exit 1 になる。
    **これを通常の監査結果として解析すると「問題なし」＝正常と誤判定する**ため、
    `data.error` / `metadata` の欠落を検出して error 扱いする。
  - PHP の upstream 解析結果が空、または Ubuntu 側 changelog に CVE が 1 件も無い場合も error。
- **公開 status ページへ出すのは「カテゴリと件数」だけ**。CVE ID などの詳細は
  `/api/scraper-status`（**公開エンドポイント**）に流さない。詳細は Discord と運用ログのみ。
  公開ページは「最終実行」が `success`/`running` のときだけ更新されるため、
  実行時刻は message に入れて判別できるようにしている。
- **報告先は `ecosystem.config.js` から解決する**（cwd が一致する **API アプリ（server.js）** の PORT）。
  - cwd だけだと **worker（3002）が先にマッチして** `/api/internal/scraper-status` が 404 になる。
  - 解決できない場合は fail-closed（既定の 8080 に倒さない）。
  - staging ツリーから実行したときに**本番 API（8080）に報告してはいけない**（`§1` のポート位相）。
- 状態ファイル: `data/security-watch-state.json`（`/data` は gitignore 済み）。
  解析ロジックのユニットテストは `scripts/ops/regression/09-security-watch.js`（回帰テスト `[9]`）。
- **新しい Node.js LTS が出たら `scripts/security/checks.js` の `NODE_EOL` 表に追記すること**
  （表に無いメジャーは EOL 判定をしない）。

### 5.3 ハニーポット（偽物の秘密ファイル・2026-10-22 追加）
- **目的**: 公開サイトには**既に秘密ファイル探索が来ている**（実測: アクセスログに 217 件。
  `/.env` `/.env.bak` `/.webui/.env` `/.git/config` `/id_rsa` `/database.sqlite`
  `/backup.zip` `/.aws/credentials` `/wp-config.php` など。インターネット経由の
  `/wp-admin/install.php?step=1` も 13 件）。現状は「見つからない」だけなので**証拠が残らない**。
  → **本物そっくりの偽物**を配信し、**取得されたら通知**する。
- **偽物の置き場**: `/var/lib/mai-push/honeypot/`（**Web 公開ツリー外**・git 管理外）。
  `bash scripts/security/honeypot-setup.sh` で生成（`--rotate` で token 再生成）。
  中身は**すべて偽物**。実物の秘密値は含まれない。
  **変種の追加は nginx の再適用不要**（配信元ディレクトリの中身が変わるだけ）。
  ただし `.env_xxx`（アンダースコア区切り）を**パターン一致させる**には
  honey location の正規表現に `[._-]` が必要 → その場合のみ nginx の再適用が要る。
  | ファイル | 中身 |
  |---|---|
  | `.env` | 本物.env を模した偽値（`NOTIFY_API_TOKEN=honey-canary-<token>` 等） |
  | `database.sqlite` | 実在する SQLite。`users` / `api_keys` / `settings` に偽 creds |
  | `backup.zip` | 実在する zip（中に `.env` と `config.php`） |
  | `.git/config` | 偽 git config。remote URL に**追跡 URL（canary）** |
  | `id_rsa` / `.ssh/id_rsa` | 偽の秘密鍵（形式は正しい） |
  | `config.php` / `credentials.json` / `.aws/credentials` / `secret.txt` / `dump.sql` | 各種の偽物 |
- **canary（追跡 URL）**: `https://koinoyamai.love/_canary/<token>`。
  偽物の中に埋め込まれている。**この URL にアクセスされたら
  「盗った情報（中身を実際に使った）」= 窃取確定**として通知される。
- **配信（要 sudo）**: `sudo bash scripts/nginx/apply-honeypot.sh --apply`
  - `listen 1717` の vhost に、**機密ファイル名っぽいパスだけ**を偽物ディレクトリから返す
    `location` を追加（**他の場所の実ファイルは絶対に公開しない**。先にマッチするため）
  - 併せて**機密拡張子の deny ルール**も入れる（`.env` `.sql` `.pem` `.log` 等。
    `.zip` はアプリの配布物があるので**対象外**）
  - `honey.log`（`/var/log/nginx/honey.log`）に記録。**時刻・UA・クライアント IP 入り**
    （メインの `access.log` には時刻も UA も無い＝取证できない）
  - **取得（200）だけでなく偵察（404）も honey.log に残す**。
    vhost レベルの `error_page 404 /404.html` だと 404 が内部リダイレクトで
    honey.log の外（access.log）へ逃げるため、ハニー location 内だけで
    `error_page 404 = @honey_not_found;` を使って named location へ逃がす
  - nginx は正規表現 `location` を**出現順**に評価するため、
    挿入位置は **vhost 内の最初の `location` の直前**（`location ~ \.php$` より前）である必要がある
  - 適用スクリプトは**冪等**（同じ入力なら差分ゼロ）。適用済みなら
    ハニー location グループ（honey / named / canary / deny）を**まとめて差し替える**
- **監視**: `scripts/security/honeypot-watch.js`（5 分ごとの cron）
  - `stolen`（偽物が 200 で取得された）/ `canary_used`（canary アクセス）= 重大で個別通知
  - `probe`（404 の偵察）= 情報（3,200 文字を超える場合は分割して送る）
  - 通知は既存の `scripts/security/notify.js`（Discord Bot API）を再利用
  - **通知は 4096 文字で分割する**（`scripts/security/discord-chunk.js`）:
    Discord の embed description の上限は 4096 文字で、**超えるとメッセージ全体が 400 で落ちる**
    （一部だけ捨てられる、ではない）。2026-10-23 実測: 37 件の窃取（UA 付きで 7,574 文字）を
    1 通に詰めたため落ち、**窃取の通知が一度も届かない**うえ、失敗ループで偵察の通知が
    5 分おきに再送され続けた（「新規ないのに毎回通知が来る」）。→ 1 メッセージ本文は
    **3,200 文字**を目安に分割し、`notify.sendDiscord` 側でも**安全網として切り詰める**
    （title 256 / description 4096）。
  - **配送はイベント単位で追跡する**（`e.notified`）。成功したカテゴリ／チャンクは
    **再送しない**（部分失敗で全部が再送され「毎回通知」になるのを防ぐ）。
  - **同じイベントは既定 24 時間は再通知しない**（`state.recent` の重複抑制。
    key = `kind|ip|path|status`、`HONEY_DEDUPE_HOURS` で変更可）。
    同じスキャナが同じファイルを何度も取りに来るのは「新規」ではない。
    ※ **`canary_used` だけは重複抑制しない**（追跡 URL の使用は最も重要な証拠で、
      2 回目以降も通知する価値がある。頻度も低い）。
  - **fail-closed**: 通知に失敗したイベントは `pending` に保持して**次回に再送**する。
    読み取り位置は進めてよいが、通知できたイベントだけ `pending` から外す
  - `--dry-run` は**状態を一切書き換えない**（読むだけ。イベントを消費すると
    以後二度と通知されなくなる）
  - **状態ファイルは setup と watcher で分離**する:
    `data/honeypot-canary.json`（token・canary パス。setup が書く）
    / `data/honeypot-watch-state.json`（読み取り位置・pending。watcher が書く）。
    同じファイルにすると setup の再実行で読み取り位置が消え、
    過去の重大イベントが**全件再通知**される
  - ログの世代（inode）を管理し、ローテート・切り詰めでイベントを飛ばさない
  - 判定は honeyfmt の**固定フィールド**（`st=` / `uri=`）だけを使う。
    UA は攻撃者が自由に入れられるので、honeyfmt では**UA を最後に**置き、
    解析を騙されないようにする
  - **検知経路は状態を報告する**（`§11`）。`/api/internal/scraper-status` へ
    報告し、監視が静かに死んでも察觉できるようにする（異常は exit 2）
  - **自機からのリクエストは通知しない**（ノイズ防止）:
    `ip=127.0.0.1`（`::1` / `::ffff:127.0.0.1` / `127.*` 含む）かつ `cf=-` かつ `xff=-`
    ＝ **Cloudflare を通っていない自機からの確認・テスト**として扱い、
    ログには残すが**通知はしない**。
    インターネット経由は必ず `cf=` に入るため**公開トラフィックは落とさない**。
    LAN 直叩き（`ip=192.168.1.x` 相当）は自機扱いせず**通知する**
    （LAN 内の端末が侵害されている可能性）。`--include-local` で含められる
  - **自機テストは `curl http://127.0.0.1:1717/.env` で行う**（公開 URL 経由だと
    Cloudflare を通るので `cf=` が入り**攻撃者と区別できない**ため通知される）
  - 通知の**表示 IP** は `cf=`（Cloudflare 経由）か実 peer（`$remote_addr`）。
    `X-Forwarded-For` は攻撃者が set できるので表示には**使わない**
- **可視化（管理画面「ハニーポット」タブ・2026-10-23 追加）**:
  - 入口は**管理画面のみ**（`https://elza.poitou-mora.ts.net/admin.html` → 「ハニーポット」タブ）。
    API は `GET /api/admin/honeypot?days=N`（`requireAuth`。N は 1〜90・既定 7。UI は 24時間/7日/30日/90日）。
  - **公開エンドポイントには IP・UA・国を出さない**（本節冒頭の原則）。`/api/admin/` 配下は
    公開ドメインで nginx が 403（§6.7）なので、tailnet 以外からは取得できない。
  - データ源は **`/var/log/nginx/honey.log` を直接解析**（`services/honeypot-report.js`）。
    ハニー location 専用ログなので、ここにある行はすべてハニーへのアクセス。
    自機テスト（`ip=127.0.0.1` かつ `cf=-` かつ `xff=-`）は除外（watcher と同じ規則）。
  - **日次ローテートを跨いで読む**: `honey.log` は `logrotate`（`daily` / `rotate 14` /
    `delaycompress`）で回るため、**`.1` と `.2.gz`〜 も読む**。現行ファイルだけだと
    「7日 / 30日 / 90日」が**実質 24 時間**になる（レビュー指摘）。
    **保持は最大 14 日**（`rotate 14`）。それより前は見えない（長期傾向は通知履歴側で見る）。
  - canary は **`previousCanaryPaths`（ローテート前の token）も「使用」と判定**する
    （`honeypot-watch.js` と同じ）。ここがずれると「Discord は重大で鳴るのに画面は 0 件」になる。
  - 国・ASN・組織名は **Team Cymru の DNS**（`<rev>.origin.asn.cymru.com` / IPv6 は `origin6`）で
    解決する（`services/geoip.js`）。**GeoIP の .mmdb も CLI も不要**で、外部 HTTP API に IP を送らない。
    キャッシュは `data/geoip-cache.json`（成功 30 日 / 不明 1 時間）。失敗しても `cc: null`（「不明」）で返す。
  - **大量 IP で API を固めない**: 頻度順に最大 500 IP・合計 3 秒で打ち切り、未解決分は
    次の取得（60 秒ごと）で埋まる。
  - 表示: 総ヒット / 取得（stolen）/ canary 使用 / 偵察 / ユニーク IP / 国数（**判明分のみ**。不明は国に数えない）、
    国別（旗・組織名）、日別の推移、狙われたパス、直近 200 件（時刻・国・IP・組織・種別・パス・status・UA）。
    時刻は**JST 固定**（`Intl` の `timeZone: "Asia/Tokyo"`。端末 TZ に依存させない）。
  - **ログが読めない・パースできない・canary 状態が無い**ときは、画面に警告を出す
    （黙って「アクセスなし」にすると監視が死んでも気づけない）。
  - **canary の token は UI に出さない**（`/_canary/***` にマスク。スクショ共有時の漏洩防止）。
  - UA は攻撃者が自由に設定できるが、**パースは固定フィールドを先頭から読む**ので、
    UA に `st=200 uri=/.env` を混ぜても分類は騙されない（回帰テストで固定）。
  - 管理画面の JS は `webui/js/admin-honeypot.js`（外部 CDN 不使用・CSP `script-src 'self'` 準拠）。
    攻撃者が制御できるパス/UA/IP を描画するため、**必ず `esc()` を通す**（XSS 防止）。
  - 任意 env（未設定で既定値）: `HONEY_LOG_PATH`（`/var/log/nginx/honey.log`）/
    `HONEY_CANARY_STATE`（`data/honeypot-canary.json`）/ `GEOIP_CACHE_FILE`（`data/geoip-cache.json`）/
    `GEOIP_TIMEOUT_MS`（1200）/ `GEOIP_BUDGET_MS`（3000）。

- **安全の鉄則**:
  - 偽物の中身は**必ず偽**。実物の `.env`・鍵・DB を絶対に置かない
  - 偽物は**Web 公開ツリーの外**（`/var/lib/mai-push/honeypot`）に置き、
    nginx の `location` で**指定されたパスだけ**返す
  - 実物の `.env` は mode 600・webroot 外・deny 対象のままで**触らない**
  - 窃取を検知しても**自動でブロックしない**（誤検知で Cloudflare 共有 IP を
    巻き込みサイト全体を止める恐れがある。ブロックは別途明示的に判断する）

