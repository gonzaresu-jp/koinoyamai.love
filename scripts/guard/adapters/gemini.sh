#!/usr/bin/env bash
# Gemini CLI 用アダプタ（BeforeTool / run_shell_command）: 入力 JSON の tool_input.command を
# 取り出し、核（scripts/guard/guard-check.sh）の判定を Gemini CLI の形式で返す（docs/GUARD.md）。
#   出力は {"decision": "allow|deny", "reason": ..., "systemMessage": ...} の JSON。
#   Gemini CLI は標準出力を JSON として読むため、標準出力には JSON 以外を出さない。
#   Gemini CLI の BeforeTool の decision は allow / deny のみで、ask に対応していない。
#   そのため核の ask は deny に倒して止め、理由にその旨を書く（fail-closed）。
#   判定できない場合も deny を返す（fail-closed）。
set -uo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE="$ADAPTER_DIR/../guard-check.sh"
# shellcheck source=lib.sh
. "$ADAPTER_DIR/lib.sh"

emit() { # decision 理由
  if [ "$1" = "allow" ]; then
    printf '{"decision":"allow"}\n'
  else
    printf '{"decision":"deny","reason":"%s","systemMessage":"%s"}\n' \
      "$(json_escape "$2")" "$(json_escape "$2")"
  fi
}

fail_closed() {
  emit deny "[guard] $1 のため、安全側に倒してこのコマンドを止めました（scripts/guard/adapters/gemini.sh）"
  exit 0
}

input="$(cat)" || fail_closed "入力を読めない"
# matcher は settings.json 側（run_shell_command）で絞るが、二重に確かめる。
# シェル以外のツールはこのガードの対象外なので素通しする。
tool_name="$(extract_path tool_name)" || fail_closed "フックの入力（JSON）を解析できない"
if [ -n "$tool_name" ] && [ "$tool_name" != "run_shell_command" ]; then
  emit allow ""
  exit 0
fi
cmd="$(extract_path tool_input command)" || fail_closed "フックの入力（JSON）を解析できない"
if [ -z "$cmd" ]; then
  emit allow ""
  exit 0
fi

reason="$(printf '%s' "$cmd" | bash "$CORE")"
rc=$?
case "$rc" in
  0) emit allow "" ;;
  3) emit deny "[guard] このコマンドは本来「ユーザーに確認してから」（ask）ですが、Gemini CLI の hook は ask に対応していないため止めました: $reason" ;;
  *) emit deny "[guard] このコマンドは実行できません: $reason" ;;
esac
exit 0
