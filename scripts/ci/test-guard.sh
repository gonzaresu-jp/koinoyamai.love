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
# 名前の直後に記号・引用符（独立レビュー B1）
expect deny  'git push origin main;'
expect deny  "git push origin 'main'"
expect deny  'git push origin agent/x:main; echo done'
expect deny  'git push origin HEAD:refs/heads/main'
expect deny  'git push origin +main'
expect deny  'git push --all origin'
expect deny  'git push --mirror origin'
expect deny  'git push origin x --no-verify;'
expect deny  'git -c core.hooksPath=/dev/null push origin agent/x'
expect deny  'SKIP_PREPUSH="1" git push origin agent/x'
expect allow 'git log main'
expect allow 'git push origin agent/main-x'
# 行末 \ の継続行（B2）
expect deny  $'git push \\\norigin main'
expect deny  $'git push \\\n  --no-verify origin agent/x'
expect deny  $'git push \\\r\norigin main'
# 強制・作業を消す操作の別表記
expect ask   'git push origin +agent/x'
expect ask   'git push --force-if-includes origin agent/x'
expect ask   'git clean -d -f'
expect ask   'git restore -- .'
expect ask   'git checkout -f'
# .env の表示の別表記（.env.example は対象外）
expect ask   'cat .env.production'
expect ask   'grep . .env'
expect ask   "sed -n p .env"
expect ask   'cat .env|head'
expect allow 'grep API_KEY .env.example'

# ---- koinoyamai.love 固有（AGENTS.md §1・§2・§6）----
expect deny  'curl -s -X POST http://127.0.0.1:8080/api/notify -d @body.json'
expect deny  'curl -X POST https://koinoyamai.love/api/notify -H "x-notify-token: x"'
expect allow 'curl -s -X POST http://127.0.0.1:8081/api/notify -d @body.json'
expect allow 'grep -rn "/api/notify" routes/'
expect ask   'pm2 restart mai-push-api --update-env'
expect ask   'pm2 reload mai-push-worker'
expect ask   'pm2 restart all'
expect ask   'pm2 kill'
expect ask   'pm2 restart mai-push-api; pm2 logs'
expect ask   'pm2 restart "mai-push-api"'
expect ask   'pm2 restart 0'
expect ask   'pm2 gracefulReload mai-push-api'
expect ask   'pm2 restart mai-push-api-test --update-env'
expect ask   'kill $(pgrep -f mai-push-api)'
expect allow 'grep -rn "killed" node_modules/x'
expect allow 'pm2 logs mai-push-api --lines 50'
expect allow 'pm2 list'
expect deny  'curl -X POST https://koinoyamai.love//api/notify'
expect deny  'curl -X POST http://127.0.0.1:8080/api//notify'
expect deny  'curl -X POST http://127.0.0.1:8080/api/../api/notify'
expect deny  'curl -X POST https://KoinoYamai.Love/api/notify'
expect deny  'curl -X POST https://koinoyamai.love:443/api/notify'
expect deny  "node -e \"fetch('http://127.0.0.1:8080/api/notify',{method:'POST'})\""
expect deny  'curl -d @body.json --url http://localhost:8080/api/notify'
expect ask   'sudo bash scripts/nginx/deploy.sh --apply'
expect allow 'bash scripts/nginx/deploy.sh'
expect ask   'bash scripts/deploy/npm-deploy.sh --apply'
expect ask   'sudo bash scripts/nginx/apply-maintenance.sh --on'
expect ask   'systemctl --user restart llama-embed.service'
expect ask   'sudo service nginx restart'
expect allow 'systemctl --user status pi-vector.service'
expect allow 'SKIP_PREPUSH_REGRESSION=1 git push -u origin agent/x'

# ---- 長いコマンド（B3: パイプの SIGPIPE で deny が無効になっていた）----
big="$(head -c 200000 /dev/zero | tr '\0' 'a')"
expect deny  "curl -X POST http://127.0.0.1:8080/api/notify -d @- <<EOF"$'\n'"$big"$'\n'"EOF"
expect deny  "git push origin main"$'\n'"$big"

# ---- 異常系: 判定できなければ止める ----
n=$((n + 1))
if printf 'not json' | bash "$GUARD" >/dev/null 2>&1; then
  echo "  NG: 壊れた入力で止まらなかった"; fail=1
fi

if [ "$fail" -ne 0 ]; then echo "[test-guard] 失敗" >&2; exit 1; fi
echo "[test-guard] OK（${n} 件）"
