#!/bin/bash
API_BASE="http://localhost:8080"
WORKER_BASE="http://localhost:3002"
# Discord 通知は Bot API 経由で送る。
# （DISCORD_WEBHOOK_URL は Discord 側で削除済み＝404 Unknown Webhook で、
#   従来このスクリプトの通知は全て無言で失敗していた）
# トークン類は .env から読む（GitHubに直接書かない。判定: FriendlyScanner流出検知対策）
# .env の値は二重引用符で書かれていることがあるため除去する。
env_val() {
    grep -m1 "^$1=" /var/www/html/mai-push/.env 2>/dev/null | cut -d= -f2- | tr -d "\"'" | tr -d ' \r\n'
}
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-$(env_val DISCORD_BOT_TOKEN)}"
DISCORD_CHANNEL_ID="${DISCORD_CHANNEL_ID:-$(env_val DISCORD_CHANNEL_ID)}"
HOSTNAME=$(hostname)
send_alert() {
    local level="$1" title="$2" desc="$3"
    if [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_CHANNEL_ID" ]; then
        echo "healthcheck: Discord Bot 設定が空のため通知をスキップ" >&2
        return 0
    fi
    local color=16776960
    [ "$level" = "ERROR" ] && color=16711680
    curl -s -H "Content-Type: application/json" \
         -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: mai-push-healthcheck (https://mai.honna-yuzuki.com, 1.0)" \
         -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
         -d "{
           \"embeds\": [{
             \"title\": \"$title\",
             \"description\": \"$desc\",
             \"color\": $color,
             \"footer\": {\"text\": \"Host: $HOSTNAME | healthcheck\"},
             \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
           }]
         }" > /dev/null 2>&1
}

# Check API (mai-push-api on 8080)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$API_BASE/api/health" 2>&1)
if [ "$HTTP_CODE" != "200" ]; then
    send_alert "ERROR" "API Down" "health endpoint returned HTTP $HTTP_CODE"
    exit 1
fi

# Check Worker (mai-push-worker on 3002)
WORKER_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$WORKER_BASE/api/health" 2>&1)
if [ "$WORKER_HTTP" != "200" ]; then
    send_alert "ERROR" "Worker Down" "worker health endpoint returned HTTP $WORKER_HTTP"
    exit 1
fi

# Check scraper status (at least one scraper should report)
RESULT=$(curl -s --max-time 10 "$API_BASE/api/scraper-status" 2>/dev/null)
ITEM_COUNT=$(echo "$RESULT" | python3 -c "import sys,json; data=json.load(sys.stdin); items=data.get('items') if isinstance(data,dict) else data; print(len(items) if isinstance(items,list) else 0)" 2>/dev/null)
if [ -z "$ITEM_COUNT" ] || [ "$ITEM_COUNT" -eq 0 ]; then
    send_alert "WARN" "scraper-status empty" "scraper-status API returned empty response"
    exit 1
fi
echo "[$(date)] healthcheck OK (${ITEM_COUNT} items)"
