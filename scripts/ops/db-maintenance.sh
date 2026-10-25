#!/bin/bash
# 週次 DB メンテナンス: VACUUM + ANALYZE + 古いデータのクリーンアップ
# cron: 0 4 * * 0 /var/www/html/koinoyamai.love/scripts/ops/db-maintenance.sh
# （verify-backup.sh と同じ時間帯。backup → verify → maintenance の順で実行される）
set -uo pipefail

BASE="/var/www/html/koinoyamai.love"
DB_PATH="$BASE/data.db"
SQLITE_BIN=$(command -v sqlite3 || echo /usr/bin/sqlite3)

env_val() {
    grep -m1 "^$1=" "$BASE/.env" 2>/dev/null | cut -d= -f2- | tr -d "\"'" | tr -d ' \r\n'
}
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-$(env_val DISCORD_BOT_TOKEN)}"
DISCORD_CHANNEL_ID="${DISCORD_CHANNEL_ID:-$(env_val DISCORD_CHANNEL_ID)}"
HOSTNAME=$(hostname)

send_alert() {
    local level="$1" title="$2" desc="$3"
    [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_CHANNEL_ID" ] && return 0
    local color=3066993
    [ "$level" = "ERROR" ] && color=16711680
    curl -s -H "Content-Type: application/json" \
         -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: mai-push-db-maintenance (https://koinoyamai.love, 1.0)" \
         -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
         -d "{\"embeds\":[{\"title\":\"$title\",\"description\":\"$desc\",\"color\":$color,\"footer\":{\"text\":\"Host: $HOSTNAME | db-maintenance\"},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}" > /dev/null 2>&1
}

if [ ! -f "$DB_PATH" ]; then
    send_alert "ERROR" "DB Maintenance: DB が見つかりません" "パス: $DB_PATH"
    echo "[$(date '+%F %T')] ERROR: DB not found: $DB_PATH" >&2
    exit 1
fi

BEFORE_SIZE=$(stat -c%s "$DB_PATH")
BEFORE_PAGES=$("$SQLITE_BIN" "$DB_PATH" "PRAGMA page_count;" 2>&1)

# 1. 古い scheduled_notifications を削除（30日以上前）
DELETED=$("$SQLITE_BIN" "$DB_PATH" "DELETE FROM scheduled_notifications WHERE created_at < datetime('now', '-30 days'); SELECT changes();" 2>&1)
# changes() が取れない場合は 0 とする
DELETED=${DELETED:-0}

# 2. ANALYZE（クエリプランナーの統計更新）
"$SQLITE_BIN" "$DB_PATH" "ANALYZE;" 2>&1
if [ $? -ne 0 ]; then
    send_alert "ERROR" "DB Maintenance: ANALYZE 失敗" "DB: $DB_PATH"
    echo "[$(date '+%F %T')] ERROR: ANALYZE failed" >&2
    exit 1
fi

# 3. VACUUM（ファイルサイズ縮小・断片化解消）
"$SQLITE_BIN" "$DB_PATH" "VACUUM;" 2>&1
if [ $? -ne 0 ]; then
    send_alert "ERROR" "DB Maintenance: VACUUM 失敗" "DB: $DB_PATH"
    echo "[$(date '+%F %T')] ERROR: VACUUM failed" >&2
    exit 1
fi

AFTER_SIZE=$(stat -c%s "$DB_PATH")
AFTER_PAGES=$("$SQLITE_BIN" "$DB_PATH" "PRAGMA page_count;" 2>&1)
SAVED=$(( (BEFORE_SIZE - AFTER_SIZE) / 1024 ))

send_alert "INFO" "DB Maintenance 完了" "削除: scheduled_notifications ${DELETED}件\\nサイズ: ${BEFORE_SIZE} → ${AFTER_SIZE} bytes (${SAVED} KB 削減)\\nページ: ${BEFORE_PAGES} → ${AFTER_PAGES}"

echo "[$(date '+%F %T')] db-maintenance OK: deleted=${DELETED} size ${BEFORE_SIZE}->${AFTER_SIZE} (${SAVED}KB saved)"
