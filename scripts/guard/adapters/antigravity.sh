#!/usr/bin/env bash
# Antigravity CLI 用アダプタ（PreToolUse / run_command）: 入力 JSON の toolCall.args.CommandLine を
# 取り出し、核（scripts/guard/guard-check.sh）の判定を Antigravity の形式で返す（docs/GUARD.md）。
#   出力は {"decision": "allow|deny|force_ask", "reason": ...} の JSON。
#   Antigravity は標準出力を JSON として読むため、標準出力には JSON 以外を出さない。
#   核の ask は force_ask に変換する。素の ask は「Always Allow」の設定で素通りしうるが、
#   force_ask は保存済みの許可を無視して毎回確認する（公式ドキュメントの定義）。
#   ガードの ask は「毎回ユーザーが判断する」操作のためのもの（AGENTS.md §13）なので、
#   キャッシュされた許可で素通りさせない force_ask が意味に合う。
#   判定できない場合は deny を返す（fail-closed）。
set -uo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE="$ADAPTER_DIR/../guard-check.sh"
# shellcheck source=lib.sh
. "$ADAPTER_DIR/lib.sh"

emit() { # decision 理由
  if [ "$1" = "allow" ]; then
    printf '{"decision":"allow"}\n'
  else
    printf '{"decision":"%s","reason":"%s"}\n' "$1" "$(json_escape "$2")"
  fi
}

fail_closed() {
  emit deny "[guard] $1 のため、安全側に倒してこのコマンドを止めました（scripts/guard/adapters/antigravity.sh）"
  exit 0
}

input="$(cat)" || fail_closed "入力を読めない"
# matcher は hooks.json 側（run_command）で絞るが、二重に確かめる。
# コマンド実行以外のツールはこのガードの対象外なので素通しする。
tool_name="$(extract_path toolCall name)" || fail_closed "フックの入力（JSON）を解析できない"
if [ -n "$tool_name" ] && [ "$tool_name" != "run_command" ]; then
  emit allow ""
  exit 0
fi
cmd="$(extract_path toolCall args CommandLine)" || fail_closed "フックの入力（JSON）を解析できない"
if [ -z "$cmd" ]; then
  emit allow ""
  exit 0
fi

[ -f "$CORE" ] || fail_closed "ガードの核（guard-check.sh）が無い"
reason="$(printf '%s' "$cmd" | bash "$CORE")"
rc=$?
case "$rc" in
  0) emit allow "" ;;
  3) emit force_ask "[guard] $reason" ;;
  *) emit deny "[guard] このコマンドは実行できません: $reason" ;;
esac
exit 0
