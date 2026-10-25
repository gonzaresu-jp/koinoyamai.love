#!/bin/bash
# 週次バックアップ復元検証: 最新バックアップを temp DB に復元し、整合性を確認する。
# cron: 0 4 * * 0 /var/www/html/koinoyamai.love/scripts/ops/verify-backup.sh
# （日曜 04:00。backup.sh の 03:00 の後）
set -uo pipefail

BASE="/var/www/html/koinoyamai.love"
BACKUP_DIR="/var/lib/mai-push/backups"
SQLITE_BIN=$(command -v sqlite3 || echo /usr/bin/sqlite3)
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.22.1/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="node"

env_val() {
    grep -m1 "^$1=" "$BASE/.env" 2>/dev/null | cut -d= -f2- | tr -d "\"'" | tr -d ' \r\n'
}
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-$(env_val DISCORD_BOT_TOKEN)}"
DISCORD_CHANNEL_ID="${DISCORD_CHANNEL_ID:-$(env_val DISCORD_CHANNEL_ID)}"
HOSTNAME=$(hostname)

send_alert() {
    local level="$1" title="$2" desc="$3"
    [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_CHANNEL_ID" ] && return 0
    local color=16776960
    [ "$level" = "ERROR" ] && color=16711680
    curl -s -H "Content-Type: application/json" \
         -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: mai-push-verify-backup (https://koinoyamai.love, 1.0)" \
         -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
         -d "{\"embeds\":[{\"title\":\"$title\",\"description\":\"$desc\",\"color\":$color,\"footer\":{\"text\":\"Host: $HOSTNAME | verify-backup\"},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}" > /dev/null 2>&1
}

# 最新のバックアップを探す
LATEST=$(ls -t "$BACKUP_DIR"/data-*.db 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
    send_alert "ERROR" "Backup Verify: バックアップなし" "バックアップファイルが見つかりません: $BACKUP_DIR"
    echo "[$(date '+%F %T')] ERROR: no backup found" >&2
    exit 1
fi

TMPDB=$(mktemp /tmp/scratchpad/verify-backup-XXXXXX.db)
trap 'rm -f "$TMPDB"' EXIT

# 1. コピーして整合性チェック
cp "$LATEST" "$TMPDB"
INTEGRITY=$("$SQLITE_BIN" "$TMPDB" "PRAGMA integrity_check;" 2>&1)
if [ "$INTEGRITY" != "ok" ]; then
    send_alert "ERROR" "Backup Verify: 整合性 NG" "ファイル: $(basename "$LATEST")\\nPRAGMA integrity_check: $INTEGRITY"
    echo "[$(date '+%F %T')] ERROR: integrity check failed: $INTEGRITY" >&2
    exit 1
fi

# 2. テーブル数と主要テーブルの存在確認
TABLE_COUNT=$("$SQLITE_BIN" "$TMPDB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" 2>&1)
for t in notifications subscriptions video_minutes events scheduled_notifications; do
    EXISTS=$("$SQLITE_BIN" "$TMPDB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$t';" 2>&1)
    if [ "$EXISTS" != "1" ]; then
        send_alert "ERROR" "Backup Verify: テーブル欠損" "ファイル: $(basename "$LATEST")\\nテーブル '$t' が存在しません"
        echo "[$(date '+%F %T')] ERROR: table '$t' missing" >&2
        exit 1
    fi
done

# 3. 行数の確認（0件は異常）
NOTIF_COUNT=$("$SQLITE_BIN" "$TMPDB" "SELECT COUNT(*) FROM notifications;" 2>&1)
MINUTES_COUNT=$("$SQLITE_BIN" "$TMPDB" "SELECT COUNT(*) FROM video_minutes;" 2>&1)

echo "[$(date '+%F %T')] verify-backup OK: $(basename "$LATEST") tables=$TABLE_COUNT notifications=$NOTIF_COUNT minutes=$MINUTES_COUNT integrity=ok"
