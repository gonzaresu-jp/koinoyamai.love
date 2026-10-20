#!/usr/bin/env bash
# promote.sh - staging で検証済みのブランチを本番(main)へ昇格する
#
# 使い方:
#   bash scripts/deploy/promote.sh <branch> [--sync-staging] [--no-restart] [--dry-run]
#     <branch>        昇格するブランチ名（staging で検証済み・origin に push 済みが前提）
#     --sync-staging  昇格後、staging を新しい main に追従させる（deploy-staging.sh main）
#     --no-restart    本番プロセスの再起動をスキップ（設定だけの変更など）
#     --dry-run       実行せずに手順だけ表示
#
# 方針:
#   - main が対象ブランチに fast-forward 可能な場合のみ昇格する
#     （staging で検証したコミットと同一ツリーを本番で動かすため）
#   - ff できない＝本番 main が進んだ後なので中止し、rebase して staging で再検証を促す
#   - 本番リポジトリに未コミットの追跡変更がある場合は中止する

set -euo pipefail

BRANCH_ORIG=""
SYNC_STAGING=0
RESTART=1
DRY=0
for arg in "$@"; do
  case "$arg" in
    --sync-staging) SYNC_STAGING=1 ;;
    --no-restart)   RESTART=0 ;;
    --dry-run)      DRY=1 ;;
    -h|--help)      sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 1 ;;
    *) BRANCH_ORIG="$arg" ;;
  esac
done

if [ -z "$BRANCH_ORIG" ]; then
  echo "usage: $0 <branch> [--sync-staging] [--no-restart] [--dry-run]" >&2
  exit 1
fi
BRANCH="$BRANCH_ORIG"

PROD="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROD"

# 1. リモート取得
if [ "$DRY" -eq 1 ]; then
  echo "[dry] git fetch origin --prune"
else
  echo "==> fetching origin"
  git fetch origin --prune
fi

# 2. 対象ブランチの存在確認
if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  echo "error: origin/$BRANCH が見つかりません（先に push してください）" >&2
  exit 1
fi

# 3. 本番リポジトリの作業ツリーがきれいであること（未コミットの追跡変更があると昇格不可）
if [ "$DRY" -ne 1 ] && [ -n "$(git status --porcelain)" ]; then
  echo "error: 本番リポジトリに未コミット変更があります。stash/コミットしてからやり直してください" >&2
  git status --short >&2
  exit 1
fi

# 4. fast-forward 可能チェック（origin/main が対象ブランチの祖先か）
if ! git merge-base --is-ancestor origin/main "origin/$BRANCH" 2>/dev/null; then
  echo "error: origin/main が origin/$BRANCH の祖先ではありません（ff 不可）" >&2
  echo "  → $BRANCH を最新の origin/main に rebase し、もう一度 staging で検証してください" >&2
  exit 1
fi

echo "==> promote $BRANCH -> main (ff allowed)"
echo "    対象コミット:"
git log --oneline origin/main.."origin/$BRANCH"

# 5. main へ ff マージして push
if [ "$DRY" -eq 1 ]; then
  echo "[dry] git checkout main"
  echo "[dry] git merge --ff-only origin/$BRANCH"
  echo "[dry] git push origin main"
  echo "[dry] find webui -type f ! -perm -o+r  # 権限検査（検出時は chmod o+r で補修）"
else
  # umask 077 のままだと書き換わる webui/*.php が mode 600 になり、
  # php-fpm (www-data) から読めず 500 になる（2026-10-20 の実事故: /logs/ が 500）。
  # git 操作だけ subshell で umask 002 に固定する。
  (
    umask 002
    git checkout main
    git merge --ff-only "origin/$BRANCH"
  )
  git push origin main
  echo "==> pushed main @ $(git rev-parse --short main)"

  # 5.5 配信ツリーの権限検査（2026-10-20 の実事故対策）
  #     umask 002 は「これから書き換わるファイル」にしか効かない。既に 600 のファイルや
  #     手動 git pull / エディタ保存で壊れたものは残るため、ここで機械的に検査して補修する。
  echo "==> checking webui permissions (php-fpm が読めるか)"
  BAD_FILES=$(find webui -type f ! -name '.*' ! -perm -o+r 2>/dev/null || true)
  BAD_DIRS=$(find webui -type d ! -name '.*' ! -perm -o+x 2>/dev/null || true)
  if [ -n "$BAD_FILES" ] || [ -n "$BAD_DIRS" ]; then
    echo "  ! other 読み取り/実行が無いファイルを検出（chmod で補修）:"
    if [ -n "$BAD_FILES" ]; then
      echo "$BAD_FILES" | sed 's/^/    /'
      echo "$BAD_FILES" | xargs -r chmod o+r
    fi
    if [ -n "$BAD_DIRS" ]; then
      echo "$BAD_DIRS" | sed 's/^/    /'
      echo "$BAD_DIRS" | xargs -r chmod o+x
    fi
    echo "  ! 原因（umask 077 の git 操作）を確認すること: AGENTS.md §7.1"
  else
    echo "  ✓ webui はすべて other 読み取り可"
  fi
fi

# 6. 本番プロセス再起動
if [ "$RESTART" -eq 1 ]; then
  if [ "$DRY" -eq 1 ]; then
    echo "[dry] bash $PROD/scripts/deploy/restart.sh all"
  else
    echo "==> restarting production processes"
    bash "$PROD/scripts/deploy/restart.sh" all
  fi
else
  echo "restart skipped (--no-restart)"
fi

if [ "$DRY" -eq 1 ]; then
  echo "[dry-run] 以上で終了"
  exit 0
fi

# 7. 本番 smoke test（:8080）
BASE="http://localhost:8080"
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
  echo "FAIL  本番 API 起動待ちタイムアウト（pm2 logs mai-push-api を確認）"
  exit 1
fi
check "health"          "/api/health"
check "archive stats"   "/api/archive/stats"
check "archive videos"  "/api/archive/videos?limit=3"
check "archive search"  "/api/archive/search?q=live"

# 8. staging を昇格後の main に追従（任意）
if [ "$SYNC_STAGING" -eq 1 ]; then
  echo "==> syncing staging to new main"
  bash "$PROD/scripts/deploy/deploy-staging.sh" main
fi

if [ "$fail" -ne 0 ]; then
  echo "smoke FAILED: $fail 件" >&2
  exit 1
fi
echo "smoke OK"
echo "昇格完了: $BRANCH -> main @ $(git log -1 --oneline main)"