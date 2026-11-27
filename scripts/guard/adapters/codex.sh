#!/usr/bin/env bash
# Codex CLI 用アダプタ（PreToolUse / Bash）: 入力 JSON は Claude Code と同形式
# （tool_input.command）。核（scripts/guard/guard-check.sh）の判定を Codex の形式で返す。
#   Codex の hook の permissionDecision は allow / deny のみで、ask に対応していない。
#   そのため核の ask は deny に倒して止め、理由にその旨を書く（fail-closed。docs/GUARD.md）。
#   deny … 理由を stderr に出して exit 2
#   allow / 空コマンド … 何も出さず exit 0
#   判定できない場合は止める（fail-closed）。
# 注意: プロジェクトの hook は Codex の /hooks でレビュー・信頼（trust）しないと実行されない。
set -uo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE="$ADAPTER_DIR/../guard-check.sh"
# shellcheck source=lib.sh
. "$ADAPTER_DIR/lib.sh"

fail_closed() {
  echo "[guard] $1 のため、安全側に倒してこのコマンドを止めました（scripts/guard/adapters/codex.sh）" >&2
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
    echo "[guard] このコマンドは本来「ユーザーに確認してから」（ask）ですが、Codex の hook は ask に対応していないため止めました: $reason" >&2
    echo "        必要なら、理由を添えてユーザーに手動での実行を依頼してください。" >&2
    exit 2 ;;
  *)
    echo "[guard] このコマンドは実行できません: $reason" >&2
    echo "        必要なら、理由を添えてユーザーに手動での実行を依頼してください。" >&2
    exit 2 ;;
esac
