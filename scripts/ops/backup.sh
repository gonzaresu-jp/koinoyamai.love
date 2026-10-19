#!/bin/bash
# 日次バックアップ: 一貫性のある DB スナップショット + .env を backups/ へ保存
# cron: 0 3 * * * /var/www/html/koinoyamai.love/scripts/ops/backup.sh
# 保存先は Web 公開ツリーの外（/var/lib/mai-push/backups）。nginx で deny 済みでも、
# 公開ツリー内には秘密情報の実体を置かない方針（2026-09 セキュリティ強化）。
set -euo pipefail

BASE="/var/www/html/koinoyamai.love"
BACKUP_DIR="/var/lib/mai-push/backups"
DB_PATH="$BASE/data.db"
ENV_PATH="$BASE/.env"
RETENTION_DAYS=30
SQLITE_BIN=$(command -v sqlite3 || echo /usr/bin/sqlite3)

mkdir -p "$BACKUP_DIR"

TODAY=$(date +%Y%m%d)
DB_OUT="$BACKUP_DIR/data-$TODAY.db"
ENV_OUT="$BACKUP_DIR/env-$TODAY.env"

# WAL を含む一貫したスナップショット（稼働中でも安全な backup API を使用）
"$SQLITE_BIN" "$DB_PATH" ".timeout 8000" ".backup '$DB_OUT'"

# 書き出したスナップショットの整合性を確認
"$SQLITE_BIN" "$DB_OUT" "PRAGMA integrity_check;" | grep -q "^ok"

# シークレット類も保存（同じマシン内・所有者権限のみ）
if [ -f "$ENV_PATH" ]; then
  cp -p "$ENV_PATH" "$ENV_OUT"
fi

# 保持日数を超えた古いバックアップを削除
find "$BACKUP_DIR" \( -name "data-*.db" -o -name "env-*.env" \) -mtime +$RETENTION_DAYS -delete

echo "[$(date '+%F %T')] backup done: $(basename "$DB_OUT") ($(stat -c%s "$DB_OUT") bytes) + $(basename "$ENV_OUT")"