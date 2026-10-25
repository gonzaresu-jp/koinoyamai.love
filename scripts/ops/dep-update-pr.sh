#!/bin/bash
# 依存更新の自動 PR 作成
# security-watch が検出した脆弱性を npm audit fix で修正し、PR を作成する。
#
# cron: 30 5 * * * /var/www/html/koinoyamai.love/scripts/ops/dep-update-pr.sh >> /var/www/html/koinoyamai.love/logs/dep-update-pr.log 2>&1
# （security-watch の 04:30 の後、auto-deploy の前）
#
# 安全弁:
#   - npm audit fix --force は使わない（非破壊の修正のみ）
#   - npm test が失敗したら PR を作成しない
#   - 既にオープンな dep-update PR がある場合はスキップ
#   - 変更が無ければ何もしない
set -uo pipefail

PROD_DIR="/var/www/html/koinoyamai.love"
STG_DIR="/home/yuzuki/koinoyamai.love-test"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.22.1/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="node"
NPM_BIN="${NPM_BIN:-$HOME/.nvm/versions/node/v24.22.1/bin/npm}"
[ -x "$NPM_BIN" ] || NPM_BIN="npm"

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
         -H "User-Agent: mai-push-dep-update (https://koinoyamai.love, 1.0)" \
         -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
         -d "{\"embeds\":[{\"title\":\"$title\",\"description\":\"$desc\",\"color\":$color,\"footer\":{\"text\":\"Host: $HOSTNAME | dep-update-pr\"},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}" > /dev/null 2>&1
}

log() { echo "[$(date '+%F %T')] $*"; }

# --- 既にオープンな dep-update PR があるか確認 ---
OPEN_PR=$(cd "$PROD_DIR" && gh pr list --state open --search "dep-update" --json number --jq '.[0].number' 2>/dev/null)
if [ -n "$OPEN_PR" ] && [ "$OPEN_PR" != "null" ]; then
    log "オープンな dep-update PR (#$OPEN_PR) が既に存在します。スキップ。"
    exit 0
fi

# --- npm audit を実行 ---
cd "$STG_DIR" || { log "ERROR: STG_DIR not found"; exit 1; }
AUDIT_JSON=$("$NPM_BIN" audit --json 2>/dev/null)
if [ -z "$AUDIT_JSON" ]; then
    log "npm audit の出力が空です。スキップ。"
    exit 0
fi

# high/critical の件数を取得
HIGH_COUNT=$(echo "$AUDIT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metadata',{}).get('vulnerabilities',{}).get('high',0))" 2>/dev/null || echo "0")
CRIT_COUNT=$(echo "$AUDIT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metadata',{}).get('vulnerabilities',{}).get('critical',0))" 2>/dev/null || echo "0")

log "npm audit: high=$HIGH_COUNT critical=$CRIT_COUNT"

if [ "$HIGH_COUNT" -eq 0 ] && [ "$CRIT_COUNT" -eq 0 ]; then
    log "high/critical の脆弱性はありません。スキップ。"
    exit 0
fi

# --- npm audit fix (non-force) を実行 ---
log "npm audit fix を実行..."
BEFORE_HASH=$(md5sum package.json package-lock.json 2>/dev/null | md5sum)
"$NPM_BIN" audit fix 2>&1 | tail -5
AFTER_HASH=$(md5sum package.json package-lock.json 2>/dev/null | md5sum)

if [ "$BEFORE_HASH" = "$AFTER_HASH" ]; then
    log "npm audit fix で変更がありません（手動対応が必要な脆弱性の可能性）。"
    send_alert "WARN" "Dep-Update: 自動修正不可" "high=$HIGH_COUNT critical=$CRIT_COUNT の脆弱性がありますが、npm audit fix では修正できませんでした。手動対応が必要です。"
    exit 0
fi

log "package.json/lock が更新されました。"

# --- npm test ---
log "npm test を実行..."
if ! "$NPM_BIN" test >/dev/null 2>&1; then
    log "npm test が失敗しました。変更を元に戻します。"
    git checkout -- package.json package-lock.json
    git clean -fd node_modules 2>/dev/null || true
    send_alert "ERROR" "Dep-Update: テスト失敗" "npm audit fix 後に npm test が失敗しました。PR は作成しません。"
    exit 1
fi
log "npm test: PASS"

# --- ブランチ作成 → commit → push → PR ---
BRANCH="dep-update-$(date +%Y%m%d)"
cd "$STG_DIR" || exit 1
git checkout -b "$BRANCH" 2>&1 | tail -1
git add package.json package-lock.json
git -c user.name="opencode" -c user.email="opencode@local" commit -q -m "fix(deps): npm audit fix で脆弱性を修正

high=$HIGH_COUNT critical=$CRIT_COUNT の脆弱性を npm audit fix で修正。
npm test は pass 済み。" 2>&1 | tail -1
git push -u origin "$BRANCH" 2>&1 | tail -2

# PR 作成
PR_URL=$(cd "$PROD_DIR" && gh pr create --base main --head "$BRANCH" --title "fix(deps): npm audit fix で脆弱性を修正 (high=$HIGH_COUNT/critical=$CRIT_COUNT)" --body "## 変更概要

security-watch が検出した脆弱性を \`npm audit fix\`（--force なし）で修正しました。

- high: $HIGH_COUNT 件
- critical: $CRIT_COUNT 件
- npm test: pass

## 注意
- \`npm audit fix --force\` は使用していません
- メジャー更新が提案された場合は手動レビューが必要です
" 2>&1 | tail -1)

log "PR 作成: $PR_URL"
send_alert "WARN" "Dep-Update: PR 作成" "脆弱性修正の PR を作成しました。\\nhigh=$HIGH_COUNT critical=$CRIT_COUNT\\n$PR_URL\\nレビューしてください。"

# staging ツリーを元に戻す
cd "$STG_DIR"
git checkout staging 2>/dev/null || git checkout main 2>/dev/null
log "=== 完了 ==="
exit 0
