#!/usr/bin/env bash
# Claude Code 用アダプタ（PreToolUse / Bash）: 入力 JSON からコマンドを取り出し、
# 核（scripts/guard/guard-check.sh）の判定を Claude Code の形式で返す（docs/GUARD.md）。
#   deny … 理由を stderr に出して exit 2（実行を止め、理由がエージェントに返る）
#   ask  … {"hookSpecificOutput": {"permissionDecision": "ask", ...}} を標準出力に出す
#   allow / 空コマンド … 何も出さず exit 0
#   判定できない場合（JSON を読めない等）は止める（fail-closed）。
set -uo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE="$ADAPTER_DIR/../guard-check.sh"
# shellcheck source=lib.sh
. "$ADAPTER_DIR/lib.sh"

fail_closed() {
  echo "[guard] $1 のため、安全側に倒してこのコマンドを止めました（scripts/guard/adapters/claude-code.sh）" >&2
  exit 2
}

input="$(cat)" || fail_closed "入力を読めない"
cmd="$(extract_path tool_input command)" || fail_closed "フックの入力（JSON）を解析できない"
[ -z "$cmd" ] && exit 0

reason="$(printf '%s' "$cmd" | bash "$CORE")"
rc=$?
case "$rc" in
  0) exit 0 ;;
  3)
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' \
      "$(json_escape "[guard] $reason")"
    exit 0 ;;
  *)
    echo "[guard] このコマンドは実行できません: $reason" >&2
    echo "        必要なら、理由を添えてユーザーに手動での実行を依頼してください。" >&2
    exit 2 ;;
esac
