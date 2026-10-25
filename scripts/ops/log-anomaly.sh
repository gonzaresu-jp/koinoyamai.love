#!/bin/bash
# 日次ログ異常検知: pm2 ログのエラー率を監視し、異常があれば Discord 通知する
# cron: 0 6 * * * /var/www/html/koinoyamai.love/scripts/ops/log-anomaly.sh >> /var/www/html/koinoyamai.love/logs/log-anomaly.log 2>&1
set -uo pipefail

BASE="/var/www/html/koinoyamai.love"
PM2_LOG_DIR="$HOME/.pm2/logs"
STATE_FILE="/var/lib/mai-push/log-anomaly-state.json"
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
    local color=3066993
    [ "$level" = "ERROR" ] && color=16711680
    [ "$level" = "WARN" ] && color=16776960
    curl -s -H "Content-Type: application/json" \
         -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: mai-push-log-anomaly (https://koinoyamai.love, 1.0)" \
         -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
         -d "{\"embeds\":[{\"title\":\"$title\",\"description\":\"$desc\",\"color\":$color,\"footer\":{\"text\":\"Host: $HOSTNAME | log-anomaly\"},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}" > /dev/null 2>&1
}

log() { echo "[$(date '+%F %T')] $*"; }

# --- 監視対象プロセス ---
PROCS="mai-push-api mai-push-worker discord-bot"

# --- エラーパターン ---
# これらにマッチする行を「エラー」としてカウントする
ERROR_PATTERNS="ERROR|Error:|error:|FATAL|fatal|Uncaught|uncaught|Exception|SQLITE_BUSY|ECONNREFUSED|ETIMEDOUT|AbortError|TypeError|ReferenceError|SyntaxError|Cannot find module|MODULE_NOT_FOUND"

# --- 過去24時間のエラー数をカウント ---
count_errors() {
    local proc="$1"
    local log_file="$PM2_LOG_DIR/${proc}-error.log"
    local count=0
    if [ -f "$log_file" ]; then
        count=$(grep -cE "$ERROR_PATTERNS" "$log_file" 2>/dev/null || true)
        count=${count:-0}
    fi
    # ローテートされたファイルも確認（過去24時間以内にローテートされたもの）
    for rotated in "$PM2_LOG_DIR"/${proc}-error__*.log; do
        [ -f "$rotated" ] || continue
        # ファイルの mtime が 1 日以内なら含める
        if find "$rotated" -mtime -2 2>/dev/null | grep -q .; then
            local rc
            rc=$(grep -cE "$ERROR_PATTERNS" "$rotated" 2>/dev/null || true)
            rc=${rc:-0}
            count=$((count + rc))
        fi
    done
    echo "$count"
}

# --- 重大エラーパターンの検出 ---
detect_critical() {
    local proc="$1"
    local log_file="$PM2_LOG_DIR/${proc}-error.log"
    local criticals=""
    if [ -f "$log_file" ]; then
        # 過去24時間の重大エラーパターンを抽出（最新 5 件）
        criticals=$(grep -E "Uncaught|FATAL|SQLITE_BUSY|ECONNREFUSED|MODULE_NOT_FOUND|Cannot find module" "$log_file" 2>/dev/null | tail -5)
    fi
    echo "$criticals"
}

# --- 状態ファイルの読み書き ---
load_state() {
    if [ -f "$STATE_FILE" ]; then
        cat "$STATE_FILE"
    else
        echo '{}'
    fi
}
save_state() {
    mkdir -p "$(dirname "$STATE_FILE")"
    echo "$1" > "$STATE_FILE"
}

# --- main ---
# 初回実行時はベースラインを記録するだけでアラートは送らない
FIRST_RUN=0
if [ ! -f "$STATE_FILE" ]; then
    FIRST_RUN=1
    log "初回実行: ベースラインを記録します（アラートは送りません）"
fi
STATE=$(load_state)
TODAY=$(date +%Y%m%d)
ALERT_NEEDED=0
ALERT_MSG=""

for proc in $PROCS; do
    CURRENT=$(count_errors "$proc")
    PREV=$(echo "$STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$proc',{}).get('count',0))" 2>/dev/null || echo "0")
    PREV=${PREV:-0}

    log "$proc: errors today=$CURRENT, yesterday=$PREV"

    # 異常判定: 前日の 2 倍以上、または前日 0 で今日 5 件以上
    ANOMALY=0
    if [ "$PREV" -gt 0 ] && [ "$CURRENT" -gt $((PREV * 2)) ]; then
        ANOMALY=1
    elif [ "$PREV" -eq 0 ] && [ "$CURRENT" -ge 5 ]; then
        ANOMALY=1
    fi

    # 重大エラーパターンの検出
    CRITICALS=$(detect_critical "$proc")
    if [ -n "$CRITICALS" ]; then
        ANOMALY=1
        CRIT_SUMMARY=$(echo "$CRITICALS" | head -3 | tr '\n' ' ' | cut -c1-200)
        ALERT_MSG="${ALERT_MSG}\\n**$proc**: $CURRENT 件 (前日 $PREV 件)\\n重大エラー: $CRIT_SUMMARY"
    elif [ "$ANOMALY" -eq 1 ]; then
        ALERT_MSG="${ALERT_MSG}\\n**$proc**: $CURRENT 件 (前日 $PREV 件) — 前日の 2 倍以上"
    fi

    if [ "$ANOMALY" -eq 1 ]; then
        ALERT_NEEDED=1
    fi
done

# 状態を更新
NEW_STATE="{"
FIRST=1
for proc in $PROCS; do
    CURRENT=$(count_errors "$proc")
    if [ $FIRST -eq 1 ]; then FIRST=0; else NEW_STATE="$NEW_STATE,"; fi
    NEW_STATE="$NEW_STATE\"$proc\":{\"count\":$CURRENT,\"date\":\"$TODAY\"}"
done
NEW_STATE="$NEW_STATE}"
save_state "$NEW_STATE"

if [ "$FIRST_RUN" -eq 1 ]; then
    log "初回実行: ベースライン記録完了（アラートスキップ）"
elif [ "$ALERT_NEEDED" -eq 1 ]; then
    send_alert "WARN" "Log Anomaly: エラー率が上昇" "$ALERT_MSG"
    log "ALERT sent: $ALERT_MSG"
else
    log "OK: 異常なし"
fi

exit 0
