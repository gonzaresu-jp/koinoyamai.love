#!/usr/bin/env bash
# Claude Code の PreToolUse フック: エージェントが実行しようとする Bash コマンドを検査する（AGENTS.md §2・§13）
#   ルールは同じディレクトリの guard-rules.txt（1 行 1 ルール）:
#     deny|<理由>|<ERE>  … 実行させない（理由はエージェントに返る）
#     ask|<理由>|<ERE>   … ユーザーに確認を求める（理由は確認画面に出る）
#   判定できないとき（JSON を読めない・ルールが無い等）は止める（fail-closed）。
#
# 限界: Claude Code のツール呼び出しにしか効かない。人間のターミナル・他の AI ツールからの
#       操作は止まらないので、git の pre-push（scripts/hooks/pre-push）と併用する。
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES="$HOOK_DIR/guard-rules.txt"

fail_closed() {
  echo "[guard] $1 のため、安全側に倒してこのコマンドを止めました（.claude/hooks/guard-bash.sh）" >&2
  exit 2
}

input="$(cat)" || fail_closed "入力を読めない"

# tool_input.command を取り出す（jq → node → python3 の順。どれも無ければ止める）
extract_command() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -er '.tool_input.command // ""'
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=(JSON.parse(s).tool_input||{}).command;process.stdout.write(typeof c==="string"?c:"")})'
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$input" | python3 -c 'import sys,json;c=json.load(sys.stdin).get("tool_input",{}).get("command","");sys.stdout.write(c if isinstance(c,str) else "")'
  else
    return 3
  fi
}
cmd="$(extract_command)" || fail_closed "フックの入力（JSON）を解析できない"
[ -z "$cmd" ] && exit 0
[ -f "$RULES" ] || fail_closed "ルールファイル（guard-rules.txt）が無い"

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/ }"; s="${s//$'\r'/ }"; s="${s//$'\t'/ }"
  printf '%s' "$s"
}

ask_reason=""
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  # 書式: 種類|理由|正規表現（正規表現は行末まで。中の | はそのまま使える）
  kind="${line%%|*}"; rest="${line#*|}"
  reason="${rest%%|*}"; re="${rest#*|}"
  if [ "$rest" = "$line" ] || [ "$re" = "$rest" ] || [ -z "$re" ]; then
    fail_closed "ルールの書式が不正（$line）"
  fi
  printf '%s\n' "$cmd" | grep -Eq -- "$re"
  rc=$?
  if [ "$rc" -eq 2 ]; then fail_closed "ルールの正規表現が不正（$re）"; fi
  [ "$rc" -ne 0 ] && continue
  case "$kind" in
    deny)
      echo "[guard] このコマンドは実行できません: $reason" >&2
      echo "        必要なら、理由を添えてユーザーに手動での実行を依頼してください。" >&2
      exit 2 ;;
    ask)
      [ -z "$ask_reason" ] && ask_reason="$reason" ;;
  esac
done < "$RULES"

if [ -n "$ask_reason" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' \
    "$(json_escape "[guard] $ask_reason")"
fi
exit 0
