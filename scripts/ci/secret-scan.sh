#!/usr/bin/env bash
# 秘密値（トークン・鍵）らしき文字列の検出（AGENTS.md §3）
#   bash scripts/ci/secret-scan.sh                 … Git 管理下の全ファイルを検査
#   bash scripts/ci/secret-scan.sh --range A..B    … A..B の各コミットで「追加された行」を検査（pre-push 用。
#                                                    途中で追加して後で消したものも見つける）
#
# 見つけた値そのものは表示しない（先頭 4 文字だけ）。誤検出は次のどちらかで除外する:
#   - 行に `secret-scan: allow` と書く（ダミー値の行など）
#   - .secret-scan-ignore にパス（grep -E の正規表現・1 行 1 つ）を書く
set -euo pipefail
cd "$(dirname "$0")/../.."

# 名前|正規表現（ERE）
PATTERNS=(
  'AWS アクセスキー|AKIA[0-9A-Z]{16}'
  'GitHub トークン|gh[pousr]_[A-Za-z0-9]{36,}'
  'GitHub fine-grained トークン|github_pat_[A-Za-z0-9_]{40,}'
  'OpenAI / Anthropic 等の API キー|sk-(ant-|proj-)?[A-Za-z0-9_-]{32,}'
  'Slack トークン|xox[baprs]-[A-Za-z0-9-]{20,}'
  'Google API キー|AIza[0-9A-Za-z_-]{35}'
  'Stripe 本番キー|[rs]k_live_[0-9A-Za-z]{24,}'
  'Discord Webhook URL|discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]{30,}'
  '秘密鍵（PEM）|-----BEGIN ([A-Z]+ )*PRIVATE KEY-----'
)

SELF="scripts/ci/secret-scan.sh"
IGNORE_FILE=".secret-scan-ignore"

ignored_path() {
  local p="$1"
  [ "$p" = "$SELF" ] && return 0
  [ -f "$IGNORE_FILE" ] || return 1
  grep -vE '^\s*(#|$)' "$IGNORE_FILE" | while IFS= read -r re; do
    if printf '%s\n' "$p" | grep -Eq -- "$re"; then echo hit; break; fi
  done | grep -q hit
}

mask() { local s="$1"; printf '%s…(%d文字)' "${s:0:4}" "${#s}"; }

found=0
report() { # path line name match
  echo "  $1:$2  [$3]  $(mask "$4")"
  found=1
}

check_line() { # path lineno text
  local path="$1" ln="$2" text="$3" entry name re m
  case "$text" in *"secret-scan: allow"*) return 0 ;; esac
  for entry in "${PATTERNS[@]}"; do
    name="${entry%%|*}"; re="${entry#*|}"
    if m="$(printf '%s\n' "$text" | grep -Eo -- "$re" | head -n1)" && [ -n "$m" ]; then
      report "$path" "$ln" "$name" "$m"
    fi
  done
}

all_re="$(printf '%s\n' "${PATTERNS[@]}" | sed 's/^[^|]*|//' | paste -sd'|' -)"

if [ "${1:-}" = "--range" ]; then
  range="${2:?--range には A..B を指定してください}"
  echo "[secret-scan] 追加行を検査（コミットごと）: $range"
  # 範囲の両端の差分だと「途中で追加して後で消した」秘密値が打ち消し合って見えない。
  # git log -p でコミットごとの追加行を出し、awk で「パス<TAB>行番号<TAB>本文」に整形してから
  # まとめた正規表現で候補行だけに絞る（1 行ずつ grep を起動すると大きなコミットで極端に遅い）。
  while IFS=$'\t' read -r path ln text; do
    ignored_path "$path" && continue
    check_line "$path" "$ln" "$text"
  done < <(git log -p -U0 --no-color --no-ext-diff --format= "$range" -- \
    | awk '
        /^\+\+\+ b\// { path = substr($0, 7); next }
        /^\+\+\+ /    { path = ""; next }
        /^@@ /        { if (match($0, /\+[0-9]+/)) ln = substr($0, RSTART + 1, RLENGTH - 1) + 0; next }
        /^\+/         { if (path != "") print path "\t" ln "\t" substr($0, 2); ln++; next }
        /^ /          { ln++ }
      ' \
    | grep -E -- "$all_re" || true)
else
  echo "[secret-scan] Git 管理下の全ファイルを検査"
  while IFS= read -r hit; do
    path="${hit%%:*}"; rest="${hit#*:}"; ln="${rest%%:*}"; text="${rest#*:}"
    ignored_path "$path" && continue
    check_line "$path" "$ln" "$text"
  done < <(git grep -nIE -- "$all_re" || true)
fi

if [ "$found" -ne 0 ]; then
  echo "[secret-scan] 秘密値らしき文字列が見つかりました。本物なら直ちに無効化（ローテーション）し、コミットから除いてください。" >&2
  echo "             誤検出なら行に 'secret-scan: allow' を書くか、$IGNORE_FILE にパスを追加してください。" >&2
  exit 1
fi
echo "[secret-scan] OK"
