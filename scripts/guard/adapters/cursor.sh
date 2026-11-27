#!/usr/bin/env bash
# Cursor 用アダプタ（beforeShellExecution）: 入力 JSON のトップレベル command を取り出し、
# 核（scripts/guard/guard-check.sh）の判定を Cursor の形式で返す（docs/GUARD.md）。
#   出力は {"permission": "allow|deny|ask", "user_message": ..., "agent_message": ...} の JSON。
#   Cursor は標準出力を JSON として読むため、標準出力には JSON 以外を出さない。
#   判定できない場合は deny を返す（fail-closed。.cursor/hooks.json 側でも failClosed: true）。
set -uo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE="$ADAPTER_DIR/../guard-check.sh"
# shellcheck source=lib.sh
. "$ADAPTER_DIR/lib.sh"

emit() { # permission 理由
  printf '{"permission":"%s","user_message":"%s","agent_message":"%s"}\n' \
    "$1" "$(json_escape "$2")" "$(json_escape "$2")"
}

fail_closed() {
  emit deny "[guard] $1 のため、安全側に倒してこのコマンドを止めました（scripts/guard/adapters/cursor.sh）"
  exit 0
}

input="$(cat)" || fail_closed "入力を読めない"
cmd="$(extract_path command)" || fail_closed "フックの入力（JSON）を解析できない"
if [ -z "$cmd" ]; then
  emit allow ""
  exit 0
fi

reason="$(printf '%s' "$cmd" | bash "$CORE")"
rc=$?
case "$rc" in
  0) emit allow "" ;;
  3) emit ask "[guard] $reason" ;;
  *) emit deny "[guard] このコマンドは実行できません: $reason" ;;
esac
exit 0
