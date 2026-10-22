# AGENTS.md — AIエージェント向け 運用安全規則（mai-push）

このリポジトリで作業するAI/エージェントは**必ず本ファイルを読むこと**。
過去に複数回の重大事故が確認されている（2026-09-21〜22）。

> コード全体像・「どこに何があるか」は **`docs/ARCHITECTURE.md`**（アーキテクチャ早見表）に集約。
> 実装を探す前にまずこれを読む。構成を変えたら同ファイルも更新する。

## 1. ポート位相（最重要・間違えやすい）
- **本番API = PORT 8080**（pm2: `mai-push-api`, `/var/www/html/koinoyamai.love/server.js`）
- **staging API = PORT 8081**（pm2: `mai-push-api-test`, `/home/yuzuki/koinoyamai.love-test/server.js`, NODE_ENV=development）
- **本番ワーカー = `mai-push-worker`**（pm2, `/var/www/html/koinoyamai.love/main.js`、Webhook 3001）
- `curl localhost:8081` は**staging**である。本番検証を 8081 で行うと**stagingの旧コードを本番と誤認**する（実際に起きた）。
- 検証前に必ず `ss -ltnp | grep -E '8080|8081'` と `pm2 pid` で**ポートの実所有者PID→パス**を確認してから叩け。

## 2. 通知API（/api/notify）— 本番で実送テスト禁止
- **本番(8080)への POST /api/notify は実ユーザーにpushが届く**（web push + FCM）。テスト送信による誤爆が実際に発生した。取り消し不能。
- 通知の動作確認は **必ず staging(8081)** で行うこと。staging `.env` は `DISABLE_NOTIFICATIONS=1` 固定（実送抑止・履歴のみ）。**この設定を1に戻すな**。
- stagingで抑制確認済みのレスポンス: `{"success":true,"suppressed":true,...}` が返れば auth 経路は正常。

## 3. 認証仕様（2026-09 codex セキュリティ改修＋09-24 HMAC v2後）
- `/api/notify` ヘッダ: `x-notify-token: $NOTIFY_API_TOKEN` + `x-notify-hmac` + **`x-notify-timestamp`（UNIX秒、必須）**
- HMAC v2 署名対象: `"{timestamp}.{rawBody}"` の SHA256 hex（**受信した生ボディ**で検証。JSON作り直し禁止）。
  送信側は必ず `src/core/notify-sign.js` の `signNotifyPayload(secret, bodyString)`（`{hmac, timestamp}` を返す）を使い、
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
  依存を触る際は必ず staging で「実体 node_modules の npm install → 回帰テスト(83/83) → smoke」を通すこと。
- **依存更新の反映は `scripts/deploy/npm-deploy.sh` で行う（2026-10-21 追加）**:
  - `git pull` は **package-lock.json しか更新しない**。node_modules が旧版のままでは
    「lockfile 上は安全 / 実際のコードは脆弱」という食い違いが起きる。
    `npm audit` も lockfile 基準なので、**この乖離を放置すると security-watch が
    「critical 解消」と誤報する**（偽の安全感）。
  - `bash scripts/deploy/npm-deploy.sh`（dry-run）→ `--apply` で乖離を検出・修正する。
    pm2 を停止 → `npm install` → 乖離とモジュールのロードを検証 → 再起動、まで自動。
    失敗時は lockfile を git から戻して復旧する。
  - `npm ci` は node_modules を全削除するため**本番では使わない**（レジストリ障害時に
    依存ごと無くなる）。`npm install` を使う。
  - `check-drift.sh` が `package-lock.json` の md5 と node_modules の主要パッケージの
    バージョンを照合して乖離を検出する（`[3]` / `[3.5]`）。
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
  - 残 17 件は direct 依存の更新が必要（`puppeteer` → 25.x / `firebase-admin` → 14.x /
    `@simplewebauthn/server` → 13.3.3）。**破壊的変更を伴うため次回以降に検討**。
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
  解析ロジックのユニットテストは `scripts/ops/regression-test.js` の `[9]`。
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
  - nginx は正規表現 `location` を**出現順**に評価するため、
    挿入位置は **vhost 内の最初の `location` の直前**（`location ~ \.php$` より前）である必要がある
- **監視**: `scripts/security/honeypot-watch.js`（5 分ごとの cron）
  - `stolen`（偽物が 200 で取得された）/ `canary_used`（canary アクセス）= 重大で個別通知
  - `probe`（404 の偵察）= 情報を 1 通に集約
  - 通知は既存の `scripts/security/notify.js`（Discord Bot API）を再利用
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
- **安全の鉄則**:
  - 偽物の中身は**必ず偽**。実物の `.env`・鍵・DB を絶対に置かない
  - 偽物は**Web 公開ツリーの外**（`/var/lib/mai-push/honeypot`）に置き、
    nginx の `location` で**指定されたパスだけ**返す
  - 実物の `.env` は mode 600・webroot 外・deny 対象のままで**触らない**
  - 窃取を検知しても**自動でブロックしない**（誤検知で Cloudflare 共有 IP を
    巻き込みサイト全体を止める恐れがある。ブロックは別途明示的に判断する）

## 6. 検証の作法
- 変更後は `node --check <file>` → pm2 再起動（`--update-env`）→ **正しいポート**で `/api/health`。
- 本番 pm2 再起動は作業者の明示承認後にのみ実施。
- DB・history.json を触るテストは本番でやるな。staging でやれ。

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
- 回帰テストは `npm test`（scripts/ops/regression-test.js、HMAC v2＋timestamp検証＋YouTubeフィード補助ロジック＋webhookトークン検証を含む 35 項目）に接続済み。
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

## 7. 自動化スクリプト（2026-09-26 追加）— AI はこれを使う
手動でのミスを防ぐため、以下を実装済み。**作業の対応するフェーズで必ず実行すること。**

### 7.1 デプロイ後の検証（必須）
```bash
bash scripts/deploy/verify-deploy.sh webui/<file>          # 静的ファイル
bash scripts/deploy/verify-deploy.sh webui/<file>.php      # PHP（バイト比較はskip）
```
- **配信バイト数 vs ディスクのバイト数**を機械比較し、nginx の `open_file_cache` による
  切り詰め（応答が途中で切れ `<script>` が消える）を検出する。**HTTP 200 を返しても
  気づけないので必ずこのスクリプトを使うこと。** 検出したら自動でTTL待ちして再試行する。
- 比較元（`ORIGIN_BASE`）は **`http://127.0.0.1:1717`**（koinoyamai.love の直 vhost）。
  旧既定の `:1700` は 2026-10-19 に全パス301化され、301 本文と比較して
  **切詰め誤検知**を起こしていたため変更（2026-10-20）。
- 公開 HTML の `</html>` 欠落と `<?php` のにじみ出しも検出する。
- **ファイル権限も検査する（2026-10-20 の実事故）**: `umask 077` のシェルで本番ツリーの
  `git pull` / `promote.sh` を行うと、書き換わった `webui/*.php` が mode 600 で作られ
  **php-fpm (www-data) が読めず 500** になる（本番 `/logs/` で実発生 → `chmod 664` で復旧）。
  `verify-deploy.sh` は other 読み取り不可を検出して exit 1 する。
  `promote.sh` / `deploy-staging.sh` は `umask 002` を固定済み。**手動 `git pull` をするときも
  `umask 002` を先に実行すること**（または pull 後に `chmod 664` を確認）。
  - ⚠️ **手動の `git checkout --` / `git restore` などの作業ツリー書き換えも同じ**。
    2026-10-21 実事故: `umask 077` のシェルで `git checkout --` した5ファイルが mode 600 になり、
    php-fpm (www-data) が読めずトップページが 403・CSS が 404 になった（`chmod 664` で復旧）。
    **書き換え前に `umask 002`**、書き換えた後に `bash scripts/deploy/verify-deploy.sh <file>` で
    「other 読み取り不可」が出ていないことを確認する（verify-deploy は権限を検査して exit 1 する）。

### 7.2 ポート位相の検証（本番操作の**前**に必須）
```bash
bash scripts/deploy/assert-port.sh prod        # 8080 が本番ツリーか
bash scripts/deploy/assert-port.sh staging     # 8081 が staging ツリーか
```
- ポート → PID → 実行スクリプトパスを照合する。**不一致なら exit 1 で停止**。
- AGENTS.md §1 の事故（`curl localhost:8081` で本番と誤認）を防ぐ。

### 7.3 push 前の自動検査（pre-push フック、有効化済み）
`core.hooksPath = scripts/hooks` により、push 時に自動で：
- ステージ・コミット対象の `.js` に対し `node --check`
- `.php` に対し `php -l`
- アプリバージョンの3箇所整合（`scripts/ops/check-app-version.sh`・`SKIP_PREPUSH_VERSION=1` でスキップ可）
- 回帰テスト `npm test`（35項目、約5秒）
- 構文エラーがあれば push を拒否。回避は `git push --no-verify` または `SKIP_PREPUSH_REGRESSION=1`。

### 7.4 staging/本番のドリフト検出
```bash
bash scripts/deploy/check-drift.sh            # 乖離の有無と是正コマンドを表示
bash scripts/deploy/check-drift.sh --quiet    # cron 用（出力最小）
```
- git ブランチの乖離、Service Worker バージョン、主要ファイルの md5 一致、
  未コミット変更を検査する。**exit 0=乖離なし / 1=乖離あり**。
- staging ツリーは **`STG_DIR` 環境変数 → `git worktree list` の `staging` ブランチ → 既定パス** の
  順で自動解決する（2026-10-20）。worktree を移設しても誤検知しない。
  ※ staging の **実行実体**は pm2/nginx の参照先（`/home/yuzuki/koinoyamai.love-test`）であり、
  git worktree の場所とは独立しうる（§1 のポート位相検証と併用すること）。
  2026-10-20: Orca が別パスに作った `staging` worktree を削除し、実行実体と同じ
  `/home/yuzuki/koinoyamai.love-test` を `staging` ブランチに戻して一致させた。
  （`.env`・`data-test.db` はこのディレクトリにしか無いため、worktree だけを移すと staging が壊れる）
- 毎晩 00:05 の `update-subscribers-and-commit.sh` が作る `webui/data` のみの
  自動コミットによる behind は**正常と判定**（誤検出しない）。
- **cron 登録済み**（1日1回 06:30、0.14秒。ログは `logs/drift.log`）:
  ```
  30 6 * * * cd /var/www/html/koinoyamai.love && ./scripts/deploy/check-drift.sh --quiet >> logs/drift.log 2>&1
  ```
  乖離があった場合のみログに記録される（--quiet は出力を stderr に出すため、
  乖離なしは無言で exit 0）。

### 7.5 日次データ更新（cron 実装済み・通常は手動介入不要）
```
5 0 * * * cd /var/www/html/koinoyamai.love && ./scripts/ops/update-subscribers-and-commit.sh >> logs/subscribers.log 2>&1
```
- `scripts/ops/update-subscribers.js` で YouTube 登録者数を取得し `webui/data/*.txt` に追記、
  そのまま **commit + push** する。`webui/data` は ignore 済みだが追跡済みのため `git add -u` を使う。
- 登録者数が変わらない日は空コミットを作らない。**自動pushは他作業と競合しないよう
  データ変更があった日のみ**。push 失敗時はログに記録し exit 1。
- ⚠️ **`webui/data` 以外に未コミット変更（未追跡ファイル含む）があると、その回は commit せず
  保留する**（`logs/subscribers.log` に `WARNING: ... commit せず残置`）。自動再開はしないので、
  保留されたら作業ツリーをクリーンにして `bash scripts/ops/update-subscribers-and-commit.sh`
  を手動実行する。2026-10-20 00:05 に実際に保留された（原因は作業ツリーの未コミット変更。
  未追跡の残骸ファイルのほかに、ビルド済み JS の再生成などで**追跡ファイルの改変**も
  起因しうるため、`git status` で両方を確認すること）。

### 7.6 登録済み cron（実 crontab 相当・2026-10-22 実測）
```
5 0 * * *   cd /var/www/html/koinoyamai.love && ./scripts/ops/update-subscribers-and-commit.sh >> logs/subscribers.log 2>&1
30 6 * * *  cd /var/www/html/koinoyamai.love && ./scripts/deploy/check-drift.sh --quiet >> logs/drift.log 2>&1
0 3 * * *   /var/www/html/koinoyamai.love/scripts/ops/backup.sh
*/15 * * * * /var/www/html/koinoyamai.love/scripts/ops/healthcheck.sh
30 9 * * *  bash /var/www/html/koinoyamai.love/scripts/ops/minutes-gen-cron.sh
30 4 * * *  bash /var/www/html/koinoyamai.love/scripts/ops/security-watch-cron.sh
35 4 * * *  mkdir -p /var/www/html/koinoyamai.love/logs && /home/yuzuki/.nvm/versions/node/v24.22.1/bin/node /var/www/html/koinoyamai.love/scripts/php/check-ubuntu-backport.js >> /var/www/html/koinoyamai.love/logs/php-backport-watch.log 2>&1
*/5 * * * *  mkdir -p /var/www/html/koinoyamai.love/logs && /home/yuzuki/.nvm/versions/node/v24.22.1/bin/node /var/www/html/koinoyamai.love/scripts/security/honeypot-watch.js >> /var/www/html/koinoyamai.love/logs/honeypot-cron.log 2>&1
```
- いずれも `crontab -l`（yuzuki ユーザー）で確認済み。ログは `logs/`（gitignore 対象）。
  ※ **honeypot-watch の行は §5.3 の適用手順で登録する**（それまでは動かない）。
- ⚠️ **Node スクリプトを cron で `bash` で実行しない**（2026-10-22 実測）。
  `bash script.js` では shebang が使われず JS が**シェルとして解析**されて
  構文エラー（**exit 2**）になる。かつ本机的 cron は `MAILTO` 未設定・`mail` も未導入で
  **stderr がどこにも捨てられる**ため「静かに死んでいた」。
  `check-ubuntu-backport.js` がこの状態だった（04:35 の監視が動作せず）ため、
  `node` を**絶対パスで明示**して実行する。
- 追加・変更するときは `crontab -l` の実体とこの表を**同じコミットで**更新する。
- リポジトリ外の job（`/home/yuzuki/temp.sh` の温度ログ等）は本表の対象外。
- **cron は `PATH` が `/usr/bin/node`（Node v18 = EOL）を掴む**ため、node を実行する
  スクリプト（`update-subscribers-and-commit.sh` / `minutes-gen-cron.sh` /
  `security-watch-cron.sh`）は `NODE_BIN` で v24.22.1 を明示指定している（`§5`）。
  cron ジョブを追加するときは node 実行の有無を確認して同じ扱いにする。

### 7.7 改行コード
`.gitattributes` で `text=auto eol=lf` を設定済み。LF→CRLF 混入で作業ツリーが
dirty になる事故（2026-09-26、main.js を含む8ファイル）を防止。既存の CRLF ファイルは
遅延正規化。バイナリ拡張子は `binary` と明示。

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
    `ExecStart` は Node v24.22.1（§5 のとおり全プロセス統一）。依存ゼロコードのため実害は 없었으나、
    EOL 版（v20）を掴んでいたので 2026-10-21 に更新した。
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
- **UI コールバック（`DispatcherQueue` の Tick / `WndProc`）は例外境界で包むこと（2026-10-20, Issue #10）**
  - `StartHoverPoller` の `Tick` は try/catch 必須。例外は `%LOCALAPPDATA%\MaiPush\log.txt` に
    ウィンドウ状態（hwnd/alive/visible/minimized/DPI/カーソル/ストリップ状態）付きで記録し、
    ポーリングを停止する（`StopHoverPoller` / `DescribeWindowState`）。
    80ms 周期で例外が出続けてログが溢れるのを防ぐ。**停止は1セッション限り（再開しない）**。
  - `WndProc` は `WndProcCore` を呼ぶ薄い wrapper。例外時は `CallWindowProc` へフォールバックする
    （未処理例外はプロセスごと落ちる）。`WM_NCHITTEST`/`WM_SETCURSOR` は毎秒100回以上来るため、
    ログは `LogWndProcFault` で**5秒に1回**に制限し、抑制件数も併記する（同期ログでポンプが詰まる）。
  - 新しく `DispatcherQueue.TryEnqueue` で UI 処理を投げるときは `EnqueueUi(source, action)` を使う。
  - `_appWindow.Changed`（.AppWindow イベント）も UI スレッドのコールバック。例外境界を置き、
    `UpdateCaptionPadding` のように **最小化/復帰で不正値になり得る値**（`TitleBar.RightInset` は
    NaN/Infinity になり得る）を UI に代入する前に弾くこと（v1.8.5 教訓）。
  - **UI コールバックの例外ログは連発を制限する**（v1.8.6 教訓, Issue #17）。`AppWindow.Changed` や
    `EnqueueUi` の例外境界は繰り返し失敗しうるため、毎回 `Diagnostics.Log` すると
    UI スレッドの同期ファイル書き込みが連発して操作がもたくなり、`log.txt` も溢れる。
    `Diagnostics.ThrottledFault`（5 秒に 1 回へ制限し、抑制件数を 1 行で併記）を使うこと。
  - 非表示（トレイ格納）・**最小化中**はストリップを閉じた状態に戻す（`ResetTabStripHidden`）。
    最小化でも `IsWindowVisible` は true なので `IsIconic` も見ること。ドラッグ中に隠れた場合に備え
    ポインターキャプチャとドラッグ状態もここで畳む。
- **Release publish は self-contained（csproj の `<SelfContained>`）**
  - framework-dependent publish でインストールすると、グローバル .NET 構成が揃わない環境・
    InstallDelete 後のタイミングで「No frameworks were found」で自動起動失敗する。
- **待ちタイマーは連打で延長しないこと（v1.8.5 教訓, Issue #14）**
  - `DispatcherQueueTimer` を**毎回作り直して** `Stop()`→`Start()` すると、80ms 周期のポーリング
    （`OnHoverTick`）や `WM_NCMOUSEMOVE` から毎フレーム要求された場合に、待ちが 400ms を超えて
    永久に延長され、**折りたたみなどが一生起きない**（タブバーが出たままで問題）。
  - 「予約済み」フラグ（`_collapsePending`）で延長を止める。フラグは
    **予約= `StartCollapseTimer`／解除= Tick ハンドラ・`CancelCollapseTimer`・`ShowTabStrip`・
    `ResetTabStripHidden` の4経路**で必ずリセットすること（リセット漏れがあると
    以後折りたたみが起きない）。予約に失敗した場合もフラグを戻すこと。
  - **ドラッグ中は予約も Tick も畳まない**（`_tabStripPointerPressed` を見る）。ドラッグ終了時に
    `EndTabDrag` がカーソル位置を見て再予約する。ここを外すとドラッグ中にストリップが流れる。

### 10.1 アプリリリース手順（Windows / Android）— 2026-10-20（v1.8.3 / v1.7.2）で実施

- **バージョンは3箇所を揃える（Windows）**
  - `MaiPushWinUI.csproj` の `<Version>` / `installer.iss` の `#define MyAppVersion` /
    `UpdateChecker.cs` の `CurrentVersion`（`new(1, 8, 6)` のようにリリース版と揃える）。
  - `UpdateChecker.cs` を忘れると**最新版なのに「アップデートがあります」通知が出る**。
  - **機械検査が_parse可能になった**（2026-10-21 追加）:
    ```bash
    bash scripts/ops/check-app-version.sh    # 3箇所の整合（不一致で exit 1）
    ```
    - pre-push フックにも組み込み済み（`SKIP_PREPUSH_VERSION=1` でスキップ可）
    - GitHub Actions（`.github/workflows/ci.yml`）でも main へ push / PR 時に検査
      （バージョン整合・JS/PHP 構文・回帰テスト。Windows セッションからの push にも効く）
    - ビルド成果物を公開 repo に載せない運用なので、**CI 検査が唯一の守り**となる
- **Windows ビルド**
  - `dotnet publish MaiPushWinUI.csproj -c Release -r win-x64 -p:Platform=x64 --self-contained true`
    → `$(LOCALAPPDATA)\MaiPushWinUI\publish\`（csproj の `PublishDir` が固定）。
  - **publish ディレクトリはビルド前に空にする**（旧版 DLL が混ざると混在したままインストーラに入る）。
  - **ビルド中にアプリが publish 先の DLL を掴んでいると publish が失敗する**
    （`MSB3027: ... コピーできませんでした ... ファイルは ... によってロックされています`）。
    実機の exe が起動している場合は**必ず停止してから** publish する。失敗した publish のまま
    Inno Setup を回すと**修正前バイナリが混ざったインストーラ**ができるので、publish 失敗時は
    やり直すこと。
  - インストーラ: `"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss`
    → `Windows/mai-push-winui/installer/MaiPush-<ver>-Setup.exe`（`webui/dl/*.exe` は gitignore 対象）。
- **Android ビルドはネットワークドライブ（`Q:\`）では失敗する**
  - `:app:packageReleaseResources` が `dataBindingLayoutInfoOutFolder` の MD5 を作れず失敗する。
  - → **`mai_notification/` をローカルドライブへコピーして** `gradlew.bat assembleRelease` する
    （Gradle 8.13 / AGP 8.7.3 / JDK 21・`gradle/gradle-daemon-jvm.properties` 準拠）。
  - `mai_notification/local.properties`（`sdk.dir`）と `keystore.properties`（`storeFile`）は
    **マシン固有**（gitignore 対象）。Windows 側は Windows パスを書く
    （`C:/Users/<user>/AppData/Local/Android/Sdk` / `C:/Users/<user>/mai-keys/mai-notification-release.jks`）。
  - **署名鍵の SHA-256 が変わると上書きインストールできない**（`apksigner verify --print-certs` で
    既存 APK と一致することを確認してから配布する）。
- **配布の順序**: `webui/mai-notification.apk` と `webui/dl/MaiPush-<ver>-Setup.exe` を
  **先に配置してから** `webui/dl/android.json` / `desktop.json` を更新する
  （逆にすると更新フィードが 404 を指す）。
  - `desktop.json` の `url` の `?v=` は **サーバ側の ex の mtime**（`webui/dl/<exe>` の
    `filemtime`）に合わせる。`webui/download.php` が同じ基準で `?v=` を生成するため、
    ここだけ別の値になるとキャッシュキーが割れる（Windows 側のローカル mtime は
    JST 変換で 9 時間ずれるので使わない）。
  検証は `bash scripts/deploy/verify-deploy.sh webui/dl/desktop.json` 相当（配信バイト数 == ディスクのバイト数）。

### 10.2 配信開始アラーム（Android v1.7.3 で追加）
- **目的**: 配信の 15 分前（など）に**端末内アラーム**を鳴らして、寝ていても起きて配信を見られるようにする。
  通知（FCM push）に頼らないので、push が届かない・遅延する環境でも鳴る。
- **方式は `AlarmManager.setAlarmClock()`**（`mai_notification/.../AlarmScheduler.kt`）:
  - 公式ドキュメント: 「the system never adjusts their delivery time / leaves low-power modes
    if necessary」→ **Doze（画面オフ・スリープ）でも正確な時刻に発火**する。
  - 「次のアラーム」としてシステムに登録されるので、ステータスバーにアラームアイコンが出る。
  - 権限: API 33+ は `USE_EXACT_ALARM`（自動付与・取り消し不可）／API 31/32 は
    `SCHEDULE_EXACT_ALARM`。**このアプリは Play ではなく APK 直配布**なので
    exact alarm の用途制限（Play ポリシー）は該当しない。
  - 権限が無い／取り消された場合は `canScheduleExactAlarms()` が false になり、
    アプリは**設定画面への誘導**に徹する（黙って不被にしない）。
  - 再起動でアラームは消えるため `RECEIVE_BOOT_COMPLETED` の receiver で再登録する。
- **スケジュールの取得**: サーバーの `GET /api/events?status=scheduled`（公開）。
  通知の `data.start_time` でも即時に登録できる（サーバーの `notifyPlannedFromRss` と
  `buildEventNotificationPayload` が `start_time` を載せる。`services/notification.js` の
  `buildFcmData` が `start_time` を FCM data に含める）。
- ⚠️ **サーバーの `start_time` はタイムゾーン表記が混在している**
  （`"2026-10-18T23:45:51"` = JST naive / `"...Z"` = UTC）。
  **オフセットが無いものは JST（+09:00）として解釈する**（`AlarmScheduler.parseServerTime`）。
  `§6.9` の smart-display と同じ前提。
- **設定 UI はサイト側**（`webui/js/stream-alarm.js` → `webui/dist/stream-alarm.min.js`）。
  アプリは WebView ラッパーなので、通知設定と同じ場所に UI を置いている。
  ブラウザ（Web のみ）では `window.MaiApp` が無いので非表示。
  - JS ブリッジ（`MaiWebBridge.kt`）: `getStreamAlarmState` / `setStreamAlarmEnabled` /
    `setStreamAlarmOffsetMin` / `openExactAlarmSettings` / `getNextStreamStartAt` /
    `openSystemAlarmSetScreen`
- **「標準のアラーム時計に設定」は補助手段**（`ACTION_SET_ALARM`）:
  ⚠️ 公式ドキュメント: `EXTRA_SKIP_UI` は **API 19 以降無視され、アラームアプリが必ず
  確認 UI を出す**（＝ユーザーの 1 タップが必須）。確認画面を開くだけなので、
  「確実に目視でセットしたい」場合の補助として使う。
- ビルド・署名は Windows 側（`§10.1`）。`webui/dl/android.json` の更新は
  **APK を `webui/mai-notification.apk` に配置した後**に行う（先に更新すると 404 を指す）。

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
  - 対処: 共通スニペット `scripts/nginx/mai-security-headers.conf` を
    `/etc/nginx/snippets/` に置き、**自前の add_header を持つ Location から include する**。
    適用は `~/apply-nginx-security-headers.sh`（dry-run → `--apply`）。
    パッチは `scripts/nginx/apply-security-headers.py`（冪等・除外理由を報告）。
  - ⚠️ **スニペットを配置せずに設定を差替えると `nginx -t` が失敗してサイト全体が止まる**。
    差替は「スニペット配置 → 設定差替 → `nginx -t` → reload」の順で行う
    （`scripts/nginx/setup-staging-nginx.sh` がこの順で実装済み）。
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
      最終形。対象一覧は `scripts/nginx/mai-security-headers.conf` のコメントを参照。
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
  - `UPLOAD_KEY` を設定済み（`/var/www/html/upload/.env` = 600。値は `~/upload-key.txt`）。
    未設定だと API ゲートが無効になる（`server.js` の `if (!UPLOAD_KEY) return next();`）。
  - **保存拡張子は許可リスト制**（画像/動画/音声/PDF のみ）。クライアント申告の拡張子を
    そのまま使うと `.html` を名送出せて media ドメインで stored XSS になりうるため。
  - 外部からは到達できない（`/etc/nginx/media.conf` の `location / { return 403; }`）だが、
    アップロード UI は LAN/Tailnet のみ（`192.168.1.72` の server に allowlist）。

## 12. ドキュメント更新ルール（ARCHITECTURE.md を腐らせない）

全体像は `docs/ARCHITECTURE.md`。**変更したら対応するドキュメントも同じコミットで更新する**。

| 変更内容 | 更新するドキュメント |
|---|---|
| プロセス/ポート/起動方法 | `AGENTS.md §1` / `docs/ARCHITECTURE.md §2` |
| `routes/`・`services/`・`lib/`・スクレイパーの追加/改名/削除 | `docs/ARCHITECTURE.md §4`（§3 のフローも該当時） |
| DB スキーマ（`services/database.js` の `initDatabase()`） | `docs/ARCHITECTURE.md §5` |
| env キー追加/変更 | `AGENTS.md §3` / `docs/ARCHITECTURE.md §6` |
| **PHP ランタイムの実行時設定（enable_post_data_reading / disable_functions / open_basedir / ffi.enable）** | `AGENTS.md §5.1` / `docs/SECURITY.md` |
| 通知・認証・HMAC | `AGENTS.md §2,§3` / `docs/SECURITY.md` |
| デプロイ/検証の作法 | `AGENTS.md §7` / `docs/DEVELOPMENT-WORKFLOW.md` |
| webui 構成/CSP/静的配信 | `docs/ARCHITECTURE.md §4.5` / `AGENTS.md §6.6` |
| nginx への新ルート追加（例: `/display/`） | `AGENTS.md §6.9` / `docs/ARCHITECTURE.md §4.5b` / `docs/SECURITY.md` |
| アーカイブ API | `docs/ARCHIVE-ADMIN-SPEC.md` |
| 予定抽出/スケジュール | `docs/SCHEDULE-FEATURES.md` |
| 依存パッケージ更新 | `AGENTS.md §5` |
| Android/WinUI アプリ | `AGENTS.md §10` / `webui/dl/*.json` |
| nassy 連携 | `AGENTS.md §8` |
| ユーザーに見える変更（機能追加/修正/挙動変更） | `webui/updatelogs.php`（**指示がなくても必ず更新**。下記） |

### updatelogs（更新履歴）は毎回更新する — 指示されなくても行うこと

`webui/updatelogs.php` は**ユーザー向けの更新履歴**。ユーザーが言わなくても、ユーザーに見える変更をしたら**必ず**更新する。

- `$updateLogs` の**先頭（新しい順）**に当日分のエントリを追加（同日内は既存先頭エントリへ追記）。
- 分類キー `fix` / `add` / `change` に、利用者目線の日本語で1行ずつ書く（内部実装の話は書かない）。
- `lines` は `bash scripts/ops/count-lines.sh` の実測 `SUM code` を**その日の絶対値**として記録する（前日に増分を足す等の累積計算は禁止）。集計対象・除外・過去値の扱いは `docs/DEVELOPMENT-WORKFLOW.md` の「コード行数集計方法（updateLogs の "lines"）」節。
- フッターの「Last updated」は最新日付から自動表示のため、追記のみで反映される。
- 対象外（更新不要）: 内部リファクタのみ・ドキュメントのみ・テストのみ・データ更新のみ。

**変更時のセルフチェック（commit/push 前）**:
- [ ] 上の表に該当するドキュメントを更新した（該当なしなら不要）
- [ ] ユーザーに見える変更なら `webui/updatelogs.php` を更新した（`lines` を `count-lines.sh` の実測値で）
- [ ] `node --check <file>` / `php -l <file>`（pre-push でも自動実行, `§7.3`）
- [ ] `npm test`（回帰テスト 35 項目）
- [ ] 本番操作の前に `bash scripts/deploy/assert-port.sh prod|staging`（`§7.2`）
- [ ] 感度の高い変更なら PR＋別エージェントの独立レビューを通した（`§13`）
- [ ] 秘密情報・DB・`webui/data` を不用意にコミットしていない
- [ ] AGENTS.md / ARCHITECTURE.md の記載と実装が一致している

## 13. GitHub 運用（issue / PR / レビュー, 2026-10-19 追加）

- リポジトリ: `gonzaresu-jp/koinoyamai.love`（public・`gh` 認証済み）。
- **PR＋独立レビューを必須とする変更（感度が高い）**:
  DB/スキーマ・認証/HMAC・外部依存の更新・通知経路・外部API/インフラ（nginx / tailscale / systemd）。
  → ブランチ → PR → **別エージェントによる独立レビュー** → ユーザー承認・マージ。
- それ以外（コメント/ログ/ドキュメント/データ更新・小さな修正）は直接 push 可（日次 cron の data 自動 push と同扱い）。
- **レビュー観点**: バグ、セキュリティ（HMAC/認証/secret 取扱い）、`§11` の規約、テスト、`§12` のドキュメント・updatelogs 更新漏れ。
- 基本の流れ:
  1. 大きめの作業・不具合は **issue 化**（`gh issue create`）。既存: #1 ドメイン移行 / #2 リポジトリ名リネーム。
  2. ブランチを作成して実装（`feature/xxx`）。
  3. 検証（`§7`）後 `gh pr create`。PR 本文に **変更概要 / 検証内容 / 影響範囲 / 該当ドキュメント・updatelogs の更新** を記載（`.github/PULL_REQUEST_TEMPLATE.md` が自動適用）。
  4. 別エージェントでレビュー → 指摘対応。**レビュー結果は必ず PR コメントに投稿する**（下記）。
  5. ユーザーが承認・マージ（`gh pr merge`）。
- **独立レビューの結果は必ず PR コメントに投稿する（2026-10-21 追加）**:
  - 適用範囲: **基本の流れ（3〜5）で PR を作成した場合**の独立レビュー。
    直接 push した変更（コメント/ログ/ドキュメント/データ更新・小さな修正）は対象外。
  - レビューをチャット内だけで完結させない。**指摘内容（原文ベース）**を
    `gh pr comment <PR#> --body-file <file>` で投稿する。**対応コミットと指摘の解消状況もコメントで追記**する。
  - **投稿は PR 作成者（親エージェント）が行う**。レビュアーが read-only の場合は、
    レビュアーが返したレビュー本文を親が転記して投稿する（レビュー担当自身が投稿したと誤認しない）。
    長い本文は `--body-file` を使い、`--body "..."` のクォート地獄を避ける。
  - 理由: 後から「何を指摘され、どう直したか」を追えないと、レビューが事実上の空振りになる。
    PR のタイムラインが唯一の監査証跡になる。
  - 投稿する内容: レビュー観点（バグ / セキュリティ / `§11` 規約 / テスト / `§12` ドキュメント・updatelogs）ごとの指摘、
    **実測した根拠**（コマンドと結果）、Blocking / Non-blocking の区分、最終判定。
    臆測と実測を区別し、未確認事項は「未確認」と明記する。
  - ⚠️ **本リポジトリは public**。PR コメントは **gitignore の外 = 公開・永久・検索可能**。
    投稿前に秘密情報をマスクする（トークン値・`.env` の内容・`/home/...` の絶対パス・内部 IP 等。
    `§11` の「秘密情報をコミットしない」と同じ扱い）。
  - 修正後は **対応表**（指摘 → 修正コミット → 検証結果）をコメントで追記してからマージする。
  - 例: PR #33（PHP 緊急パッチ）で第1回・第2回のレビュー原文（コメント2件）と
    対応表（Blocking 6件＋2件＝計8件。原文記録のコメント2件を含む）を投稿した。
- **main ブランチ保護（設定済み, 2026-10-19）**: PR 必須（承認数0）・**force push 禁止**・削除禁止。`enforce_admins=false`（日次 data 自動 push を許すため）。
  - ⚠️ `enforce_admins=false` のため admin（=作業アカウント）は技術上は直接 push も可能。**GitHub では強制されないので、規約として PR 運用を守る**。
  - 例外: 日次自動コミット（`scripts/ops/update-subscribers-and-commit.sh`）は `webui/data` のみ main へ直接 push。

最終更新: 2026-10-22（§5.3 ハニーポット（偽物の秘密ファイル）を新設：scripts/security/honeypot-setup.sh で偽物を生成・scripts/nginx/apply-honeypot.sh で nginx に配信・scripts/security/honeypot-watch.js が取得/canary使用を通知 / §10.2 配信開始アラーム（Android v1.7.3）を新設：AlarmManager.setAlarmClock による端末内アラーム・exact alarm 権限・TZ 混在の扱い・標準アラームへの補助経路 / §5.1 PHP 実行時ハードニングを拡張：scripts/php/apply-php-hardening.sh（enable_post_data_reading=Off で multipart パーサ無効・ffi.enable=preload で FFI 迂回を塞ぐ・post_max_size 縮小）と scripts/php/verify-php-hardening.sh（実測検証）を追加／scripts/nginx/apply-php-exec-guard.sh で elza vhost の PHP 実行を 404 化／mbstring は意図的に未導入（webui/_mb.php で代替）／§11 に PHP の「読まない・実行しない」規約を追加／§5 のリリース時刻の誤記（23:00 UTC→14:00 UTC）を修正 / §5.1 PHP コアの緊急 RCE 期間の対応（メンテナンスモードで公開 PHP ページを 503 化・patch-and-resume.sh で復旧）を追加 / §5 Node.js を v24.22.1 に更新（2026-10-21 の security release）・パッチ版移行スクリプト scripts/deploy/migrate-node-patch.sh を追加（pm2 save 必須・旧 ~/migrate-*.sh は v24.22.0 固定で参照先ではない） / §6.9 旅先ディスプレイ（/display/）を新設：nginx の location 追加手順・同一オリジン配信の理由・API の start_time の TZ 混在注意 / §12 に nginx 新ルート追加時のドキュメント先を追加 / §5 依存更新（npm audit fix で critical 1→0・未使用の firebase クライアント削除）と本番反映経路 scripts/deploy/npm-deploy.sh・check-drift.sh の node_modules 乖離検出を追加 / §5.1 PHP ランタイム（php-fpm 8.3）を新設：CVE-2026-109618/109619 の緊急パッチ適用手順・scripts/php/・Ubuntu バックポート時の判定方法 / §5 Node.js を v24.22.0 に統一：pm2 全プロセス・pm2 デーモン・他プロジェクト 5 本・pi-vector.service・cron スクリプト・CI を明示指定。EOL だった v20/v18 の排除 / §9 pi-vector の ExecStart 更新 / §11 ネイティブビルドの基準を v24 に / §13 独立レビューの結果は必ず PR コメントに投稿するルールを追加（指摘原文・対応表・実測根拠を残す））
最終更新: 2026-10-20（§7.1 ファイル権限検査を追記（umask 077 の pull で php が 500）/ §10 UI コールバックの例外境界ルールを追記（Issue #10）/ §10 待ちタイマーの連打による延長禁止（v1.8.5 / Issue #14）/ §10.1 アプリリリース手順を追記：Windows publish→Inno Setup／Android はネットワークドライブで gradle ビルド不可＝ローカルへコピー / §7.1 verify-deploy の比較元を :1717 へ・§7.4 staging worktree の自動解決）
最終更新: 2026-10-19（§11 規約・§12 更新ルール・§13 GitHub運用を追記 / docs/ARCHITECTURE.md 新設 / main 保護設定）
最終更新: 2026-10-17（§10 v1.8.2 不安定問題修正メモ：トレイ透明アイコン=相対パス、クラッシュ=stowed exception 対策）
最終更新: 2026-10-13（§10 WinUI ネットワーク起動禁止を追記）
最終更新: 2026-10-10（§9 埋め込み停止中→稼働中に訂正 / CollabPoll 修正・md整理は別コミット）
最終更新: 2026-10-03（チャット読み上げ追加 / TTS systemd化・int8＋ONNX高速化 / latent-sliceストリーミング・不採用レコード / AGENTS.md §9 追加）
