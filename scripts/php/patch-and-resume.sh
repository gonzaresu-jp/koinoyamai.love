#!/usr/bin/env bash
# patch-and-resume.sh — PHP 緊急パッチを適用し、停止していたサービスを再開する
#
# 目的（2026-10-21）:
#   PHP コアの緊急 RCE（CVE-2026-109618 / CVE-2026-109619・CVSS v4.0 9.2）の
#   修正版が出たあとに、**1コマンドで**
#     1) パッチを適用（php-fpm の再起動を含む）
#     2) 適用結果を検証
#     3) メンテナンスモードを解除（公開ページを再開）
#     4) 停止していた pm2 プロセスを再開
#     5) 最終確認（サイト / API / 各ポート）
#
# 実行（要 sudo）:
#   sudo bash scripts/php/patch-and-resume.sh
#
# 前提:
#   - upstream の修正版が既に出ていること（2026-10-21 14:00 UTC = JST 23:00 予定）
#   - メンテナンスモードが適用済みであること（`apply-maintenance.sh --on`）
#   - pm2 の dump が新 interpreter であること（`migrate-node-patch.sh` が pm2 save 済み）
#
# 安全性:
#   - どこかで失敗したら、その時点で止まってロールバック手順を提示する
#   - pm2 の操作は **yuzuki ユーザーとして**実行する（root の PM2_HOME を作らない）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PM2_USER="${PM2_USER:-yuzuki}"
PM2_HOME_DIR="${PM2_HOME_DIR:-/home/yuzuki/.pm2}"
NODE_BIN="${NODE_BIN:-/home/yuzuki/.nvm/versions/node/v24.22.0/bin/node}"
MAINT_SCRIPT="$REPO_ROOT/scripts/nginx/apply-maintenance.sh"

say() { echo; echo "=== $* ==="; }

[ "$(id -u)" -eq 0 ] || { echo "error: sudo で実行してください" >&2; exit 1; }

# --- 1) PHP パッチ適用 ---------------------------------------------------
say "1) PHP 緊急パッチの適用"
bash "$REPO_ROOT/scripts/php/apply-php-security-patch.sh" --apply

# --- 2) 検証 ------------------------------------------------------------
say "2) 適用結果の検証"
if bash "$REPO_ROOT/scripts/php/verify-php-security-patch.sh"; then
  echo "→ パッチ適用 OK"
else
  echo "error: 検証に失敗しました。php-fpm とサイトを確認してください" >&2
  exit 1
fi

# --- 3) メンテナンス解除 -------------------------------------------------
say "3) メンテナンスモードの解除"
if [ -f "$MAINT_SCRIPT" ]; then
  bash "$MAINT_SCRIPT" --off || echo "[WARN] メンテナンス解除に失敗（手動確認）" >&2
else
  echo "[WARN] $MAINT_SCRIPT が見つかりません（手動で解除してください）" >&2
fi

# --- 4) pm2 プロセスの再開 ----------------------------------------------
say "4) pm2 プロセスの再開"
pm2_as_user() {
  runuser -u "$PM2_USER" -- env HOME="/home/$PM2_USER" PM2_HOME="$PM2_HOME_DIR" \
    PATH="$NODE_BIN:$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    pm2 "$@"
}
echo "--- 現状 ---"
pm2_as_user ls 2>/dev/null | sed -n '1,20p' || true
echo "--- 再開 ---"
for name in mai-push-api mai-push-worker discord-bot mai-push-api-test; do
  echo "  start $name"
  pm2_as_user start ecosystem.config.js --only "$name" >/dev/null 2>&1 || echo "    [WARN] $name の起動に失敗" >&2
done
pm2_as_user save >/dev/null 2>&1 && echo "  [OK] pm2 save 完了" || echo "  [WARN] pm2 save に失敗" >&2

# --- 5) 最終確認 ---------------------------------------------------------
say "5) 最終確認"
sleep 3
for p in 8080 3002 8081 7080 3131 3333 5000 3100; do
  printf "  %-6s " "$p"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:${p}/" || echo "  (応答なし)"
done
printf "  公開   "; curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 15 https://koinoyamai.love/ || echo "(応答なし)"
printf "  PHP    "; curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 10 http://127.0.0.1:1717/index.php || echo "(応答なし)"

cat <<'TXT'

=== 完了 ===
以下を最終確認してください:
  bash scripts/php/verify-php-security-patch.sh
  bash scripts/deploy/assert-port.sh prod && bash scripts/deploy/assert-port.sh staging
  bash scripts/deploy/check-drift.sh

補足:
  - セキュリティ-watch が Canonical のバックポートを検知したら
    `sudo bash scripts/php/apply-php-security-patch.sh --apply` で追加の適用ができます。
  - 通知の抜け（停止中の分）はワーカー再開後に遡及検知される分のみです。
TXT
