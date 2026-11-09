#!/bin/bash
# 別ホスト複製バックアップ: 日次バックアップ（/var/lib/mai-push/backups）を
# 別マシン（nassy）の別ディスクへ転送し、sha256 の一致を検証する。
#
# なぜ必要か:
#   backup.sh（毎日 03:00）の保存先は本番マシン内にあり、ディスク故障・
#   ランサムウェア・誤削除で「本体」と「バックアップ」が同時に失われる。
#   verify-backup.sh は整合性を見るだけで、同じディスクに依存している。
#   ここでは別ホストへ複製して、単一障害点を減らす。
#
# 使い方:
#   bash scripts/ops/backup-offsite.sh            # dry-run（転送内容を表示するだけ）
#   bash scripts/ops/backup-offsite.sh --apply    # 転送 + sha256 検証 + リモートの世代整理
#
# 本番反映後の cron（AGENTS.md §7.8。登録したら §7.6 の表にも追記する）:
#   10 3 * * * /var/www/html/koinoyamai.love/scripts/ops/backup-offsite.sh --apply \
#     >> /var/www/html/koinoyamai.love/logs/backup-offsite.log 2>&1
#
# env（通常は設定不要）:
#   OFFSITE_HOST       転送先 ssh ホスト            既定: nassy
#   OFFSITE_DIR        転送先ディレクトリ           既定: /mnt/4TB/mai-push-backups
#   OFFSITE_KEEP_DAYS  リモートの保持日数           既定: 90（ローカルは 30 日）
#   OFFSITE_SSH_OPTS   ssh オプション               既定: -o BatchMode=yes -o ConnectTimeout=10
#
# 注意:
#   - 転送先には .env のバックアップ（秘密情報）も含まれる。ディレクトリは 700、
#     ファイルは 600 に固定する。権限を緩めないこと。
#   - 国内の別マシンへの複製であり、災害対策としては同一拠点依存が残る
#     （将来的にクラウドストレージへ二次複製する余地を残す）。
set -uo pipefail

BASE="/var/www/html/koinoyamai.love"
BACKUP_DIR="/var/lib/mai-push/backups"
HOST="${OFFSITE_HOST:-nassy}"
REMOTE_DIR="${OFFSITE_DIR:-/mnt/4TB/mai-push-backups}"
KEEP_DAYS="${OFFSITE_KEEP_DAYS:-90}"
SSH_OPTS="${OFFSITE_SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=10}"
APPLY=0

if [ "${1:-}" = "--apply" ]; then
    APPLY=1
elif [ -n "${1:-}" ]; then
    echo "使い方: $0 [--apply]" >&2
    exit 2
fi

log() { echo "[$(date '+%F %T')] $*"; }

# --- 入力の検証（ssh / find に渡す前に、引用符・空白・オプション偽装を弾く） ---
if ! printf '%s' "$HOST" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._@-]*$'; then
    log "ERROR: OFFSITE_HOST が不正です: $HOST" >&2
    exit 2
fi
if ! printf '%s' "$REMOTE_DIR" | grep -qE '^/[A-Za-z0-9._/-]*$' || printf '%s' "$REMOTE_DIR" | grep -q '\.\.'; then
    log "ERROR: OFFSITE_DIR が不正です（絶対パス・英数字と . _ / - のみ）: $REMOTE_DIR" >&2
    exit 2
fi
if ! printf '%s' "$KEEP_DAYS" | grep -qE '^[0-9]+$'; then
    log "ERROR: OFFSITE_KEEP_DAYS が不正です: $KEEP_DAYS" >&2
    exit 2
fi

# --- 多重起動防止 ---
LOCK=/tmp/mai-push-backup-offsite.lock
exec 9>"$LOCK"
flock -n 9 || { log "skip: another backup-offsite is running"; exit 0; }

# --- Discord 通知（失敗時のみ。既存の ops スクリプトと同じ方式） ---
env_val() {
    grep -m1 "^$1=" "$BASE/.env" 2>/dev/null | cut -d= -f2- | tr -d "\"'" | tr -d ' \r\n'
}
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-$(env_val DISCORD_BOT_TOKEN)}"
DISCORD_CHANNEL_ID="${DISCORD_CHANNEL_ID:-$(env_val DISCORD_CHANNEL_ID)}"
HOSTNAME=$(hostname)

send_alert() {
    local level="$1" title="$2" desc="$3"
    [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_CHANNEL_ID" ] && return 0
    local color=16711680
    [ "$level" = "WARN" ] && color=16776960
    curl -s -H "Content-Type: application/json" \
         -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
         -H "User-Agent: mai-push-backup-offsite (https://koinoyamai.love, 1.0)" \
         -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
         -d "{\"embeds\":[{\"title\":\"$title\",\"description\":\"$desc\",\"color\":$color,\"footer\":{\"text\":\"Host: $HOSTNAME | backup-offsite\"},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}" > /dev/null 2>&1
}

fail() {
    log "ERROR: $1" >&2
    send_alert "ERROR" "Backup Offsite: 失敗" "$1"
    exit 1
}

# --- ローカルのバックアップを集める（対象は data-*.db と env-*.env のみ） ---
[ -d "$BACKUP_DIR" ] || fail "バックアップディレクトリがありません: $BACKUP_DIR"

shopt -s nullglob
DATA_FILES=("$BACKUP_DIR"/data-*.db)
ENV_FILES=("$BACKUP_DIR"/env-*.env)
shopt -u nullglob

if [ "${#DATA_FILES[@]}" -eq 0 ]; then
    fail "data-*.db が 1 つもありません（backup.sh が動いていない可能性）: $BACKUP_DIR"
fi

# 検証対象の DB / env。
# .env のバックアップは `cp -p` で作られるため mtime が更新されず、ls -t では
# 「最新の日付」を選べない。当日分があればそれを使い、無ければ名前順の最新にする。
TODAY=$(date +%Y%m%d)
if [ -f "$BACKUP_DIR/data-$TODAY.db" ]; then
    LATEST_DB="$BACKUP_DIR/data-$TODAY.db"
else
    LATEST_DB=$(ls -t "${DATA_FILES[@]}" | head -1)
fi
LATEST_ENV=""
if [ "${#ENV_FILES[@]}" -gt 0 ]; then
    if [ -f "$BACKUP_DIR/env-$TODAY.env" ]; then
        LATEST_ENV="$BACKUP_DIR/env-$TODAY.env"
    else
        LATEST_ENV=$(printf '%s\n' "${ENV_FILES[@]}" | sort | tail -1)
    fi
fi

# --- 接続確認 ---
if ! ssh $SSH_OPTS "$HOST" "true" 2>/dev/null; then
    fail "ssh で転送先に接続できません: $HOST（鍵・ネットワークを確認）"
fi

# --- dry-run ---
if [ "$APPLY" -ne 1 ]; then
    log "dry-run: $HOST:$REMOTE_DIR へ転送される内容（--apply で実行）"
    rsync -a -n --itemize-changes --timeout=120 -e "ssh $SSH_OPTS" \
        "${DATA_FILES[@]}" "${ENV_FILES[@]}" "$HOST:$REMOTE_DIR/" \
        || fail "rsync（dry-run）が失敗しました"
    log "dry-run 完了: data=${#DATA_FILES[@]} 件 / env=${#ENV_FILES[@]} 件"
    exit 0
fi

# --- 転送先の準備（700 固定） ---
ssh $SSH_OPTS "$HOST" "mkdir -p -- '$REMOTE_DIR' && chmod 700 -- '$REMOTE_DIR'" \
    || fail "転送先ディレクトリを準備できません: $HOST:$REMOTE_DIR"

# --- 転送（--delete は使わない: ローカルの保持期限切れでリモートまで消さない） ---
# --partial は使わない。中断時に「途中まで書けたファイル」が最終名で残り、
# 一見そろって見えるため（rsync 既定の temp→rename に任せる）。
rsync -a --chmod=F600 --timeout=120 -e "ssh $SSH_OPTS" \
    "${DATA_FILES[@]}" "${ENV_FILES[@]}" "$HOST:$REMOTE_DIR/"
RC=$?
# 24 = 転送中にファイルが消えた（backup.sh のローテーションと競合しただけ）。致命的ではない。
if [ "$RC" -ne 0 ] && [ "$RC" -ne 24 ]; then
    fail "rsync が失敗しました（rc=$RC）"
fi

# --- 検証: 最新 DB / env の sha256 が一致すること ---
verify_remote() {
    local f="$1" name local_sum remote_sum
    name=$(basename "$f")
    local_sum=$(sha256sum -- "$f" | awk '{print $1}')
    remote_sum=$(ssh $SSH_OPTS "$HOST" "sha256sum -- '$REMOTE_DIR/$name'" 2>/dev/null | awk '{print $1}')
    if [ -z "$remote_sum" ] || [ "$remote_sum" != "$local_sum" ]; then
        fail "sha256 不一致: $name（local=${local_sum:-none} remote=${remote_sum:-none}）"
    fi
    log "verify OK: $name ($local_sum)"
}

verify_remote "$LATEST_DB"
[ -n "$LATEST_ENV" ] && verify_remote "$LATEST_ENV"

# --- リモートの世代整理（ローカルより長く保持する） ---
# mtime ではなく **ファイル名の日付** で判定する。env-*.env は `cp -p` 由来で
# mtime が .env の更新日時に固定され、mtime 基準では「新しい複製」まで消えてしまう。
CUTOFF=$(date -d "-${KEEP_DAYS} days" +%Y%m%d)
OLD_LIST=$(ssh $SSH_OPTS "$HOST" \
    "cd '$REMOTE_DIR' 2>/dev/null || exit 0; cutoff='$CUTOFF'; for f in data-*.db env-*.env; do [ -e \"\$f\" ] || continue; d=\${f#*-}; d=\${d%.*}; case \"\$d\" in ''|*[!0-9]*) continue;; esac; if [ \"\$d\" -lt \"\$cutoff\" ]; then echo \"\$f\"; fi; done" 2>/dev/null)
if [ -n "$OLD_LIST" ]; then
    NAMES=$(printf '%s\n' "$OLD_LIST" | tr '\n' ' ')
    if ssh $SSH_OPTS "$HOST" "cd '$REMOTE_DIR' && rm -f -- $NAMES" 2>/dev/null; then
        log "リモートの古いバックアップを削除（${KEEP_DAYS}日超）:"
        printf '%s\n' "$OLD_LIST" | sed 's/^/  /'
    else
        log "WARN: リモートの古いバックアップを削除できませんでした（転送自体は成功）: $NAMES"
    fi
fi

REMOTE_COUNT=$(ssh $SSH_OPTS "$HOST" \
    "find '$REMOTE_DIR' -maxdepth 1 -type f -name 'data-*.db' | wc -l" 2>/dev/null | tr -d ' ')
log "完了: local_data=${#DATA_FILES[@]} local_env=${#ENV_FILES[@]} remote_data=${REMOTE_COUNT:-?} latest=$(basename "$LATEST_DB")"
