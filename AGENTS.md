# AGENTS.md — AIエージェント向け 運用安全規則（koinoyamai.love）

このリポジトリで作業するAI/エージェントは**必ず本ファイルを読むこと**。
過去に複数回の重大事故が確認されている（2026-09-21〜22）。

> コード全体像・「どこに何があるか」は **`docs/ARCHITECTURE.md`**（アーキテクチャ早見表）に集約。
> 実装を探す前にまずこれを読む。構成を変えたら同ファイルも更新する。

## 0. このファイルの構成（索引）

本ファイルには**毎回の作業で必ず守るルール**（§1〜4・§6・§12〜14）だけを置く。
領域ごとの詳細は `docs/agents/` に分割してある。**§番号は分割前と共通**なので、
コードやドキュメント中の「AGENTS.md §N」は下の表で参照先を引くこと。
**該当領域を触る前に、対応するファイルを必ず読む。**

| § | 内容 | 場所 |
|---|---|---|
| §1〜4 | ポート位相・通知API・認証仕様・StartGuard | 本ファイル |
| §5, 5.1〜5.3 | 依存関係・Node.js・PHP ランタイム・security-watch・ハニーポット | [`docs/agents/05-dependencies.md`](docs/agents/05-dependencies.md) |
| §6 | 検証の作法 | 本ファイル |
| §6.5〜6.9 | 反映記録・loopback bind・admin は Tailnet 専用・YouTube Webhook・旅先ディスプレイ | [`docs/agents/06-network-and-routes.md`](docs/agents/06-network-and-routes.md) |
| §7, 7.1〜7.8 | 自動化スクリプト（verify-deploy・assert-port・pre-push・ドリフト検出・cron・バックアップ） | [`docs/agents/07-automation.md`](docs/agents/07-automation.md) |
| §8 | nassy 側パイプライン | [`docs/agents/08-nassy.md`](docs/agents/08-nassy.md) |
| §9 | RAG / 埋め込み / TTS メモ | [`docs/agents/09-rag-tts-notes.md`](docs/agents/09-rag-tts-notes.md) |
| §10, 10.1, 10.2 | Windows / Android アプリ（リリース手順・配信開始アラーム） | [`docs/agents/10-apps.md`](docs/agents/10-apps.md) |
| §11 | コーディング/設計規約（**コードを書く前に必読**） | [`docs/agents/11-coding-rules.md`](docs/agents/11-coding-rules.md) |
| §12〜14 | ドキュメント更新ルール・GitHub 運用・作業ツリー分離 | 本ファイル |
| — | 本ファイルの変更履歴（旧「最終更新」行） | [`docs/agents/CHANGELOG.md`](docs/agents/CHANGELOG.md) |

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
- トークン・鍵らしき文字列は `scripts/ci/secret-scan.sh` が検出する（CI と pre-push。pre-push は送信する
  **コミットごと**に見るので、途中で入れて後で消したものも止まる）。ダミー値の行には `secret-scan: allow`、
  公開前提の値（Firebase の Web 用 API キー等）のファイルは `.secret-scan-ignore` に理由つきで書く。

## 4. ワーカー二重起動防止（StartGuard）
- `main.js` は `[StartGuard]` プロセスロック（`/tmp` 等、`NODE_ENV` で test/prod 分離）を持つ。
- **pm2稼働中に手で `node main.js` を起動するとロックで拒否される**（仕様）。検証で二重起動させるな。

## 6. 検証の作法
- 変更後は `node --check <file>` → pm2 再起動（`--update-env`）→ **正しいポート**で `/api/health`。
- 本番 pm2 再起動は作業者の明示承認後にのみ実施。
- DB・history.json を触るテストは本番でやるな。staging でやれ。

## 12. ドキュメント更新ルール（ARCHITECTURE.md を腐らせない）

全体像は `docs/ARCHITECTURE.md`。**変更したら対応するドキュメントも同じコミットで更新する**。
下表の「AGENTS.md §N」のうち §5・§6.5〜6.9・§7〜11 は、§0 の索引にある `docs/agents/` の該当ファイルを更新する。

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
| 作業ツリー分離（worktree） | `AGENTS.md §14` / `scripts/ops/ensure-staging-tree.sh` / `scripts/ops/new-worktree.sh` / `scripts/hooks/pre-push` |
| エージェント用ガード（禁止・要確認コマンド） | `.claude/hooks/guard-rules.txt` / `scripts/ci/test-guard.sh`（例を足す）/ `AGENTS.md §13` |
| nginx への新ルート追加（例: `/display/`） | `AGENTS.md §6.7`（elza vhost）/ `§6.9` / `docs/ARCHITECTURE.md §4.5b` / `docs/SECURITY.md` |
| 外部入力の検証 / SSRF / 型の部分導入（`@ts-check`） | `AGENTS.md §11` / `docs/ARCHITECTURE.md §4.4` |
| アーカイブ API | `docs/ARCHIVE-ADMIN-SPEC.md` |
| ハニーポットの可視化（管理画面タブ・集計 API・GeoIP） | `AGENTS.md §5.3` / `docs/ARCHITECTURE.md §4.2, §4.3` |
| 予定抽出/スケジュール | `docs/SCHEDULE-FEATURES.md` |
| 依存パッケージ更新 | `AGENTS.md §5` |
| Android/WinUI アプリ | `AGENTS.md §10` / `webui/dl/*.json` |
| nassy 連携 | `AGENTS.md §8` |
| バックアップ（日次・別ホスト複製・復元検証） | `AGENTS.md §7.8` / `docs/ARCHITECTURE.md §4.6` |
| ユーザーに見える変更（機能追加/修正/挙動変更） | `webui/updatelogs.php`（**指示がなくても必ず更新**。下記） |

### updatelogs（更新履歴）は毎回更新する — 指示されなくても行うこと

`webui/updatelogs.php` は**ユーザー向けの更新履歴**。ユーザーが言わなくても、ユーザーに見える変更をしたら**必ず**更新する。

- `$updateLogs` の**先頭（新しい順）**に当日分のエントリを追加（同日内は既存先頭エントリへ追記）。
- 分類キー `fix` / `add` / `change` に、利用者目線の日本語で1行ずつ書く（内部実装の話は書かない）。
- `lines` は `bash scripts/ops/count-lines.sh` の実測 `SUM code` を**その日の絶対値**として記録する（**集計対象は git 追跡ファイルのみ**なので、新規ファイルを追加した日は `git add` 後＝HEAD の状態で測る。未追跡のままだと過小値になる）（前日に増分を足す等の累積計算は禁止）。集計対象・除外・過去値の扱いは `docs/DEVELOPMENT-WORKFLOW.md` の「コード行数集計方法（updateLogs の "lines"）」節。
- フッターの「Last updated」は最新日付から自動表示のため、追記のみで反映される。
- 対象外（更新不要）: 内部リファクタのみ・ドキュメントのみ・テストのみ・データ更新のみ。

**変更時のセルフチェック（commit/push 前）**:
- [ ] 上の表に該当するドキュメントを更新した（該当なしなら不要）
- [ ] ユーザーに見える変更なら `webui/updatelogs.php` を更新した（`lines` を `count-lines.sh` の実測値で）
- [ ] `node --check <file>` / `php -l <file>`（pre-push でも自動実行, `§7.3`）
- [ ] `npm test`（回帰テスト 281 項目）
- [ ] 本番操作の前に `bash scripts/deploy/assert-port.sh prod|staging`（`§7.2`）
- [ ] 感度の高い変更なら PR＋別エージェントの独立レビューを通した（`§13`）
- [ ] 秘密情報・DB・`webui/data` を不用意にコミットしていない
- [ ] AGENTS.md / ARCHITECTURE.md の記載と実装が一致している

## 13. GitHub 運用（issue / PR / レビュー, 2026-10-19 追加）

- リポジトリ: `gonzaresu-jp/koinoyamai.love`（public・`gh` 認証済み）。
- **PR＋独立レビューを必須とする変更（感度が高い）**:
  DB/スキーマ・認証/HMAC・外部依存の更新・通知経路・外部API/インフラ（nginx / tailscale / systemd）。
  → ブランチ → PR → **別エージェントによる独立レビュー** → ユーザー承認・マージ。
- それ以外（コメント/ログ/ドキュメント・小さな修正）も **ブランチ → PR → CI 通過 → マージ**で入れる（独立レビューは不要）。
  **main / staging への直接 push は禁止**（§14.1・pre-push フックが拒否）。例外は日次 cron の `webui/data` 自動 push のみ。
  `SKIP_PREPUSH=1` はこの cron 専用で、手作業の push に使わない（2026-11-27 に §14.1 と矛盾していた旧記述を統一）。
- **レビュー観点**: バグ、セキュリティ（HMAC/認証/secret 取扱い）、`§11` の規約、テスト、`§12` のドキュメント・updatelogs 更新漏れ。
- 基本の流れ:
  1. 大きめの作業・不具合は **issue 化**（`gh issue create`）。既存: #1 ドメイン移行 / #2 リポジトリ名リネーム。
  2. ブランチを作成して実装（`feature/xxx`）。
  3. 検証（`§7`）後 `gh pr create`。PR 本文に **変更概要 / 検証内容 / 影響範囲 / 該当ドキュメント・updatelogs の更新** を記載（`.github/PULL_REQUEST_TEMPLATE.md` が自動適用）。
  4. 別エージェントでレビュー → 指摘対応。**レビュー結果は必ず PR コメントに投稿する**（下記）。
  5. ユーザーが承認・マージ（`gh pr merge`）。
- **独立レビューの結果は必ず PR コメントに投稿する（2026-10-21 追加）**:
  - 適用範囲: **感度の高い変更で独立レビューを行った場合**。
    独立レビュー不要の PR（コメント/ログ/ドキュメント・小さな修正）は対象外。
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
- **ルールを仕組みで守る 3 層（2026-11-27 追加）**:
  1. エージェントのコマンド: `.claude/hooks/guard-bash.sh`（Claude Code の PreToolUse）が `.claude/hooks/guard-rules.txt`
     に従い止める（deny）/ ユーザーに確認する（ask）。本番 `/api/notify`（§2）・本番 pm2 の再起動（§6）・
     nginx / 依存の `--apply`・`--no-verify`・手作業の `SKIP_PREPUSH=1`・main / staging への push など。
     判定できないときは止める。**Claude Code 以外の AI ツール（OpenCode 等）には効かない**。
  2. git: `scripts/hooks/pre-push` が保護ブランチへの push と、送信するコミット中の秘密値を止める（どのツールにも効く）。
  3. CI: 秘密値の検出とガードの判定テストを PR ごとに実行する。
  ガードに止められたら回避せず、理由を添えてユーザーに判断を仰ぐ。ルールを変えたら `scripts/ci/test-guard.sh` に例を足す。

## 14. 作業ツリー分離（2026-10-25 追加）

複数セッション（エージェント含む）が **同じ作業ツリーを共有すると、branch switch が他セッションの
ファイルまで書き換える**。2026-10-24 に 2 回発生した（staging アプリのコードが切り替わる /
PR に無関係なコミットが混入する）。以後、物理的に分離する。

### 14.1 ルール（必須）

- **canonical staging tree（`/home/yuzuki/koinoyamai.love-test`）は `staging` ブランチ固定**。
  `git checkout` で切り替えるな（`scripts/ops/ensure-staging-tree.sh` で検査）。
- **すべての作業（エージェント含む）は per-session worktree で行う**。
  作成: `bash scripts/ops/new-worktree.sh <slug>` → `/tmp/opencode/<slug>/worktree` に作成され、
  `agent/<slug>` ブランチが切られる。`source /tmp/opencode/<slug>/env.sh` してから作業する。
- **ブランチ命名**: `agent/<slug>`（new-worktree.sh が作成）/ `feature/<slug>` / `fix/<slug>`。
  `main` / `staging` への直接コミット・push は禁止（pre-push フックが拒否）。
- **node_modules は canonical staging ツリーから symlink（読み取り専用）**。
  `npm install` は canonical ツリーで 1 回だけ実行する（worktree で実行すると canonical を汚す）。
  依存を変える作業は PR で行い、本番反映は `npm-deploy.sh` 経由。
- **PR 本文に「この PR が含むべきファイル一覧」を書く**。レビュアーは `git diff --stat` で
  混入を検出する（PR #83 で実際に機能した）。
- **後始末**: `git -C /var/www/html/koinoyamai.love worktree remove <path>` で worktree を削除する。

### 14.2 ツール

- `scripts/ops/ensure-staging-tree.sh [dir]` … canonical ツリーが staging ブランチかを検査（exit 1 で違反）。
  **手動で呼ぶ安全確認用**（deploy / テスト前）。cron / pre-push からは呼ばない
  （staging ツリーが作業中ブランチ上だと毎回 fail して Cron が死ぬため）。
- `scripts/ops/new-worktree.sh <slug> [base-ref]` … worktree を作成し、env.sh を出力する。
- `scripts/hooks/pre-push` … `main` / `staging` への直接 push を拒否するガードを追加（§13 の運用を機械化）。
> detached HEAD では `git branch --show-current` が空を返すため、ガードは exit 1（fail-closed）になる。安全側に倒れるので問題ない。

### 14.3 node_modules の共有方針

- symlink は読み取り専用。`npm install` は canonical ツリーでのみ実行する。
- worktree で依存が必要になった場合は `NODE_PATH` を canonical ツリーに向ける（`env.sh` が設定）。
- 依存を変える PR は canonical ツリーで `npm install` → テスト → commit → PR → 本番は `npm-deploy.sh`。

### 14.4 staging アプリの再起動

- canonical ツリーが更新されたら `mai-push-api-test` を手動で再起動する（自動化は将来の課題）。
- 作業中は staging アプリのコードが切り替わらないよう、canonical ツリーを動かさない。

