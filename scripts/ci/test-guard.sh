#!/usr/bin/env bash
# .claude/hooks/guard-bash.sh の判定テスト。guard-rules.txt を変えたら例を足すこと。
#   期待値: deny（exit 2）/ ask（exit 0 + permissionDecision "ask"）/ allow（exit 0・出力なし）
set -uo pipefail
cd "$(dirname "$0")/../.."
GUARD=".claude/hooks/guard-bash.sh"

json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

fail=0; n=0
expect() { # 期待値 コマンド
  local want="$1" cmd="$2" out rc got
  n=$((n + 1))
  out="$(printf '{"tool_name":"Bash","tool_input":{"command":%s,"description":"x"}}' "$(json_str "$cmd")" \
    | bash "$GUARD" 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 2 ]; then got=deny
  elif [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"permissionDecision":"ask"'; then got=ask
  elif [ "$rc" -eq 0 ] && [ -z "$out" ]; then got=allow
  else got="error(rc=$rc)"; fi
  if [ "$got" != "$want" ]; then
    echo "  NG: 期待 $want / 実際 $got : $cmd"; fail=1
  fi
}

# ---- 共通ルール ----
expect deny  'git push --no-verify origin agent/x'
expect deny  'git commit --no-verify -m wip'
expect deny  'SKIP_PREPUSH=1 git push origin main'
expect deny  'git push origin main'
expect deny  'git push origin HEAD:main'
expect deny  'git -C repo push origin staging'
expect deny  $'cd repo\ngit push origin main'
expect allow 'git push origin agent/main-fix'
expect allow 'git push -u origin docs/x && git checkout main'
expect ask   'git push --force origin agent/x'
expect ask   'git push -f origin agent/x'
expect ask   'git reset --hard origin/main'
expect ask   'git clean -fd'
expect ask   'git checkout -- .'
expect allow 'git checkout -b fix/x'
expect ask   'gh pr merge 12 --squash'
expect allow 'gh pr view 12'
expect ask   'cat .env'
expect allow 'cat .env.example'
expect allow 'npm test'
expect allow 'echo "do not use --no-verify"'

# ---- koinoyamai.love 固有（AGENTS.md §1・§2・§6）----
expect deny  'curl -s -X POST http://127.0.0.1:8080/api/notify -d @body.json'
expect deny  'curl -X POST https://koinoyamai.love/api/notify -H "x-notify-token: x"'
expect allow 'curl -s -X POST http://127.0.0.1:8081/api/notify -d @body.json'
expect allow 'grep -rn "/api/notify" routes/'
expect ask   'pm2 restart mai-push-api --update-env'
expect ask   'pm2 reload mai-push-worker'
expect ask   'pm2 restart all'
expect ask   'pm2 kill'
expect allow 'pm2 restart mai-push-api-test --update-env'
expect allow 'pm2 logs mai-push-api --lines 50'
expect ask   'sudo bash scripts/nginx/deploy.sh --apply'
expect allow 'bash scripts/nginx/deploy.sh'
expect ask   'bash scripts/deploy/npm-deploy.sh --apply'
expect ask   'sudo bash scripts/nginx/apply-maintenance.sh --on'
expect ask   'systemctl --user restart llama-embed.service'
expect allow 'systemctl --user status pi-vector.service'
expect allow 'SKIP_PREPUSH_REGRESSION=1 git push -u origin agent/x'

# ---- 異常系: 判定できなければ止める ----
n=$((n + 1))
if printf 'not json' | bash "$GUARD" >/dev/null 2>&1; then
  echo "  NG: 壊れた入力で止まらなかった"; fail=1
fi

if [ "$fail" -ne 0 ]; then echo "[test-guard] 失敗" >&2; exit 1; fi
echo "[test-guard] OK（${n} 件）"
