#!/bin/bash
# Node.js バージョン追従の自動化
# security-watch が新 LTS / security release を検出した際に、
# nvm で新版をダウンロードし、migrate-node-patch.sh の dry-run を実行する。
#
# cron: 0 5 * * * /var/www/html/koinoyamai.love/scripts/ops/node-version-check.sh >> /var/www/html/koinoyamai.love/logs/node-version-check.log 2>&1
# （security-watch の 04:30 の後、dep-update-pr の 05:30 の前）
set -uo pipefail

BASE="/var/www/html/koinoyamai.love"
STG_DIR="/home/yuzuki/koinoyamai.love-test"
NODE_BASE="$HOME/.nvm/versions/node"
NVM_DIR="$HOME/.nvm"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.22.1/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="node"

# nvm を読み込む
export NVM_DIR
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

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
         -H "User-Agent: mai-push-node-version (https://koinoyamai.love, 1.0)" \
         -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
         -d "{\"embeds\":[{\"title\":\"$title\",\"description\":\"$desc\",\"color\":$color,\"footer\":{\"text\":\"Host: $HOSTNAME | node-version-check\"},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}" > /dev/null 2>&1
}

log() { echo "[$(date '+%F %T')] $*"; }

# --- 現在の Node バージョン ---
CURRENT_VERSION=$("$NODE_BIN" --version 2>/dev/null | tr -d 'v')
CURRENT_MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1)
log "現在の Node: v$CURRENT_VERSION (major=$CURRENT_MAJOR)"

# --- nodejs.org から最新の security release を取得 ---
log "nodejs.org からリリース情報を取得..."
NODE_INDEX=$(curl -s --max-time 30 https://nodejs.org/dist/index.json 2>/dev/null)
if [ -z "$NODE_INDEX" ]; then
    log "ERROR: nodejs.org に接続できません"
    send_alert "ERROR" "Node Version Check: 接続失敗" "nodejs.org に接続できません。"
    exit 1
fi

# 最新の security release for current major を取得
LATEST_SECURITY=$(echo "$NODE_INDEX" | python3 -c "
import sys, json
data = json.load(sys.stdin)
major = $CURRENT_MAJOR
# セキュリティ修正を含む最新のリリースを探す
security_releases = [r for r in data if r.get('version','').startswith(f'v{major}.') and r.get('security', False)]
if security_releases:
    print(security_releases[0]['version'].lstrip('v'))
    print('SECURITY')
else:
    # セキュリティ修正がなくても、より新しいパッチ版があれば通知
    all_releases = [r for r in data if r.get('version','').startswith(f'v{major}.')]
    if all_releases:
        print(all_releases[0]['version'].lstrip('v'))
        print('REGULAR')
" 2>/dev/null)

if [ -z "$LATEST_SECURITY" ]; then
    log "Node $CURRENT_MAJOR 系のリリース情報が取得できません"
    exit 0
fi

LATEST_VERSION=$(echo "$LATEST_SECURITY" | head -1)
RELEASE_TYPE=$(echo "$LATEST_SECURITY" | tail -1)

log "最新版: v$LATEST_VERSION ($RELEASE_TYPE)"

# 現在のバージョンと比較
if [ "$LATEST_VERSION" = "$CURRENT_VERSION" ]; then
    log "最新版です。何もしません。"
    exit 0
fi

# バージョン比較: latest が current より新しいか
if ! python3 -c "import sys; sys.exit(0 if '$LATEST_VERSION' > '$CURRENT_VERSION' else 1)" 2>/dev/null; then
    log "最新版 ($LATEST_VERSION) は現在のバージョン ($CURRENT_VERSION) より古いか同等です。スキップ。"
    exit 0
fi

log "新しいバージョンが利用可能: v$CURRENT_VERSION → v$LATEST_VERSION ($RELEASE_TYPE)"

# --- nvm でダウンロード ---
LATEST_NODE_DIR="$NODE_BASE/v$LATEST_VERSION"
if [ -x "$LATEST_NODE_DIR/bin/node" ]; then
    log "v$LATEST_VERSION は既にダウンロード済みです。"
else
    log "nvm で v$LATEST_VERSION をダウンロード中..."
    nvm install "$LATEST_VERSION" 2>&1 | tail -5
    if [ ! -x "$LATEST_NODE_DIR/bin/node" ]; then
        log "ERROR: ダウンロードに失敗しました"
        send_alert "ERROR" "Node Version: ダウンロード失敗" "v$LATEST_VERSION のダウンロードに失敗しました。手動で \`nvm install v$LATEST_VERSION\` を実行してください。"
        exit 1
    fi
    log "ダウンロード完了: $LATEST_NODE_DIR"
fi

# --- migrate-node-patch.sh の dry-run ---
FROM_VERSION="v$CURRENT_VERSION"
TO_VERSION="v$LATEST_VERSION"

log "migrate-node-patch.sh --dry-run を実行..."
DRY_RUN_OUTPUT=$(bash "$STG_DIR/scripts/deploy/migrate-node-patch.sh" --from "$FROM_VERSION" --to "$TO_VERSION" 2>&1)
DRY_RUN_RC=$?

log "dry-run 結果 (rc=$DRY_RUN_RC):"
echo "$DRY_RUN_OUTPUT" | tail -20

# --- Discord 通知 ---
RELEASE_LABEL=""
if [ "$RELEASE_TYPE" = "SECURITY" ]; then
    RELEASE_LABEL="⚠️ セキュリティ修正を含む"
else
    RELEASE_LABEL="通常リリース"
fi

DESC="Node.js $RELEASE_LABEL の新しいバージョンが利用可能です。\\n\\n"
DESC="${DESC}現在: v$CURRENT_VERSION → 最新: v$LATEST_VERSION\\n"
DESC="${DESC}ダウンロード: 完了 (nvm)\\n"
DESC="${DESC}dry-run: rc=$DRY_RUN_RC\\n\\n"
DESC="${DESC}【手動対応が必要】\\n"
DESC="${DESC}1. ecosystem.config.js の interpreter を $LATEST_NODE_DIR/bin/node に更新\\n"
DESC="${DESC}2. scripts/ の NODE_BIN を更新\\n"
DESC="${DESC}3. systemd unit (pi-vector.service) の ExecStart を更新\\n"
DESC="${DESC}4. bash scripts/deploy/migrate-node-patch.sh --from $FROM_VERSION --to $TO_VERSION --apply\\n"
DESC="${DESC}5. pm2 save\\n\\n"
DESC="${DESC}詳細: AGENTS.md §5"

if [ "$RELEASE_TYPE" = "SECURITY" ]; then
    send_alert "WARN" "Node Version: 新セキュリティリリース v$LATEST_VERSION" "$DESC"
else
    send_alert "INFO" "Node Version: 新リリース v$LATEST_VERSION" "$DESC"
fi

log "=== 完了 ==="
exit 0
