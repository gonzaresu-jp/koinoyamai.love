#!/usr/bin/env bash
# scripts/ops/security-watch-cron.sh - セキュリティ監視の日次実行ラッパ（cron から叩く）
#
# 用途:
#   Node.js / PHP 8.3 / npm 依存 / OS パッケージの脆弱性・更新を機械判定し、
#   **新規に検出されたものだけ**を Discord と管理画面へ通知する。
#   （「管理者が偶然見つけないと気づけない」を解消する仕組み。AGENTS.md §5.2）
#
# 設計:
#   - 適用（パッチインストール・npm update・pm2 再起動）はしない。検知と通知のみ。
#   - flock で多重起動防止（1 回の実行は数分かかりうる）
#   - ログは logs/security-watch-YYYYMMDD.log に日別追記
#   - node は明示指定する（cron の PATH は /usr/bin/node = v18 EOL を掴む。AGENTS.md §5）
#
# 使い方（手動実行）:
#   bash scripts/ops/security-watch-cron.sh          # 実行
#   bash scripts/ops/security-watch-cron.sh --dry-run # 通知せず判定だけ
set -uo pipefail

ROOT="${SECURITY_WATCH_ROOT:-/var/www/html/koinoyamai.love}"
NODE_BIN="${SECURITY_WATCH_NODE:-/home/yuzuki/.nvm/versions/node/v24.22.0/bin/node}"
LOCK=/tmp/security-watch.lock
cd "$ROOT" || exit 1

exec 9>"$LOCK"
flock -n 9 || { echo "$(date '+%F %T') skip: another security-watch running" >> logs/security-watch-cron.log 2>/dev/null; exit 0; }

LOG="logs/security-watch-$(date +%Y%m%d).log"
{
  echo "=== $(date '+%F %T %Z') security-watch start ==="
  if [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: node が見つかりません: $NODE_BIN"
    exit 1
  fi
  "$NODE_BIN" scripts/security/security-watch.js "$@"
  RC=$?
  echo "=== $(date '+%F %T %Z') security-watch end (rc=$RC) ==="
  exit $RC
} >> "$LOG" 2>&1
