#!/usr/bin/env bash
# canonical staging tree が staging ブランチ上にあることを保証する。
#
# なぜ必要か（2026-10-24 実測）:
#   複数セッションが同じ作業ツリーを共有すると、一方が branch を切り替えた瞬間に
#   もう一方のファイルも切り替わる。staging アプリ（mai-push-api-test）のコードも変わり、
#   検証結果が「どのブランチを測ったのか」分からなくなる。さらに PR に無関係なコミットが
#   混入する（PR #83 で実際に発生）。
#
# 使い方:
#   bash scripts/ops/ensure-staging-tree.sh [dir]
#     dir 未指定時は KOINOYAMAI_STAGING_TREE または /home/yuzuki/koinoyamai.love-test
# 終了コード: 0 = OK / 1 = 違反 / 2 = 前提不成立
set -uo pipefail
TREE="${1:-${KOINOYAMAI_STAGING_TREE:-/home/yuzuki/koinoyamai.love-test}}"
if [ ! -d "$TREE" ]; then echo "[ensure-staging-tree] ERROR: $TREE が存在しません" >&2; exit 2; fi
if [ ! -d "$TREE/.git" ] && [ ! -f "$TREE/.git" ]; then
  echo "[ensure-staging-tree] ERROR: $TREE は git ツリーではありません" >&2; exit 2
fi
BRANCH=$(git -C "$TREE" branch --show-current 2>/dev/null || echo "")
if [ "$BRANCH" != "staging" ]; then
  echo "[ensure-staging-tree] ERROR: $TREE は staging ブランチではありません（現在: ${BRANCH:-detached}）" >&2
  echo "  canonical staging tree を切り替えるな。作業は worktree で行うこと（scripts/ops/new-worktree.sh）。" >&2
  exit 1
fi
if [ -n "$(git -C "$TREE" status --porcelain 2>/dev/null)" ]; then
  echo "[ensure-staging-tree] WARN: $TREE に未コミット変更があります" >&2
fi
exit 0
