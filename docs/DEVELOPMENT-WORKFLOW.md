# 開発フロー（staging / 本番）

1台のサーバー（elza）上に本番とテスト（staging）を同居させた運用フローのメモ。

## 環境の関係

| | 本番 | staging（テスト） |
|---|---|---|
| コード | `/var/www/html/koinoyamai.love`（branch: main） | `/home/yuzuki/koinoyamai.love-test`（git worktree・branch: staging） |
| API ポート | `http://localhost:8080` | `http://localhost:8081` |
| DB | `data.db` | `data-test.db`（本番のスナップショット） |
| NODE_ENV | production | development（定期タスク・ベクトル同期・マイルストーン停止） |
| 通知 | 通常動作 | `DISABLE_NOTIFICATIONS=1` で**実push完全抑止** |
| URL | https://koinoyamai.love | https://test.koinoyamai.love（ログインゲート付き） |
| pm2 | mai-push-api / mai-push-worker / discord-bot | mai-push-api-test（+ mai-push-worker-test は必要時のみ） |

- staging の `node_modules` / `.env` / `vapid.json` 等は本番へのシンボリックリンク（コード差分だけをテストしたいため）
- どちらも同じ `.env` を参照するので、接続先設定・Webhook 等の「環境差」は増やさない方針
- アーカイブ検索APIは別ホスト `192.168.1.70:8766`（api.py）を経由（どちらの環境からも同一）

## 基本フロー（trunk-based）

```
feature/xxx で開発
   ↓
bash scripts/deploy/deploy-staging.sh feature/xxx      … stagingに展開 + smoke 自動実行
  （ブラウザで https://test.koinoyamai.love を目視確認）
   ↓
git push origin feature/xxx                     … staging で検証したリビジョンを共有
bash scripts/deploy/promote.sh feature/xxx --sync-staging … 本番へ ff 昇格 + 本番smoke + staging追従
```

> GitHub 運用（issue / PR / 別エージェント独立レビュー / main ブランチ保護）は `AGENTS.md §13` を参照。
> 感度の高い変更（DB・認証、依存、通知経路、外部API/インフラ）は PR＋レビュー必須。

### deploy-staging.sh

```
bash scripts/deploy/deploy-staging.sh <branch> [--worker] [--sync-db] [--dry-run]
```

- `<branch>`：デプロイするブランチ（main / feature/xxx。origin に存在していること）
- `--worker`：テスト用 worker（スクレイパー）も起動
- `--sync-db`：先に本番 `data.db` → `data-test.db` スナップショット
- `--dry-run`：手順だけ表示
- 実行後、API（:8081）の smoke（health / archive stats / videos / search）を自動実行。失敗時は exit 1

### promote.sh

```
bash scripts/deploy/promote.sh <branch> [--sync-staging] [--no-restart] [--dry-run]
```

- **fast-forward 可能な場合のみ** 昇格。staging で検証したコミットと同一ツリーを本番で動かす
- `--sync-staging`：昇格後に staging を新しい main へ追従
- `--no-restart`：本番プロセスの再起動をスキップ
- `--dry-run`：手順だけ表示
- 本番リポジトリに**未コミット変更があると中止**します（先に commit / stash する）
- ff できない（本番 main が進んでいる）場合も中止し、`<branch>` の rebase → staging 再検証を促す

### promote 後の自動処理

1. 本番 pm2 全再起動（`bash scripts/deploy/restart.sh all`）
2. 本番 API（:8080）の smoke（health / archive stats / videos / search）
3. （--sync-staging 時）`deploy-staging.sh main` で staging を最新化

## 運用ルール

1. **本番の pull / 昇格は必ず `--ff-only`**（commitを落とさない）
2. **staging の DB はスナップショット運用**：`bash scripts/deploy/sync-test-db.sh`
   - staging API 起動中の同期はロック競合の恐れがあるため `pm2 stop mai-push-api-test` してから実行が安全
3. **テスト通知（実機への push）は禁止**。staging は DISABLE_NOTIFICATIONS=1 だが、DB に直接書いたテスト行は本番に同期しないこと
4. 環境差を `.env` に増やさない（`NODE_ENV` とプロセス引数で吸収）
5. sudo が必要な作業（nginx / cloudflared の設定反映）はエージェント不可 → 手動で行う
   - nginx（staging vhost）: `sudo bash /home/yuzuki/koinoyamai.love-test/scripts/nginx/setup-staging-nginx.sh`
     - ⚠️ **先に `/etc/nginx/snippets/mai-security-headers.conf` を配置すること**。
       `mai-test.conf` は `include /etc/nginx/snippets/mai-security-headers.conf;` を含むため、
       スニペットが無い状態で差替えると `nginx -t` が失敗して**サイト全体が止まる**。
       setup-staging-nginx.sh は配置 → 差替 → `nginx -t` → reload の順で行う。
     - 手動で差替える場合:
       ```bash
       sudo mkdir -p /etc/nginx/snippets
       sudo install -m 644 scripts/nginx/mai-security-headers.conf /etc/nginx/snippets/
       sudo cp scripts/nginx/mai-test.conf /etc/nginx/mai-test.conf && sudo nginx -t && sudo systemctl reload nginx
       ```
   - nginx（本番の公開ページにもセキュリティヘッダを付ける）:
     `bash ~/apply-nginx-security-headers.sh`（dry-run）→ `sudo bash ~/apply-nginx-security-headers.sh --apply`
     - パッチは `scripts/nginx/apply-security-headers.py`（冪等・除外理由を報告）
     - `nginx` の `add_header` は **Location 内に 1 つでもあれば server レベルを継承しない**ため、
       include を各 Location から入れる必要がある（`AGENTS.md §11`）
   - cloudflared: config.yml はリモート管理のためダッシュボードの Public Hostname で変更
6. **PHP コア RCE 期間の隔離・復旧も sudo 必須 → 手動で行う**（`AGENTS.md §5.1`）
   - 隔離: `sudo bash scripts/nginx/apply-maintenance.sh --on`（公開 PHP ページを 503 化。解除は `--off`）
   - 復旧: `sudo bash scripts/php/patch-and-resume.sh`（パッチ適用 → 検証 → 解除 → pm2 再開 → 最終確認）
7. **nginx への新ルート追加も sudo 必須 → 手動で行う**（`AGENTS.md §6.9`）
   - 旅先ディスプレイ: `sudo bash scripts/nginx/apply-display-location.sh --apply`
     （冪等・fail-closed・`nginx -t` 失敗時は自動復元。資産の配置は
     smart-display リポジトリの `scripts/deploy-display.sh --apply` で行う）
8. **PHP ランタイムの更新も sudo 必須 → 手動で行う**（`AGENTS.md §5.1`）
   - `bash scripts/php/apply-php-security-patch.sh`（dry-run）→ `sudo bash ... --apply` → `bash scripts/php/verify-php-security-patch.sh`
   - 判定は `php -v` ではなく Debian changelog の CVE 記載で行う（Ubuntu は upstream 版番号が変わらない）
   - 緊急 RCE (CVE-2026-109618 / 109619) の詳細は `docs/SECURITY.md`
8. **PHP の実行時ハードニングも sudo 必須 → 手動で行う**（`AGENTS.md §5.1`・2026-10-21 追加）
   - `bash scripts/php/apply-php-hardening.sh`（dry-run・事前チェック付き）→
     `sudo bash scripts/php/apply-php-hardening.sh --apply` →
     `bash scripts/php/verify-php-hardening.sh`（実測検証・root 不要）
   - 設定: `disable_functions` / `open_basedir` / `ffi.enable=preload` /
     **`enable_post_data_reading=Off`（multipart パーサ無効）** / `post_max_size` 縮小
   - 前提: `webui/*.php` は POST を読まない・`mb_*` を使わない（**回帰テスト [10] が固定**）
9. **旧 PHP の nginx 実行ガードも sudo 必須 → 手動で行う**（`AGENTS.md §5.1`・2026-10-21 追加）
   - `sudo bash scripts/nginx/apply-php-exec-guard.sh --apply`
     （elza vhost の PHP 実行を 404 にする。**本番 :1717 / staging :80 は対象外**）

## セキュリティ履歴（2026-09-20 実施）

- GitHub公開リポジトリの履歴に Twitch Client Secret / App Access Token / Discord Webhook URL が混入していたため：
  1. 認証情報を `.env` へ移動（community化対応：ecosystem.config.js / healthcheck.sh 直書きを排除）
  2. Twitch Client Secret・App Access Token・Discord Bot Token を再発行（旧値は無効化済み）
  3. `git-filter-repo` で全履歴から旧値を除去し force push（SHA変更済み）
- 作業フォルダ／本番／staging とも `git reset --hard origin/main` 済み
- 履歴の空き blobs はローカル `git gc --prune=now` で消去済み

## ロールバック

```bash
git log --oneline -10 main            # 戻り先の commit を確認
git reset --hard <commit> && git push --force origin main   # ※force push は慎重に
```

または promote 直後なら `git revert` で新しい commit を積んでから通常 push。

## コード行数集計方法（updateLogs の "lines"）

- 公式コマンド: `bash scripts/ops/count-lines.sh [<git-rev>]`
  - 引数なし = 現在の作業ツリー、引数あり = **そのコミット時点の中身**を集計
  - 過去時点は `git archive` で当時のファイルを一時展開してから cloc を回す
    （ファイル名だけ過去・中身は作業ツリーから読む方式だと、後から増えた行が
    過去値に混ざって 09-19 と 09-10 が同値になる等の誤りが出るため）
- 集計対象: **git 追跡ファイルのみ**（`git ls-files` / `git archive`）
- 除外（生成物・素材・アプリ本体は行数に含めない）:
  - `webui/dist/` 全体（esbuild の minify 済み出力）
  - `*.min.js` / `*.min.css`（minify 済みファイル）
  - `package-lock.json`（npm が自動生成するロックファイル）
  - `*.svg`（アイコン素材）
  - `webui/compare.html`（比較レポート用の自動生成HTML）
  - `mai_notification/`（Android アプリ）
  - `Windows/`（デスクトップアプリ）
  - ※ アプリ2種は git 追跡の開始時期が違う（Windows 2026-06-14 /
    Android 2026-09-27）ため、除外しないとグラフに段差が出る
- 表示形式: cloc の `SUM` 行 `code` 列（例: `33,924` → "33,924"）
- updateLogs には**その日の値を絶対値として記録**する（前日値に増分を足す等の累積計算はしない）

### 背景（2026-09-21 修正）

- 09-19 までは手書きソースのみの値（29,663 等）だったが、09-20 の集計で集計対象が「作業ツリー全体」にすり替わり 73,600 まで水増しされていた
- 09-21 にそれを起点として 80,633 と連鎖誤記したため、コミット対象の cloc 実測（47,299）に一旦修正
- さらに生成物（dist/min/lock/svg/compare.html）も除外すべきと判明し、上記の `count-lines.sh` 方式に統一

### 背景（2026-09-28 修正・アプリ除外）

- Android アプリが 09-27 に git 追跡開始されたことで 38,996 → 43,445 と
  約4,400行ぶん跳ね上がり、実態とは無関係な段差がグラフに出た
- 原因は `count-lines.sh` がアプリを除外していなかったこと（`git ls-files`
  ベースなので追跡された瞬間に自動的に計測対象になっていた）
- 対応: 除外に `mai_notification/` と `Windows/` を追加し、**過去エントリも
  同じ基準に揃えた**（過去ツリー全体を再計算すると古いツリーのノイズを拾って
  458,785 のような誤値になるため、記録値から「その日のアプリ行数」を引く方式）
- 適用後は 2026-09-05 = 24,825 → 2026-09-28 = 37,761 と単調増加