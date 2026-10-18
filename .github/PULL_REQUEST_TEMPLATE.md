<!--
PR 本文テンプレート（AGENTS.md §13）。
感度の高い変更（DB/スキーマ・認証/HMAC・外部依存の更新・通知経路・外部API/インフラ）は
別エージェントによる独立レビュー＋ユーザー承認が必要です。
-->

## 変更概要
<!-- 何を・なぜ変えたか（1〜3行） -->

-

## 変更の種類
- [ ] 感度の高い変更（DB/スキーマ・認証/HMAC・依存・通知経路・外部API/インフラ）→ 独立レビュー必須
- [ ] 通常の変更（機能追加・修正・リファクタ）
- [ ] ドキュメントのみ
- [ ] データ更新のみ

## 検証内容
<!-- 実行したコマンドと結果。staging(8081) で確認したか。 -->

- [ ] `node --check <file>` / `php -l <file>`
- [ ] `npm test`（回帰テスト 21 項目）
- [ ] staging で動作確認（PORT 8081 / `DISABLE_NOTIFICATIONS=1`）
- [ ] 本番操作の前に `bash scripts/assert-port.sh prod|staging`

## 影響範囲
<!-- 影響するプロセス・ポート・DB・API・ユーザー -->

-

## ドキュメント・updatelogs の更新（AGENTS.md §12）
- [ ] 該当する `docs/*` を更新した（該当なしなら不要）
- [ ] ユーザーに見える変更なら `webui/updatelogs.php` を更新した（`lines` は `count-lines.sh` の実測値）
- [ ] `AGENTS.md` / `docs/ARCHITECTURE.md` の記載と実装が一致している

## 関連 issue
Closes #

## レビューの観点（AGENTS.md §13）
- [ ] バグ
- [ ] セキュリティ（HMAC/認証/secret 取扱い）
- [ ] `AGENTS.md §11` の規約（TZ固定 / bind 127.0.0.1 / dotenv per-dir / CSP self / fail-closed 等）
- [ ] テスト
