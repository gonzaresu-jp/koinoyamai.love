#!/usr/bin/env bash
# per-session worktree を作成する。
#
# なぜ必要か（2026-10-24 実測）:
#   複数セッションが同じ作業ツリーを共有すると、branch switch が他セッションのファイルまで
#   書き換える。worktree で物理的に分離すれば、この事故は起きない。
#
# 使い方:
#   bash scripts/ops/new-worktree.sh <slug> [base-ref]
#     slug    : 英数字・. _ - のみ。worktree の識別子になる
#     base-ref: 既定 origin/main
# 作成先: /tmp/opencode/<slug>/worktree  ブランチ: agent/<slug>
# node_modules は canonical staging ツリーから symlink（読み取り専用）。
#   npm install は canonical ツリーで 1 回だけ行うこと（worktree で実行すると canonical を汚す）。
# 終了コード: 0 = OK / 1 = 既存 / 2 = 引数不正
set -euo pipefail
SLUG="${1:?slug を指定してください（例: fix-notify-123）}"
BASE="${2:-origin/main}"
ROOT="${KOINOYAMAI_REPO:-/var/www/html/koinoyamai.love}"
STAGING="${KOINOYAMAI_STAGING_TREE:-/home/yuzuki/koinoyamai.love-test}"
case "$SLUG" in *[!a-zA-Z0-9._-]*) echo "[new-worktree] slug に使えない文字が含まれています: $SLUG" >&2; exit 2;; esac
WT="/tmp/opencode/$SLUG/worktree"
if [ -d "$WT" ]; then echo "[new-worktree] 既に存在します: $WT" >&2; exit 1; fi
mkdir -p "/tmp/opencode/$SLUG"
git -C "$ROOT" worktree add "$WT" -b "agent/$SLUG" "$BASE" >/dev/null
if [ -d "$STAGING/node_modules" ] && [ ! -e "$WT/node_modules" ]; then
  ln -s "$STAGING/node_modules" "$WT/node_modules"
fi
cat > "/tmp/opencode/$SLUG/env.sh" <<EOF
# このファイルを source してから作業する:
#   source /tmp/opencode/$SLUG/env.sh
export KOINOYAMAI_WORKTREE="$WT"
export NODE_PATH="$STAGING/node_modules"
export PATH="/home/yuzuki/.nvm/versions/node/v24.22.1/bin:\$PATH"
cd "$WT"
EOF
echo "[new-worktree] 作成しました: $WT"
echo "  ブランチ: agent/$SLUG (base: $BASE)"
echo "  使う前に: source /tmp/opencode/$SLUG/env.sh"
echo "  後始末: git -C $ROOT worktree remove $WT"
