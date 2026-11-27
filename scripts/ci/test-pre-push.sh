#!/usr/bin/env bash
# scripts/hooks/pre-push の「保護ブランチへの push 拒否」の判定テスト（AGENTS.md §13）
#   git が pre-push に渡す標準入力（<local ref> <local sha> <remote ref> <remote sha>）を模して流す。
#   拒否のケースは重い検査（構文・回帰テスト）に入る前に終わるので、CI でも速い。
set -uo pipefail
cd "$(dirname "$0")/../.."
HOOK="scripts/hooks/pre-push"
SHA="$(git rev-parse HEAD)"
ZERO="0000000000000000000000000000000000000000"

fail=0; n=0
expect_block() { # 説明 標準入力
  n=$((n + 1))
  if printf '%s\n' "$2" | bash "$HOOK" origin x >/dev/null 2>&1; then
    echo "  NG: 止まらなかった: $1"; fail=1
  fi
}
expect_skip() { # 説明 標準入力（SKIP_PREPUSH=1 で検査せず通ること）
  n=$((n + 1))
  local out
  out="$(printf '%s\n' "$2" | SKIP_PREPUSH=1 bash "$HOOK" origin x 2>&1)" || { echo "  NG: SKIP_PREPUSH でも止まった: $1"; fail=1; return; }
  printf '%s' "$out" | grep -q 'SKIP_PREPUSH=1 によりスキップ' || { echo "  NG: スキップされなかった: $1"; fail=1; }
}

# 今いるブランチに関係なく、push 先の ref で判定する
expect_block "main へ"                         "refs/heads/agent/x $SHA refs/heads/main $SHA"
expect_block "agent/x:main（別名で main へ）"   "refs/heads/agent/x $SHA refs/heads/main $ZERO"
expect_block "staging へ"                      "refs/heads/agent/x $SHA refs/heads/staging $SHA"
expect_block "main の削除"                     "(delete) $ZERO refs/heads/main $SHA"
expect_block "複数 ref のうち 1 つが main"      "refs/heads/agent/x $SHA refs/heads/agent/x $ZERO
refs/heads/agent/x $SHA refs/heads/main $SHA"
# cron（SKIP_PREPUSH=1）は main への push を通す
expect_skip  "cron の main への push"          "refs/heads/main $SHA refs/heads/main $SHA"

if [ "$fail" -ne 0 ]; then echo "[test-pre-push] 失敗" >&2; exit 1; fi
echo "[test-pre-push] OK（${n} 件）"
