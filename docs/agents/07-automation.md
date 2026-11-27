# AGENTS §7 自動化スクリプト・cron・バックアップ

> `AGENTS.md` から分割した詳細（§番号は AGENTS.md と共通）。索引と必読ルールは リポジトリ直下の `AGENTS.md`。

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
  `git pull` / `git checkout` を行うと、書き換わった `webui/*.php` が mode 600 で作られ
  **php-fpm (www-data) が読めず 500** になる（本番 `/logs/` で実発生 → `chmod 664` で復旧）。
  `verify-deploy.sh` は other 読み取り不可を検出して exit 1 する。
  `auto-deploy.sh` / `deploy-staging.sh` は `umask 002` を固定済み。**手動 `git pull` をするときも
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
- `main` / `staging` への直接 push を拒否（**実際の push 先の ref** で判定。例外は cron の `SKIP_PREPUSH=1` のみ。§13・§14.2）
- ステージ・コミット対象の `.js` に対し `node --check`
- `.php` に対し `php -l`
- アプリバージョンの3箇所整合（`scripts/ops/check-app-version.sh`・`SKIP_PREPUSH_VERSION=1` でスキップ可）
- 送信するコミットごとの追加行から秘密値を検出（既存ブランチは `secret-scan.sh --range`、新規ブランチは
  `--new`＝リモートに無いコミットすべて。2026-11-27 追加。`SKIP_PREPUSH_REGRESSION=1` でも飛ばない）
- 回帰テスト `npm test`（281項目・2026-11-09 時点、約6秒）
- 構文エラー・秘密値・保護ブランチへの push があれば拒否。`SKIP_PREPUSH_REGRESSION=1` は回帰テストだけを飛ばす
  （Windows など回帰テストが動かない環境用。PR の CI で必ず通す）。`git push --no-verify` は人間が判断した場合のみ
  （エージェントはガードで拒否される。§13）。判定は `scripts/ci/test-pre-push.sh` が CI で検査する。

### 7.3.10 Node.js バージョン追従の自動化（2026-10-25 追加）
```bash
bash scripts/ops/node-version-check.sh     # nodejs.org から最新 security release を検出 → nvm ダウンロード → dry-run
```
- nodejs.org の index.json から最新の security release を取得。
- 新版があれば nvm で自動ダウンロード。
- migrate-node-patch.sh の dry-run を実行。
- Discord に dry-run 結果と手動対応手順を通知。
- 実際の移行（--apply）と systemd unit の更新は手動。
- cron: 毎日 05:00。

### 7.3.9 Android/Windows アプリの CI/CD（2026-10-25 追加）
- `.github/workflows/build-android.yml`: ubuntu-latest + JDK 21 + Gradle で APK ビルド
- `.github/workflows/build-windows.yml`: windows-latest + MSBuild + Inno Setup でインストーラ生成
- 手動トリガー (workflow_dispatch) または対象ディレクトリの変更で自動実行
- ビルド成果物は GitHub Actions artifacts に 30日間保存
- GitHub Secrets に ANDROID_KEYSTORE_BASE64 等の設定が必要

### 7.3.8 ログ異常検知（2026-10-25 追加）
```bash
bash scripts/ops/log-anomaly.sh     # pm2 ログのエラー率を監視し、異常があれば Discord 通知
```
- mai-push-api / mai-push-worker / discord-bot のエラーログを日次で分析。
- 前日の 2 倍以上のエラー、または重大パターン（Uncaught/FATAL/SQLITE_BUSY 等）を検出。
- 異常時は Discord 通知。初回実行時はベースライン記録のみ。
- cron: 毎日 06:00。

### 7.3.7 依存更新の自動 PR 作成（2026-10-25 追加）
```bash
bash scripts/ops/dep-update-pr.sh     # npm audit fix → npm test → PR 作成 → Discord 通知
```
- security-watch の検出後に実行（cron: 毎日 05:30）。
- high/critical 脆弱性を `npm audit fix`（--force なし）で修正。
- npm test が pass したらブランチ作成 → commit → push → PR 作成 → Discord 通知。
- 既にオープンな dep-update PR がある場合はスキップ。
- npm audit fix で変更が無い場合は手動対応が必要と Discord 通知。

### 7.3.6 自動デプロイパイプライン（2026-10-25 追加）
```bash
bash scripts/ops/auto-deploy.sh     # main の新コミット → CI 確認 → staging → smoke → 本番（API + ワーカー + discord-bot）
```
- 5分ごとの cron で実行。`flock` で多重起動しない。新コミットが無ければ何もしない（exit 0）。
- **CI ゲート（2026-11-27）**: そのコミットの check-run を `gh` で確認する。実行中・未登録なら次の回へ、
  失敗なら配置しない。**どのワークフローの失敗でも止まる**（build-android / build-windows を含む。安全側）。
- staging: **ローカルの `staging` ブランチ**に `origin/main` を配置（`deploy-staging.sh` と同じ。§14.1）。
  → smoke test (health/archive/scraper-status/notify)。
  ⚠️ `deploy-staging.sh <feature>` で作業ブランチを staging に出して確かめている間でも、main に新しいコミットが
  来ると 5 分以内に main で上書きされる。長く確かめたいときは、その間 cron 行を止めるか、main への
  マージを待ってもらう。
- 本番: `git merge --ff-only` で進め（`reset --hard` で消さない）、**API・ワーカー・discord-bot を再起動**し、
  本番 smoke test ＋ワーカーの `/api/health/live`（:3002）＋ discord-bot が pm2 で online であること（2 回続けて）を確認。
- 止まり方は 2 種類（状態ファイル `/var/lib/mai-push/auto-deploy-state.json` の `status`）:
  - **失敗**（コミット自体が悪い: `ci-failed` / `staging-failed` / `rolled-back` / `rolled-back-unhealthy` /
    `rollback-skipped`）→ `failedCommit` に記録し、**新しいコミットが来るまで再試行しない**（再起動・通知の連発を防ぐ）。
  - **保留**（環境の都合: `ci-unknown`＝gh の認証切れ等 / `staging-dirty` / `prod-dirty` / `prod-diverged`＝未 push の
    コミット / `*-checkout-failed` / `prod-ff-failed`）→ `blockedCommit` に記録し、**毎回再試行**する。
    通知は「コミットと理由」が変わったときだけ。原因を片付ければ次の回に自動で配置される。
- ロールバック: 本番の smoke 失敗時、前のコミットに戻して API・ワーカー・discord-bot を再起動し、**戻した後も確認**する
  （直らなければ `rolled-back-unhealthy`）。ただし配置後に本番ツリーが変わっていたら（同時に動いた cron の
  コミット等）、消さないよう**自動では戻さない**（`rollback-skipped`。手動対応）。
- **手動で再試行する**（失敗扱いのコミットをもう一度配置したい）: 原因を直したうえで、状態ファイルの
  `failedCommit` を空にする（例: `python3 -c 'import json,sys;p=sys.argv[1];d=json.load(open(p));d["failedCommit"]="";json.dump(d,open(p,"w"))' /var/lib/mai-push/auto-deploy-state.json`）。次の回に再試行される。
- 実行中に自分自身（本番ツリーのファイル）が書き換わっても影響しないよう、一時コピーに移ってから実行する。
- Discord の通知本文は python で JSON にする（コミットメッセージの改行・`"` で壊れない）。Bot トークンは
  コマンド引数に出さない（`curl -K <(...)`）。
- 判定テスト: `scripts/ci/test-auto-deploy.sh`（使い捨てのリポジトリと pm2 / gh / curl の代役で 13 の場面・46 項目を
  再現。CI で実行）。
- cron: `*/5 * * * *`。

### 7.3.5 バックアップ復元検証・DB メンテナンス（2026-10-25 追加）
```bash
bash scripts/ops/verify-backup.sh     # 最新バックアップを temp DB に復元し整合性を確認
bash scripts/ops/db-maintenance.sh   # VACUUM + ANALYZE + 古いデータのクリーンアップ
```
- `verify-backup.sh`: 最新の `data-*.db` を temp にコピー → `PRAGMA integrity_check` → テーブル存在確認 → 行数確認。失敗時は Discord 通知。
- `db-maintenance.sh`: 30日以上前の `scheduled_notifications` を削除 → `ANALYZE` → `VACUUM`。完了/失敗を Discord 通知。
- cron: 週次日曜 04:00 (verify) / 04:15 (maintenance)。

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
10 3 * * *  /var/www/html/koinoyamai.love/scripts/ops/backup-offsite.sh --apply >> /var/www/html/koinoyamai.love/logs/backup-offsite.log 2>&1
*/15 * * * * /var/www/html/koinoyamai.love/scripts/ops/healthcheck.sh
30 9 * * *  bash /var/www/html/koinoyamai.love/scripts/ops/minutes-gen-cron.sh
30 4 * * *  bash /var/www/html/koinoyamai.love/scripts/ops/security-watch-cron.sh
35 4 * * *  mkdir -p /var/www/html/koinoyamai.love/logs && /home/yuzuki/.nvm/versions/node/v24.22.1/bin/node /var/www/html/koinoyamai.love/scripts/php/check-ubuntu-backport.js >> /var/www/html/koinoyamai.love/logs/php-backport-watch.log 2>&1
30 5 * * *   /var/www/html/koinoyamai.love/scripts/ops/dep-update-pr.sh >> /var/www/html/koinoyamai.love/logs/dep-update-pr.log 2>&1
0 5 * * *   /var/www/html/koinoyamai.love/scripts/ops/node-version-check.sh >> /var/www/html/koinoyamai.love/logs/node-version-check.log 2>&1
0 6 * * *   /var/www/html/koinoyamai.love/scripts/ops/log-anomaly.sh >> /var/www/html/koinoyamai.love/logs/log-anomaly.log 2>&1
0 4 * * 0   /var/www/html/koinoyamai.love/scripts/ops/verify-backup.sh >> /var/www/html/koinoyamai.love/logs/verify-backup.log 2>&1
15 4 * * 0  /var/www/html/koinoyamai.love/scripts/ops/db-maintenance.sh >> /var/www/html/koinoyamai.love/logs/db-maintenance.log 2>&1
*/5 * * * *  mkdir -p /var/www/html/koinoyamai.love/logs && /home/yuzuki/.nvm/versions/node/v24.22.1/bin/node /var/www/html/koinoyamai.love/scripts/security/honeypot-watch.js >> /var/www/html/koinoyamai.love/logs/honeypot-cron.log 2>&1
# ※ auto-deploy.sh は PR #106 で 100755 になり動いている（安全ガードは 2026-11-27 に追加。§7.3.6）
*/5 * * * *  /var/www/html/koinoyamai.love/scripts/ops/auto-deploy.sh >> /var/www/html/koinoyamai.love/logs/auto-deploy.log 2>&1
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
- ⚠️ **cron から直接実行する `.sh` は実行権限（index 100755）が必要**（2026-11-09 実測）:
  `verify-backup.sh` / `db-maintenance.sh` / `dep-update-pr.sh` が 100644 のまま直接実行され、
  **毎回 `Permission denied` で静かに失敗**していた（`logs/*.log` に記録。Discord 通知も出ない）。
  - `bash script.sh` 形式で呼ぶものは不要。上の表で**パスを直接書いているもの**が対象。
  - このリポジトリは `core.fileMode=false` のため、作業ツリーの `chmod +x` だけでは
    index（clone / CI の実体）に反映されない。**`git update-index --chmod=+x <file>`** を使う。
  - 回帰テスト `[18]` が `backup.sh` / `backup-offsite.sh` / `verify-backup.sh` /
    `db-maintenance.sh` / `dep-update-pr.sh` / `auto-deploy.sh` の index モードを検査する（6 本）。
  - `auto-deploy.sh` は当初「①dirty な作業ツリーなら中止 ②staging は `staging` ブランチへ反映 のガードを
    入れるまで 100644 で据え置く」方針だったが、PR #106 でガードの無いまま 100755 になり動いていた
    （`docs/agents/INCIDENTS.md` 2026-11-27）。2026-11-27 に ①②と CI ゲート等を追加済み（§7.3.6）。
  - `node-version-check.sh` はディスク上 755 のため動作しているが index は 100644（既存の不整合。
    別途 `git update-index --chmod=+x` で揃える）。
- リポジトリ外の job（`/home/yuzuki/temp.sh` の温度ログ等）は本表の対象外。
- **cron は `PATH` が `/usr/bin/node`（Node v18 = EOL）を掴む**ため、node を実行する
  スクリプト（`update-subscribers-and-commit.sh` / `minutes-gen-cron.sh` /
  `security-watch-cron.sh`）は `NODE_BIN` で v24.22.1 を明示指定している（`§5`）。
  cron ジョブを追加するときは node 実行の有無を確認して同じ扱いにする。

### 7.7 改行コード
`.gitattributes` で `text=auto eol=lf` を設定済み。LF→CRLF 混入で作業ツリーが
dirty になる事故（2026-09-26、main.js を含む8ファイル）を防止。既存の CRLF ファイルは
遅延正規化。バイナリ拡張子は `binary` と明示。

### 7.8 バックアップの別ホスト複製（2026-11-09 追加）
- `backup.sh`（03:00）の保存先 `/var/lib/mai-push/backups` は**本番マシン内**にあり、
  ディスク故障・侵入・誤削除で「本体」と「バックアップ」が同時に失われる。
  `scripts/ops/backup-offsite.sh` が **nassy の別ディスク**（`/mnt/4TB/mai-push-backups`）へ
  `data-*.db` / `env-*.env` を複製し、**最新ファイルの sha256 一致**を検証する。
- 実行:
  ```bash
  bash scripts/ops/backup-offsite.sh           # dry-run（転送内容の表示のみ）
  bash scripts/ops/backup-offsite.sh --apply    # 転送 + 検証 + リモートの世代整理
  ```
  - 失敗時は Discord に通知する（成功時はログのみ）。多重起動は `flock` で防止。
  - 接続先・保持日数は env で変更可: `OFFSITE_HOST`（既定 `nassy`）/
    `OFFSITE_DIR`（既定 `/mnt/4TB/mai-push-backups`）/ `OFFSITE_KEEP_DAYS`（既定 90）/
    `OFFSITE_MIN_DB_BYTES`（既定 1MB。これ未満の DB は転送しない）/ `OFFSITE_SSH_OPTS`。
  - 前提: 転送先へ ssh 鍵で入れること（BatchMode のためパスワード不可）・
    転送先に `rsync` / `sha256sum` / `stat` があること・`OFFSITE_DIR` が **rootfs とは別デバイス**に
    マウントされていること（`nofail` で外れていると rootfs に書いて「成功」するため実行時に検査する）。
  - 転送前に最新 DB の**サイズ下限・`PRAGMA quick_check`・日付（当日/前日）**を検査する。
    壊れた/古いバックアップを sha256 一致だけで「成功」にしないため（0 バイト同士でも一致する）。
- 保持: ローカル 30 日 / リモート 90 日。リモートは `--delete` を使わず、
  **ファイル名の日付**で整理する（`env-*.env` は `cp -p` で mtime が古いままなので、
  mtime 基準だと新しい複製まで消える）。
- 転送先には `.env` のバックアップ（秘密情報）を含む。**ディレクトリ 700 / ファイル 600** を維持する。
- **本番反映後に cron を登録する**（登録したら §7.6 の表にも同じコミットで追記する）:
  ```
  10 3 * * * /var/www/html/koinoyamai.love/scripts/ops/backup-offsite.sh --apply >> /var/www/html/koinoyamai.love/logs/backup-offsite.log 2>&1
  ```
- 限界: 同一拠点（LAN 内）の別マシンなので、災害対策としては不十分。
  将来はクラウドストレージへの二次複製を検討する。

