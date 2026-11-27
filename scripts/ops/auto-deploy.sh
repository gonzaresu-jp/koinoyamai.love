#!/bin/bash
# 自動デプロイパイプライン: main の新コミットを検知し、CI 確認 → staging → smoke test → 本番に反映する
#
# cron: */5 * * * * /var/www/html/koinoyamai.love/scripts/ops/auto-deploy.sh >> /var/www/html/koinoyamai.love/logs/auto-deploy.log 2>&1
#
# 前提:
#   - staging ツリーは /home/yuzuki/koinoyamai.love-test（canonical。ローカルの staging ブランチを使う）
#   - 本番ツリーは /var/www/html/koinoyamai.love（main）
#   - pm2 で mai-push-api / mai-push-worker / mai-push-api-test が稼働中
#   - gh がログイン済み（CI の結果を参照する）
#
# 安全弁（AGENTS.md §7.3.6）:
#   - 多重起動しない（flock）。新コミットが無ければ何もしない
#   - そのコミットの CI が成功していなければ配置しない（実行中なら次の回へ、失敗なら止めて通知）
#   - staging / 本番の作業ツリーに未コミットの変更があれば止める（reset --hard で消さない）
#   - 本番ツリーに origin/main に無いコミット（push 失敗で溜まった cron のデータ等）があれば止める
#   - 本番は fast-forward でのみ進める
#   - staging で smoke test が失敗したら本番には触らない
#   - 本番で smoke test が失敗したらロールバック（前コミットに戻し API とワーカーを再起動）
#   - 失敗したコミットは記録し、新しいコミットが来るまで再試行しない（5 分ごとの再起動・通知の連発を防ぐ）
#   - 全ステップで Discord 通知（Bot トークンはコマンド引数に出さない）
set -uo pipefail

# 本番ツリーを更新すると、実行中のこのファイル自体も書き換わる。bash はスクリプトを少しずつ読むため、
# 途中で変わると新しいファイルの途中から実行が続いてしまう。一時コピーに移ってから実行する。
if [ "${AUTO_DEPLOY_SELF_COPY:-}" != "1" ]; then
    self_copy="$(mktemp /tmp/auto-deploy.XXXXXX)" && cp "$0" "$self_copy" \
        && AUTO_DEPLOY_SELF_COPY=1 exec bash "$self_copy" "$@"
    echo "[auto-deploy] 一時コピーを作れないため中止" >&2
    exit 1
fi
trap 'rm -f "$0"' EXIT

# AUTO_DEPLOY_* は判定テスト（scripts/ci/test-auto-deploy.sh）が使い捨てのツリーに差し替えるためのもの
PROD_DIR="${AUTO_DEPLOY_PROD_DIR:-/var/www/html/koinoyamai.love}"
STG_DIR="${AUTO_DEPLOY_STG_DIR:-/home/yuzuki/koinoyamai.love-test}"
STATE_FILE="${AUTO_DEPLOY_STATE_FILE:-/var/lib/mai-push/auto-deploy-state.json}"
LOCK_FILE="${AUTO_DEPLOY_LOCK_FILE:-/var/lib/mai-push/auto-deploy.lock}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v24.22.3/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="node"
SMOKE_TIMEOUT=15
WORKER_HEALTH="http://127.0.0.1:3002/api/health/live"

log() { echo "[$(date '+%F %T')] $*"; }

# --- 多重起動の防止（npm-deploy などで 5 分を超えると次の cron と重なる）---
mkdir -p "$(dirname "$LOCK_FILE")"
if ! { exec 9>"$LOCK_FILE"; } 2>/dev/null; then
    # 開けないまま flock すると「前回の実行中」と誤認して黙ってスキップし続ける
    log "ERROR: ロックファイルを開けない（$LOCK_FILE）。権限を確認してください"
    exit 1
fi
if ! flock -n 9; then
    log "前回の実行が続いているためスキップ"
    exit 0
fi

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
    # 本文の JSON は python で組み立てる（コミットメッセージの改行や " で JSON が壊れて通知が届かなくなるため）。
    # 呼び出し側の "\\n" は改行として扱う。
    # トークンを curl の引数に渡すと ps から見える（AGENTS.md §3）。組み込みの printf から設定（-K）として渡す
    AD_TITLE="$title" AD_DESC="$desc" AD_COLOR="$color" AD_HOST="$HOSTNAME" python3 -c '
import json, os, datetime
print(json.dumps({"embeds": [{
    "title": os.environ["AD_TITLE"],
    "description": os.environ["AD_DESC"].replace("\\n", "\n")[:4000],
    "color": int(os.environ["AD_COLOR"]),
    "footer": {"text": "Host: " + os.environ["AD_HOST"] + " | auto-deploy"},
    "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}]}, ensure_ascii=True))' | curl -s \
         -K <(printf 'header = "Authorization: Bot %s"\n' "$DISCORD_BOT_TOKEN") \
         -H "Content-Type: application/json" \
         -H "User-Agent: mai-push-auto-deploy (https://koinoyamai.love, 1.0)" \
         -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
         --data-binary @- > /dev/null 2>&1
}

# --- 状態ファイルの読み書き ---
#   lastDeployedCommit … 最後に本番へ出したコミット
#   failedCommit       … コミット自体が悪くて失敗したもの（CI 失敗・smoke 失敗・ロールバック）。
#                        同じコミットは再試行しない（新しいコミットが来たら再開）。手動で再試行するには
#                        状態ファイルの failedCommit を空にする（docs/agents/07-automation.md §7.3.6）
#   blockedCommit / status … 環境の都合で保留したもの（CI 結果を取れない・ツリーが dirty・未 push のコミット）。
#                        毎回再試行し、通知は「コミットと理由」が変わったときだけ出す
STATE_JSON=""
state_get() {
    printf '%s' "$STATE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null | tr -d '\r'
}
save_state() { # lastDeployed failedCommit status [blockedCommit]
    mkdir -p "$(dirname "$STATE_FILE")"
    printf '{"lastDeployedCommit":"%s","failedCommit":"%s","blockedCommit":"%s","status":"%s","lastAttempt":"%s"}\n' \
        "$1" "$2" "${4:-}" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"
}
if [ -f "$STATE_FILE" ]; then STATE_JSON="$(cat "$STATE_FILE")"; else STATE_JSON='{}'; fi

# コミットが悪くて失敗: 記録して止める（同じコミットでは二度と試さず、通知も 1 回だけ）
fail_commit() { # status title desc
    save_state "$LAST_DEPLOYED" "$REMOTE_HEAD" "$1"
    send_alert "ERROR" "$2" "$3"
    exit 1
}
# 環境の都合で保留: 次の回にまた試す。通知は同じコミット・同じ理由では 1 回だけ
block_commit() { # status title desc
    local prev_blocked prev_status
    prev_blocked="$(state_get blockedCommit)"; prev_status="$(state_get status)"
    save_state "$LAST_DEPLOYED" "$(state_get failedCommit)" "$1" "$REMOTE_HEAD"
    if [ "$prev_blocked" != "$REMOTE_HEAD" ] || [ "$prev_status" != "$1" ]; then
        send_alert "WARN" "$2" "$3\\n解消すれば次の回（5 分以内）に自動で再試行します。"
    fi
    exit 1
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

# ワーカー（main.js）の起動確認。起動直後は準備中なので最大 60 秒待つ
worker_ok() {
    local i code
    for i in $(seq 1 30); do
        code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$WORKER_HEALTH" 2>/dev/null || true)
        [ "$code" = "200" ] && return 0
        sleep 2
    done
    log "smoke FAIL (worker): $WORKER_HEALTH returned ${code:-none}"
    return 1
}

restart_prod() {
    pm2 restart mai-push-api --update-env >/dev/null 2>&1
    pm2 restart mai-push-worker --update-env >/dev/null 2>&1
    sleep 3
}

# --- CI の結果（そのコミットの GitHub Actions）---
# 出力: success / pending / failure / unknown（gh が使えない等）
ci_status() {
    local sha="$1" repo out
    repo="${AUTO_DEPLOY_REPO:-$(git -C "$PROD_DIR" remote get-url origin 2>/dev/null | sed -E 's#^.*github\.com[:/]##; s#/+$##; s#\.git$##')}"
    [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo unknown; return; }
    # check-run が 0 件（まだ登録されていない）は pending。どのワークフローの失敗も配置を止める（安全側）
    out="$(gh api "repos/$repo/commits/$sha/check-runs?per_page=100" \
        --jq '[.check_runs[] | {s: .status, c: (.conclusion // "")}]
              | if length == 0 then "pending"
                elif any(.s != "completed") then "pending"
                elif all(.c == "success" or .c == "skipped" or .c == "neutral") then "success"
                else "failure" end' 2>/dev/null)" || { echo unknown; return; }
    case "$out" in success|pending|failure) echo "$out" ;; *) echo unknown ;; esac
}

# 作業ツリーに未コミットの追跡変更があるか（未追跡ファイルは対象外）
tree_dirty() { [ -n "$(git -C "$1" status --porcelain --untracked-files=no 2>/dev/null)" ]; }

# --- main ---
cd "$PROD_DIR" || { log "ERROR: PROD_DIR not found"; exit 1; }

if ! git fetch origin main --quiet 2>&1; then
    log "WARNING: git fetch に失敗（次の回に再試行）"
    exit 0
fi
REMOTE_HEAD=$(git rev-parse --verify --quiet 'origin/main^{commit}' 2>/dev/null)
if ! [[ "$REMOTE_HEAD" =~ ^[0-9a-f]{40}$ ]]; then
    log "ERROR: origin/main を解決できない（${REMOTE_HEAD:-空}）"
    exit 1
fi
LAST_DEPLOYED="$(state_get lastDeployedCommit)"
FAILED_COMMIT="$(state_get failedCommit)"

# 新コミットが無い／既に失敗と判定したコミット → 何もしない
[ "$REMOTE_HEAD" = "$LAST_DEPLOYED" ] && exit 0
[ "$REMOTE_HEAD" = "$FAILED_COMMIT" ] && exit 0

NEW_COMMITS=$(git log --oneline "${LAST_DEPLOYED:+$LAST_DEPLOYED..}$REMOTE_HEAD" 2>/dev/null | head -5)

# --- Step 0: CI ゲート ---
CI="$(ci_status "$REMOTE_HEAD")"
case "$CI" in
    pending)
        log "CI 実行中のため次の回に回す: $REMOTE_HEAD"
        exit 0 ;;
    failure)
        log "CI 失敗のため配置しない: $REMOTE_HEAD"
        fail_commit "ci-failed" "Auto-Deploy: CI 失敗のため配置しません" "コミット: $REMOTE_HEAD\\n新コミット:\\n$NEW_COMMITS" ;;
    unknown)
        log "CI の結果を取得できないため配置しない（gh の認証・ネットワークを確認）: $REMOTE_HEAD"
        block_commit "ci-unknown" "Auto-Deploy: CI の結果を確認できません" "コミット: $REMOTE_HEAD\\ngh の認証・ネットワークを確認してください。確認できるまで配置しません。" ;;
esac

log "=== 新コミット検出（CI 成功）: $REMOTE_HEAD (前回: ${LAST_DEPLOYED:-none}) ==="
log "新コミット:"
echo "$NEW_COMMITS" | sed 's/^/  /'

# --- Step 1: staging にデプロイ ---
log "Step 1: staging にデプロイ"
cd "$STG_DIR" || block_commit "staging-missing" "Auto-Deploy: staging ツリーなし" "STG_DIR=$STG_DIR が見つかりません"
if tree_dirty "$STG_DIR"; then
    log "staging ツリーに未コミットの変更があるため止める"
    block_commit "staging-dirty" "Auto-Deploy: staging ツリーに未コミットの変更" "$STG_DIR に未コミットの変更があるため配置しません（消さないため）。コミット: $REMOTE_HEAD"
fi
git fetch origin main --quiet 2>&1
STG_PREV="$(git rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git rev-parse --short HEAD 2>/dev/null)"
# deploy-staging.sh と同じく、ローカルの staging ブランチに配置する（§14.1。今いるブランチを上書きしない）。
# umask 002: 書き換わる webui/*.php が php-fpm から読めなくなる事故を防ぐ（§7.1）
( umask 002; git checkout -q -B staging origin/main ) 2>&1 | tail -1
if [ "$(git rev-parse HEAD 2>/dev/null)" != "$REMOTE_HEAD" ] || [ "$(git branch --show-current)" != "staging" ]; then
    block_commit "staging-checkout-failed" "Auto-Deploy: staging の切り替えに失敗" "staging ブランチを $REMOTE_HEAD にできませんでした（$STG_DIR）"
fi
log "staging: $STG_PREV → staging @ $(git rev-parse --short HEAD)"
if ! "$NODE_BIN" scripts/deploy/check-node-modules-drift.js >/dev/null 2>&1; then
    log "WARNING: staging の node_modules に乖離あり"
fi
pm2 restart mai-push-api-test --update-env >/dev/null 2>&1
sleep 3

# --- Step 2: staging で smoke test ---
log "Step 2: staging smoke test"
if smoke_test "http://127.0.0.1:8081" "staging"; then
    log "staging smoke test: PASS"
else
    log "staging smoke test: FAIL → 本番には触らない"
    fail_commit "staging-failed" "Auto-Deploy: staging smoke test 失敗" "コミット: $REMOTE_HEAD\\n新コミット:\\n$NEW_COMMITS\\n\\nstaging の smoke test が失敗したため、本番には反映していません。新しいコミットが来るまで再試行しません。"
fi

# --- Step 3: 本番にデプロイ（fast-forward のみ）---
log "Step 3: 本番にデプロイ"
cd "$PROD_DIR" || { log "ERROR: PROD_DIR not found"; exit 1; }
if tree_dirty "$PROD_DIR"; then
    log "本番ツリーに未コミットの変更があるため止める"
    block_commit "prod-dirty" "Auto-Deploy: 本番ツリーに未コミットの変更" "$PROD_DIR に未コミットの変更があるため配置しません（消さないため）。コミット: $REMOTE_HEAD"
fi
LOCAL_ONLY="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo unknown)"
if [ "$LOCAL_ONLY" != "0" ]; then
    log "本番ツリーに origin/main に無いコミットが ${LOCAL_ONLY} 件あるため止める"
    block_commit "prod-diverged" "Auto-Deploy: 本番ツリーに未 push のコミット" "$PROD_DIR に origin/main に無いコミットが ${LOCAL_ONLY} 件あります（cron の push 失敗など）。消さないため配置しません。push されれば再試行されます。"
fi
PREV_COMMIT=$(git rev-parse HEAD)
if ! ( umask 002; git merge -q --ff-only origin/main ) 2>&1 | tail -1; then
    block_commit "prod-ff-failed" "Auto-Deploy: 本番を fast-forward できません" "コミット: $REMOTE_HEAD"
fi
if [ "$(git rev-parse HEAD)" != "$REMOTE_HEAD" ]; then
    block_commit "prod-ff-failed" "Auto-Deploy: 本番を fast-forward できません" "HEAD が $REMOTE_HEAD になりませんでした"
fi

if ! "$NODE_BIN" scripts/deploy/check-node-modules-drift.js >/dev/null 2>&1; then
    log "WARNING: 本番の node_modules に乖離あり → npm-deploy.sh --apply を実行"
    bash scripts/deploy/npm-deploy.sh --apply 2>&1 | tail -5
fi

# 本番 API とワーカーを再起動（ワーカー側のコード変更もここで反映する）
restart_prod

# --- Step 4: 本番で smoke test（API + ワーカー）---
log "Step 4: 本番 smoke test"
if smoke_test "http://127.0.0.1:8080" "production" && worker_ok; then
    log "本番 smoke test: PASS"
    save_state "$REMOTE_HEAD" "" "success"
    send_alert "INFO" "Auto-Deploy: 成功" "コミット: $REMOTE_HEAD\\n新コミット:\\n$NEW_COMMITS\\n\\nCI・staging・本番（API + ワーカー）の確認がすべて PASS しました。"
else
    log "本番 smoke test: FAIL → ロールバック"
    # smoke の最中に、同じツリーで cron（webui/data の日次コミット等）がコミット・編集していたら、
    # reset --hard で消してしまう。HEAD が配置したコミットのままで、未コミットの変更も無いときだけ戻す。
    if [ "$(git rev-parse HEAD)" != "$REMOTE_HEAD" ] || tree_dirty "$PROD_DIR"; then
        log "本番ツリーが配置後に変わっているため、自動ロールバックしない（手動対応）"
        fail_commit "rollback-skipped" "Auto-Deploy: 本番 smoke test 失敗（自動ロールバックできず）" "コミット: $REMOTE_HEAD\\n本番の smoke test が失敗しましたが、配置後に本番ツリーが変わっていた（同時に動いた cron 等）ため、作業を消さないよう自動では戻していません。手動で確認してください（戻し先: $PREV_COMMIT）。"
    fi
    ( umask 002; git reset -q --hard "$PREV_COMMIT" ) 2>&1 | tail -1
    restart_prod
    # 戻した後も確かめる（node_modules の入れ替え等で、戻しても直らない場合がある）
    if smoke_test "http://127.0.0.1:8080" "production(rolled-back)" && worker_ok; then
        fail_commit "rolled-back" "Auto-Deploy: 本番 smoke test 失敗 → ロールバック" "コミット: $REMOTE_HEAD\\n前回のコミット ($PREV_COMMIT) に戻し、API とワーカーを再起動しました（戻した後の確認は PASS）。新しいコミットが来るまで再試行しません。"
    else
        fail_commit "rolled-back-unhealthy" "Auto-Deploy: ロールバック後も本番が異常" "コミット: $REMOTE_HEAD\\n前回のコミット ($PREV_COMMIT) に戻しましたが、本番の確認がまだ失敗しています。至急手動で確認してください（npm-deploy による node_modules の入れ替え等）。"
    fi
fi

log "=== デプロイ完了 ==="
exit 0
