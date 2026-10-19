#!/usr/bin/env bash
# deploy-staging.sh - 指定ブランチを staging 環境（/home/yuzuki/koinoyamai.love-test）へデプロイする
#
# 使い方:
#   bash scripts/deploy/deploy-staging.sh <branch> [--worker] [--sync-db] [--dry-run]
#     <branch>     デプロイするリモートブランチ名（例: main, feature/xxx）
#     --worker     テスト用 worker (mai-push-worker-test) も起動する（スクレイパーが動く）
#     --sync-db    先に本番 data.db を data-test.db へスナップショットする
#     --dry-run    実行せずに手順だけ表示
#
# 前提: staging worktree は /home/yuzuki/koinoyamai.love-test。
#       node_modules は 2026-09-22 から staging 独自の実体（sqlite3@6 で npm install）。
#       .env は staging 実体（600）、本番と別値。※以前は node_modules/.env が本番への symlink だった

set -euo pipefail

BRANCH_ORIG=""
BOOT_WORKER=0
SYNC_DB=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --worker)  BOOT_WORKER=1 ;;
    --sync-db) SYNC_DB=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 1 ;;
    *) BRANCH_ORIG="$arg" ;;
  esac
done

BRANCH="${BRANCH_ORIG:-main}"
STAGING="/home/yuzuki/koinoyamai.love-test"
PROD="$(cd "$(dirname "$0")/../.." && pwd)"

# worktree の .git は「ディレクトリではなくファイル」なので -e で判定する
if [ ! -e "$STAGING/.git" ] || ! git -C "$STAGING" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: staging worktree が見つかりません ($STAGING)" >&2
  exit 1
fi

cd "$STAGING"

# 1. リモート取得
if [ "$DRY" -eq 1 ]; then
  echo "[dry] git fetch origin --prune"
else
  echo "==> fetching origin"
  git fetch origin --prune
fi

# 2. 対象ブランチへ切り替え＋リモートと同一に固定（未コミットの追跡変更は無い前提）
#    デプロイ先は常にローカルデプロイ用ブランチ名「staging」を使う。
#    main を直接チェックアウトすると本番 worktree(=\$PROD)と競合するため。
if [ "$DRY" -eq 1 ]; then
  echo "[dry] git checkout -B staging origin/$BRANCH"
  echo "[dry] git reset --hard origin/$BRANCH"
else
  echo "==> checkout staging (reset to origin/$BRANCH)"
  git checkout -B staging "origin/$BRANCH"
  git reset --hard "origin/$BRANCH"
fi

# 3. DB スナップショット（任意）
if [ "$SYNC_DB" -eq 1 ]; then
  if [ "$DRY" -eq 1 ]; then
    echo "[dry] bash $PROD/scripts/deploy/sync-test-db.sh"
  else
    echo "==> syncing production DB snapshot"
    bash "$PROD/scripts/deploy/sync-test-db.sh"
  fi
fi

# 4. staging API 再起動（--update-env で env 差分を反映）
if [ "$DRY" -eq 1 ]; then
  echo "[dry] pm2 start $STAGING/ecosystem.config.js --only mai-push-api-test --update-env"
else
  echo "==> restarting mai-push-api-test"
  pm2 start "$STAGING/ecosystem.config.js" --only mai-push-api-test --update-env
fi

# 5. テスト用 worker（任意）
if [ "$BOOT_WORKER" -eq 1 ]; then
  if [ "$DRY" -eq 1 ]; then
    echo "[dry] pm2 start $STAGING/ecosystem.config.js --only mai-push-worker-test --update-env"
  else
    echo "==> starting mai-push-worker-test"
    pm2 start "$STAGING/ecosystem.config.js" --only mai-push-worker-test --update-env
  fi
fi

if [ "$DRY" -eq 1 ]; then
  echo "[dry-run] 以上で終了"
  exit 0
fi

# 6. smoke test（staging API :8081）
BASE="http://localhost:8081"
fail=0

wait_ok() {
  local i code
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$BASE/api/health" 2>/dev/null || true)
    if [ "$code" = "200" ]; then return 0; fi
    sleep 1
  done
  return 1
}
check() {
  local desc="$1" path="$2" expect="${3:-200}" code
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 25 "$BASE$path" 2>/dev/null || true)
  if [ "$code" = "$expect" ]; then
    echo "PASS  $desc ($code)"
  else
    echo "FAIL  $desc (expect $expect, got $code)"
    fail=1
  fi
}

echo "==> smoke test on $BASE"
if ! wait_ok; then
  echo "FAIL  staging API 起動待ちタイムアウト（pm2 logs mai-push-api-test を確認）"
  exit 1
fi
check "health"          "/api/health"
check "archive stats"   "/api/archive/stats"
check "archive videos"  "/api/archive/videos?limit=3"
check "archive search"  "/api/archive/search?q=live"

if [ "$fail" -ne 0 ]; then
  echo "smoke FAILED: $fail 件" >&2
  exit 1
fi
echo "smoke OK"
echo "完了: https://test.koinoyamai.love で手動確認してください"