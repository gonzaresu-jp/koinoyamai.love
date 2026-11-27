# アダプタ共通の部品（各アダプタから source して使う。単体では実行しない）
#   extract_path '<JSON のパス>' … 標準入力に残っている JSON から文字列フィールドを取り出す
#   json_escape '<文字列>'       … JSON 文字列の中身として安全な形にエスケープする
#
# JSON の解析は jq → node → python3 の順に試し、どれも無ければ失敗（呼び出し側が fail-closed で止める）。

extract_path() { # 例: extract_path tool_input command / extract_path command
  if command -v jq >/dev/null 2>&1; then
    local filter="."
    local p
    for p in "$@"; do filter+="[\"$p\"]"; done
    printf '%s' "$input" | jq -er "if $filter == null then \"\" elif ($filter | type) != \"string\" then error(\"not a string\") else $filter end"
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$input" | GUARD_EXTRACT_PATH="$*" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o=JSON.parse(s);for(const k of process.env.GUARD_EXTRACT_PATH.split(" ")){o=(o==null)?undefined:o[k]}if(typeof o==="string"){process.stdout.write(o)}else if(o!=null){process.exit(1)}})'
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$input" | GUARD_EXTRACT_PATH="$*" python3 -c 'import sys,json,os;o=json.load(sys.stdin)
for k in os.environ["GUARD_EXTRACT_PATH"].split(" "):
    o=o.get(k) if isinstance(o,dict) else None
if isinstance(o,str): sys.stdout.write(o)
elif o is not None: sys.exit(1)'
  else
    return 3
  fi
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"; s="${s//$'\r'/ }"; s="${s//$'\t'/ }"
  printf '%s' "$s"
}
