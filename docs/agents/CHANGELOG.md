# AGENTS.md 変更履歴

> `AGENTS.md` 末尾にあった「最終更新」行を移設したもの（新しい順）。§番号は分割前と共通。

最終更新: 2026-11-27（§7.3.6 自動デプロイに安全ガードを追加: CI ゲート・flock・dirty / 未 push コミットがあれば停止・本番は ff-only・staging はローカル `staging` ブランチへ反映・失敗コミットの再試行抑止・ワーカーも再起動・自己書き換え対策・Bot トークンを引数に出さない。判定テスト `scripts/ci/test-auto-deploy.sh` を CI に追加。§6 に自動デプロイの再起動を例外として明記。§7.6 と回帰テスト [18] の「auto-deploy は 100644 据え置き」の古い記述を更新し [18] の検査対象に追加。`docs/DEVELOPMENT-WORKFLOW.md` の「staging の node_modules / .env は本番への symlink」の古い記述を実態（実体）に修正。dotenv のパス指定を server.js / lib/admin.js / bilibili-live.js で統一（§11）。INCIDENTS に記録）

最終更新: 2026-11-27（§14.2 pre-push の保護ブランチ判定を「今いるブランチ名」から「実際の push 先の ref（標準入力）」に変更。`agent/x:main` や別ブランチからの main への push を止める。秘密値の検査範囲も push する ref ごとに算出。判定テスト `scripts/ci/test-pre-push.sh` を CI に追加。新規ブランチの秘密値検査を `secret-scan.sh --new`（リモートに無いコミットすべて）に。§7.3 の記述を更新。§14.1 にスカッシュマージ後のブランチ削除（`-D`）の注意を追記）

最終更新: 2026-11-27（`docs/agents/INCIDENTS.md` を新設し、各章に散らばっていた事故 12 件を集約（§0 の索引に追加）。§2.1「操作の 3 段区分（常にやる / 確認してからやる / 絶対にやらない）」を新設。§2 の「DISABLE_NOTIFICATIONS=1 固定。この設定を1に戻すな」の矛盾した表記を「0 にするな（外すな）」に修正）

最終更新: 2026-11-27（ルールを仕組みで守る 3 層を追加（§13）: Claude Code の PreToolUse ガード `.claude/hooks/guard-bash.sh` ＋ `guard-rules.txt`（本番 `/api/notify` の送信を拒否、本番 pm2・nginx / 依存の `--apply`・systemctl は確認、`--no-verify`・手作業の `SKIP_PREPUSH=1`・main / staging への push を拒否）と判定テスト `scripts/ci/test-guard.sh`。秘密値の検出 `scripts/ci/secret-scan.sh` を CI と pre-push（コミットごと）に追加（§3）。§12 に更新先を追加）

最終更新: 2026-11-27（nginx 設定をテンプレート生成方式へ移行（フェーズ2）:§6.7 の admin/Tailnet 反映手順を `scripts/nginx/templates/` + `deploy.sh` に更新し、旧 `apply-*` パッチ群を `scripts/archive/nginx-apply/` へ退避。§5.1 / §11 / `docs/ARCHITECTURE.md` / `docs/SECURITY.md` / `docs/DEVELOPMENT-WORKFLOW.md` の nginx 手順も新手順へ追随。メンテナンス ON/OFF（`apply-maintenance.sh`）は状態切替のため現役のまま）

最終更新: 2026-11-27（AGENTS.md を必読ルール＋索引（§0）と `docs/agents/` に分割（#107）/ 回帰テストを `scripts/ops/regression/NN-*.js` に分割し `--only` を追加（#109）/ §13 の「小さな修正は main へ直接 push 可」を §14.1 に合わせて「すべて PR 経由・独立レビューは感度の高い変更のみ」に統一。`SKIP_PREPUSH=1` は日次 cron 専用と明記）

最終更新: 2026-11-09（§7.8 バックアップの別ホスト複製を新設：`scripts/ops/backup-offsite.sh` が nassy の別ディスク `/mnt/4TB/mai-push-backups` へ `data-*.db` / `env-*.env` を複製し、最新ファイルの sha256 一致を検証。失敗時は Discord 通知・flock で多重起動防止・リモート保持 90 日。世代整理は `env-*.env` の mtime が古いまま（`cp -p`）なので **ファイル名の日付**で判定する。§7.6 の cron 表への登録は本番反映後。§12 に更新先を追加）

最終更新: 2026-11-06（§6.7 まいAI チャットを elza vhost で tailnet/LAN 限定配信するルールを追加：scripts/nginx/apply-mai-chat-elza.sh ＝ 2026-11-06 に admin.html の「まいAI チャットを開く」が 404 になっていた原因＝elza vhost に chat 系 location が無かったことへの対処。§12 の nginx 行に §6.7 を追記）

最終更新: 2026-10-25（§14 作業ツリー分離の運用を新設：canonical staging tree は `staging` ブランチ固定・per-session worktree（`scripts/ops/new-worktree.sh`）・ブランチ命名規約・node_modules の symlink 共有・pre-push で `main`/`staging` への直接 push を拒否。背景は 2026-10-24 の共有ツリー事故（PR #83 のコミット混入）。§12 に更新先を追加）

最終更新: 2026-10-24（§11 push ガードの**独立レビュー指摘を修正**：①無効化インスタンス（`PUSH_GUARD_DISABLED=1`）が `ReferenceError` で**全通知が黙って全滅**する状態を解消（判定関数をモジュールスコープへ移動＋**実際に呼ぶ**回帰テストを追加）②env のチューニング（`PUSH_GUARD_CACHE_TTL_MS` / `PUSH_GUARD_TIMEOUT_MS`）を実装（文書には有ると書かれていたが未実装）③タイムアウトのタイマーを finally で `clearTimeout`（成功時にもプロセスを掴み続けない）④`inflight` の登録順を修正し lookup の同期 throw でも再解決できるように。回帰テスト [17] を 18 → 22 項目に拡充し 276 項目）

最終更新: 2026-10-24（§11 push エンドポイントの**送信前の DNS 解決検証**を追加（`lib/push-endpoint-guard.js`）。`publicHttpUrl` はホスト名の文字列しか見ないため残っていた **DNS rebinding**（ドメインで内部 IP に解決してサーバーに内部へ POST させる経路）を、送信直前の `dns.lookup` で遮断。解決先が private / loopback / link-local / CGNAT / IPv6 ULA 等なら**送信しない**（fail-closed・解決不能・時間切れも拒否）。拒否は `[push-guard]` のログで可視化し**既存の登録行は削除しない**。30 秒キャッシュ・無効化は `PUSH_GUARD_DISABLED=1` のときだけ（既定は有効）。回帰テスト [17] を追加し 270 項目）

最終更新: 2026-10-23（§5 依存更新：`ip-address` 10.7.4 / **firebase-admin 14.5.0**（v14 は名前空間 API 廃止＝モジュラー API へ移行）/ **puppeteer 25.16.0**（`browser.isConnected()` 廃止 → `.connected`）。未使用の `puppeteer-extra` 系を削除し npm audit 17→1 / §5.2 security-watch の PHP 判定を **Ubuntu CVE トラッカー準拠**に（not-affected / ignored を対象外に・取得失敗は fail-closed）/ §5.3 ハニーポットの**可視化**を追加：管理画面「ハニーポット」タブ＋`GET /api/admin/honeypot`（`requireAuth`・公開ドメインは 403）・`services/honeypot-report.js`（honey.log を直接集計・**日次ローテートの .1/.gz も読む**・自機テスト除外・canary token はマスク・`previousCanaryPaths` も canary_used）・`services/geoip.js`（Team Cymru の DNS で国/ASN/組織名・IPv6 対応・JSON キャッシュ・合計 3 秒で打ち切り）・時刻は JST 固定 / §12 に更新先を追加）

最終更新: 2026-10-23（§11 外部入力の**境界バリデーション**（`lib/validate.js`・依存ゼロ）を導入し `/api/notify` の data・管理ログイン・push endpoint に入れた。**無認証 SSRF**（任意 endpoint 登録 → 内部 URL への POST）を登録時＋送信直前（`services/notification.js` / `src/core/milestone.js`）の 3 箇所で遮断（IPv6 は角括弧を外して nibble 列で判定・IPv4-mapped の 16 進表記も IPv4 として判定）／`/api/android/send-test` にレート制限／OAuth エラーを text/plain／YouTube webhook の Invalid Date／rag の video_id 検証 / 型は **TypeScript を入れず `@ts-check` + JSDoc** で部分導入（notify-sign・admin・validate・geoip）／§12 に更新先を追加）

最終更新: 2026-10-22（§5.3 ハニーポット（偽物の秘密ファイル）を新設：scripts/security/honeypot-setup.sh で偽物を生成・scripts/nginx/apply-honeypot.sh で nginx に配信・scripts/security/honeypot-watch.js が取得/canary使用を通知 / §10.2 配信開始アラーム（Android v1.7.3）を新設：AlarmManager.setAlarmClock による端末内アラーム・exact alarm 権限・TZ 混在の扱い・標準アラームへの補助経路 / §5.1 PHP 実行時ハードニングを拡張：scripts/php/apply-php-hardening.sh（enable_post_data_reading=Off で multipart パーサ無効・ffi.enable=preload で FFI 迂回を塞ぐ・post_max_size 縮小）と scripts/php/verify-php-hardening.sh（実測検証）を追加／scripts/nginx/apply-php-exec-guard.sh で elza vhost の PHP 実行を 404 化／mbstring は意図的に未導入（webui/_mb.php で代替）／§11 に PHP の「読まない・実行しない」規約を追加／§5 のリリース時刻の誤記（23:00 UTC→14:00 UTC）を修正 / §5.1 PHP コアの緊急 RCE 期間の対応（メンテナンスモードで公開 PHP ページを 503 化・patch-and-resume.sh で復旧）を追加 / §5 Node.js を v24.22.1 に更新（2026-10-21 の security release）・パッチ版移行スクリプト scripts/deploy/migrate-node-patch.sh を追加（pm2 save 必須・旧 ~/migrate-*.sh は v24.22.0 固定で参照先ではない） / §6.9 旅先ディスプレイ（/display/）を新設：nginx の location 追加手順・同一オリジン配信の理由・API の start_time の TZ 混在注意 / §12 に nginx 新ルート追加時のドキュメント先を追加 / §5 依存更新（npm audit fix で critical 1→0・未使用の firebase クライアント削除）と本番反映経路 scripts/deploy/npm-deploy.sh・check-drift.sh の node_modules 乖離検出を追加 / §5.1 PHP ランタイム（php-fpm 8.3）を新設：CVE-2026-109618/109619 の緊急パッチ適用手順・scripts/php/・Ubuntu バックポート時の判定方法 / §5 Node.js を v24.22.0 に統一：pm2 全プロセス・pm2 デーモン・他プロジェクト 5 本・pi-vector.service・cron スクリプト・CI を明示指定。EOL だった v20/v18 の排除 / §9 pi-vector の ExecStart 更新 / §11 ネイティブビルドの基準を v24 に / §13 独立レビューの結果は必ず PR コメントに投稿するルールを追加（指摘原文・対応表・実測根拠を残す））

最終更新: 2026-10-20（§7.1 ファイル権限検査を追記（umask 077 の pull で php が 500）/ §10 UI コールバックの例外境界ルールを追記（Issue #10）/ §10 待ちタイマーの連打による延長禁止（v1.8.5 / Issue #14）/ §10.1 アプリリリース手順を追記：Windows publish→Inno Setup／Android はネットワークドライブで gradle ビルド不可＝ローカルへコピー / §7.1 verify-deploy の比較元を :1717 へ・§7.4 staging worktree の自動解決）

最終更新: 2026-10-19（§11 規約・§12 更新ルール・§13 GitHub運用を追記 / docs/ARCHITECTURE.md 新設 / main 保護設定）

最終更新: 2026-10-17（§10 v1.8.2 不安定問題修正メモ：トレイ透明アイコン=相対パス、クラッシュ=stowed exception 対策）

最終更新: 2026-10-13（§10 WinUI ネットワーク起動禁止を追記）

最終更新: 2026-10-10（§9 埋め込み停止中→稼働中に訂正 / CollabPoll 修正・md整理は別コミット）

最終更新: 2026-10-03（チャット読み上げ追加 / TTS systemd化・int8＋ONNX高速化 / latent-sliceストリーミング・不採用レコード / AGENTS.md §9 追加）
