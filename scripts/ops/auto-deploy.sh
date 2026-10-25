#!/bin/bash
# 自動デプロイパイプライン: main の新コミットを検知し、staging → smoke test → 本番に反映する
#
# cron: */5 * * * * /var/www/html/koinoyamai.love/scripts/ops/auto-deploy.sh >> /var/www/html/koinoyamai.love/logs/auto-deploy.log 2>&1
#
# 前提:
#   - staging ツリーは /home/yuzuki/koinoyamai.love-test（canonical）
#   - 本番ツリーは /var/www/html/koinoyamai.love
#   - pm2 で mai-push-api / mai-push-api-test が稼働中
#
# 安全弁:
#   - 新コミットが無い場合は何もしない（exit 0）
#   - staging で smoke test が失敗したら本番には触らない
#   - 本番デプロイ後に smoke test が失敗したらロールバック（前コミットに戻す）
#   - 全ステップで Discord 通知
set -uo pipefail

PROD_DIR="/var/www/html/koinoyamai.love"
STG_DIR="/home/yuzuki/koinoyamai.love-test"
STATE_FILE="/var/lib/mai-push/auto-deploy-state.json"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.22.1/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="node"
SMOKE_TIMEOUT=15

env_val() {
    grep -m1 "^$1=" "$PROD_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d "\"'" | tr -d ' \r\n'
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
         -H "User-Agent: mai-push-auto-deploy (https://koinoyamai.love, 1.0)" \
         -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
         -d "{\"embeds\":[{\"title\":\"$title\",\"description\":\"$desc\",\"color\":$color,\"footer\":{\"text\":\"Host: $HOSTNAME | auto-deploy\"},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}" > /dev/null 2>&1
}

log() { echo "[$(date '+%F %T')] $*"; }

# --- 状態ファイルの読み書き ---
load_state() {
    if [ -f "$STATE_FILE" ]; then
        cat "$STATE_FILE"
    else
        echo '{"lastDeployedCommit":"","lastAttempt":""}'
    fi
}
save_state() {
    mkdir -p "$(dirname "$STATE_FILE")"
    echo "$1" > "$STATE_FILE"
}

# --- smoke test ---
# 戻り値: 0=pass, 1=fail
smoke_test() {
    local base="$1" label="$2"
    local ok=1
    # 1. health endpoint
    local health_code
    health_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$SMOKE_TIMEOUT" "$base/api/health" 2>&1)
    if [ "$health_code" != "200" ]; then
        log "smoke FAIL ($label): /api/health returned $health_code"
        ok=0
    fi
    # 2. archive search (basic)
    local archive_code
    archive_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$SMOKE_TIMEOUT" "$base/api/archive/videos?limit=1" 2>&1)
    if [ "$archive_code" != "200" ]; then
        log "smoke FAIL ($label): /api/archive/videos returned $archive_code"
        ok=0
    fi
    # 3. scraper-status (should have items)
    local status_code
    status_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$SMOKE_TIMEOUT" "$base/api/scraper-status" 2>&1)
    if [ "$status_code" != "200" ]; then
        log "smoke FAIL ($label): /api/scraper-status returned $status_code"
        ok=0
    fi
    # 4. notify endpoint (should reject without auth: 401 or 503, not 500/502)
    local notify_code
    notify_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$SMOKE_TIMEOUT" -X POST "$base/api/notify" -H "Content-Type: application/json" -d '{"test":true}' 2>&1)
    if [ "$notify_code" != "401" ] && [ "$notify_code" != "503" ] && [ "$notify_code" != "400" ]; then
        log "smoke FAIL ($label): /api/notify returned $notify_code (expected 401/400/503)"
        ok=0
    fi
    return $((1 - ok))
}

# --- main ---
cd "$PROD_DIR" || { log "ERROR: PROD_DIR not found"; exit 1; }

# 最新の origin/main を取得
git fetch origin main --quiet 2>&1
REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null)
LOCAL_HEAD=$(git rev-parse HEAD 2>/dev/null)
STATE=$(load_state)
LAST_DEPLOYED=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastDeployedCommit',''))" 2>/dev/null)

# 新コミットがあるか
if [ "$REMOTE_HEAD" = "$LAST_DEPLOYED" ]; then
    # 新コミットなし → 何もしない
    exit 0
fi

if [ "$REMOTE_HEAD" = "$LOCAL_HEAD" ] && [ "$REMOTE_HEAD" = "$LAST_DEPLOYED" ]; then
    exit 0
fi

log "=== 新コミット検出: $REMOTE_HEAD (前回: ${LAST_DEPLOYED:-none}) ==="
NEW_COMMITS=$(git log --oneline "$LAST_DEPLOYED..$REMOTE_HEAD" 2>/dev/null | head -5)
log "新コミット:"
echo "$NEW_COMMITS" | sed 's/^/  /'

save_state "{\"lastDeployedCommit\":\"$LAST_DEPLOYED\",\"lastAttempt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"

# --- Step 1: staging にデプロイ ---
log "Step 1: staging にデプロイ"
cd "$STG_DIR" || { log "ERROR: STG_DIR not found"; send_alert "ERROR" "Auto-Deploy: staging ツリーなし" "STG_DIR=$STG_DIR が見つかりません"; exit 1; }
git fetch origin main --quiet 2>&1
git reset --hard origin/main 2>&1 | tail -1
# node_modules の drift チェック
if ! "$NODE_BIN" scripts/deploy/check-node-modules-drift.js >/dev/null 2>&1; then
    log "WARNING: staging の node_modules に乖離あり"
fi

# staging API を再起動
pm2 restart mai-push-api-test --update-env >/dev/null 2>&1
sleep 3

# --- Step 2: staging で smoke test ---
log "Step 2: staging smoke test"
if smoke_test "http://127.0.0.1:8081" "staging"; then
    log "staging smoke test: PASS"
else
    log "staging smoke test: FAIL → 本番には触らない"
    send_alert "ERROR" "Auto-Deploy: staging smoke test 失敗" "コミット: $REMOTE_HEAD\\n新コミット:\\n$NEW_COMMITS\\n\\nstaging の smoke test が失敗しました。本番には反映していません。"
    save_state "{\"lastDeployedCommit\":\"$LAST_DEPLOYED\",\"lastAttempt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"status\":\"staging-failed\"}"
    exit 1
fi

# --- Step 3: 本番にデプロイ ---
log "Step 3: 本番にデプロイ"
cd "$PROD_DIR" || { log "ERROR: PROD_DIR not found"; exit 1; }
PREV_COMMIT=$(git rev-parse HEAD)
git reset --hard origin/main 2>&1 | tail -1

# node_modules の drift チェック
if ! "$NODE_BIN" scripts/deploy/check-node-modules-drift.js >/dev/null 2>&1; then
    log "WARNING: 本番の node_modules に乖離あり → npm-deploy.sh --apply を実行"
    bash scripts/deploy/npm-deploy.sh --apply 2>&1 | tail -5
fi

# 本番 API を再起動
pm2 restart mai-push-api --update-env >/dev/null 2>&1
sleep 3

# --- Step 4: 本番で smoke test ---
log "Step 4: 本番 smoke test"
if smoke_test "http://127.0.0.1:8080" "production"; then
    log "本番 smoke test: PASS"
    save_state "{\"lastDeployedCommit\":\"$REMOTE_HEAD\",\"lastAttempt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"status\":\"success\"}"
    send_alert "INFO" "Auto-Deploy: 成功" "コミット: $REMOTE_HEAD\\n新コミット:\\n$NEW_COMMITS\\n\\nstaging + 本番の smoke test が PASS しました。"
else
    log "本番 smoke test: FAIL → ロールバック"
    # ロールバック
    git reset --hard "$PREV_COMMIT" 2>&1 | tail -1
    pm2 restart mai-push-api --update-env >/dev/null 2>&1
    sleep 3
    save_state "{\"lastDeployedCommit\":\"$PREV_COMMIT\",\"lastAttempt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"status\":\"rolled-back\"}"
    send_alert "ERROR" "Auto-Deploy: 本番 smoke test 失敗 → ロールバック" "コミット: $REMOTE_HEAD\\n前回のコミット ($PREV_COMMIT) に戻しました。\\n手動で確認してください。"
    exit 1
fi

log "=== デプロイ完了 ==="
exit 0
