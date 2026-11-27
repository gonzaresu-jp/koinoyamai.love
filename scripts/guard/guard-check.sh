#!/usr/bin/env bash
# エージェント用ガードの判定の核（ツール非依存。AGENTS.md §2・§13、docs/GUARD.md）
#   AI エージェントが実行しようとするシェルコマンドを、ルールファイルと照合して
#   allow / deny / ask を返す。各ツールへは adapters/ の薄いアダプタが橋渡しする。
#
# 使い方:
#   guard-check.sh '<コマンド>'        … 引数でコマンドを渡す
#   printf '%s' '<コマンド>' | guard-check.sh   … 標準入力で渡す（プレーンテキスト。JSON ではない）
#
# 終了コード:
#   0 = allow（標準出力は空）
#   2 = deny（理由を標準出力に出す。判定できない場合もこちらに倒す = fail-closed）
#   3 = ask（理由を標準出力に出す。「ユーザーに確認してから実行」の対象）
#
# ルール: 1 行 1 ルール `deny|理由|ERE` / `ask|理由|ERE`（# はコメント）。
#   既定のルールファイルはこのスクリプトと同じディレクトリの guard-rules.txt。
#   環境変数 GUARD_RULES で差し替えできる。
set -uo pipefail

GUARD_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES="${GUARD_RULES:-$GUARD_DIR/guard-rules.txt}"

fail_closed() { # 理由 — 判定できないので deny として返す
  printf '%s\n' "$1"
  echo "[guard-check] $1 のため、安全側に倒して止めます（fail-closed）" >&2
  exit 2
}

if [ "$#" -gt 0 ]; then
  cmd="$*"
else
  cmd="$(cat)" || fail_closed "入力を読めない"
fi
[ -z "$cmd" ] && exit 0
[ -f "$RULES" ] || fail_closed "ルールファイル（guard-rules.txt）が無い"

# 行末の \ による継続行をつなぐ（つながないと「git push \⏎ origin main」が行ごとの照合をすり抜ける）
cmd="${cmd//$'\\\r\n'/ }"
cmd="${cmd//$'\\\n'/ }"

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
  case "$kind" in
    deny|ask) ;;
    *) fail_closed "ルールの種類が不正（$kind）" ;;
  esac
  # パイプにすると、長いコマンドで grep -q が先に終わり printf が SIGPIPE（rc=141）になって
  # 「一致なし」と誤判定する（fail-open）。here-string で渡し、0 / 1 以外はすべて止める。
  grep -Eq -- "$re" <<<"$cmd"
  rc=$?
  case "$rc" in
    0) ;;
    1) continue ;;
    *) fail_closed "ルールの照合に失敗（rc=$rc, $re）" ;;
  esac
  case "$kind" in
    deny)
      printf '%s\n' "$reason"
      exit 2 ;;
    ask)
      [ -z "$ask_reason" ] && ask_reason="$reason" ;;
  esac
done < "$RULES"

if [ -n "$ask_reason" ]; then
  printf '%s\n' "$ask_reason"
  exit 3
fi
exit 0
