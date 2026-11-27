#!/usr/bin/env bash
# エージェント用ガードの判定テスト（核 guard-check.sh + 各アダプタ）。guard-rules.txt を変えたら例を足すこと。
#   核:          終了コード 0 = allow / 2 = deny / 3 = ask（deny・ask は理由が返ることも確かめる）
#   Claude Code: deny = exit 2 / ask = exit 0 + permissionDecision "ask" / allow = exit 0・出力なし
#   Codex:       ask に対応していないため、核の ask は deny（exit 2）に倒れる
#   Cursor:      標準出力 JSON の permission（allow / deny / ask）
#   Gemini CLI:  標準出力 JSON の decision（allow / deny。核の ask は deny に倒れる）
#   Antigravity: 標準出力 JSON の decision（allow / deny。核の ask は force_ask になる）
#   opencode:    プラグイン（.opencode/plugins/agent-guard.js）。判定は scripts/ci/test-guard-opencode.mjs が
#                node で実行する（deny / ask はどちらも throw。node が無い環境では飛ばす）
set -uo pipefail
cd "$(dirname "$0")/../.."
CORE="scripts/guard/guard-check.sh"
ADAPTERS="scripts/guard/adapters"

json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

fail=0; n=0
ng() { echo "  NG: $1"; fail=1; }

# ---------- 核 ----------
expect_core() { # 期待値(allow|deny|ask) コマンド
  local want="$1" cmd="$2" reason rc got
  n=$((n + 1))
  reason="$(bash "$CORE" "$cmd" 2>/dev/null)"; rc=$?
  case "$rc" in 0) got=allow ;; 2) got=deny ;; 3) got=ask ;; *) got="error(rc=$rc)" ;; esac
  if [ "$got" != "$want" ]; then ng "核: 期待 $want / 実際 $got : $cmd"; return; fi
  if [ "$want" != "allow" ] && [ -z "$reason" ]; then ng "核: 理由が返らない : $cmd"; fi
}

core_cases() { # 実行関数名を受け取り、共通のケース一覧を流す
  local ex="$1"
  # ---- 共通ルール ----
  "$ex" deny  'git push --no-verify origin agent/x'
  "$ex" deny  'git commit --no-verify -m wip'
  "$ex" deny  'SKIP_PREPUSH=1 git push origin main'
  "$ex" deny  'git push origin main'
  "$ex" deny  'git push origin HEAD:main'
  "$ex" deny  'git -C repo push origin staging'
  "$ex" deny  "$(printf 'cd repo\ngit push origin main')"
  "$ex" allow 'git push origin agent/main-fix'
  "$ex" allow 'git push -u origin docs/x && git checkout main'
  "$ex" ask   'git push --force origin agent/x'
  "$ex" ask   'git push -f origin agent/x'
  "$ex" ask   'git reset --hard origin/main'
  "$ex" ask   'git clean -fd'
  "$ex" ask   'git checkout -- .'
  "$ex" allow 'git checkout -b fix/x'
  "$ex" ask   'gh pr merge 12 --squash'
  "$ex" allow 'gh pr view 12'
  "$ex" ask   'cat .env'
  "$ex" allow 'cat .env.example'
  "$ex" allow 'npm test'
  "$ex" allow 'echo "do not use --no-verify"'
  # 名前の直後に記号・引用符
  "$ex" deny  'git push origin main;'
  "$ex" deny  "git push origin 'main'"
  "$ex" deny  'git push origin agent/x:main; echo done'
  "$ex" deny  'git push origin HEAD:refs/heads/main'
  "$ex" deny  'git push origin +main'
  "$ex" deny  'git push --all origin'
  "$ex" deny  'git push --mirror origin'
  "$ex" deny  'git push origin x --no-verify;'
  "$ex" deny  'git -c core.hooksPath=/dev/null push origin agent/x'
  "$ex" deny  'SKIP_PREPUSH="1" git push origin agent/x'
  "$ex" allow 'git log main'
  "$ex" allow 'git push origin agent/main-x'
  # 行末 \ の継続行
  "$ex" deny  "$(printf 'git push \\\norigin main')"
  "$ex" deny  "$(printf 'git push \\\n  --no-verify origin agent/x')"
  "$ex" deny  "$(printf 'git push \\\r\norigin main')"
  # 強制・作業を消す操作の別表記
  "$ex" ask   'git push origin +agent/x'
  "$ex" ask   'git push --force-if-includes origin agent/x'
  "$ex" ask   'git clean -d -f'
  "$ex" ask   'git restore -- .'
  "$ex" ask   'git checkout -f'
  # .env の表示の別表記（.env.example は対象外）
  "$ex" ask   'cat .env.production'
  "$ex" ask   'grep . .env'
  "$ex" ask   "sed -n p .env"
  "$ex" ask   'cat .env|head'
  "$ex" allow 'grep API_KEY .env.example'
}

core_cases expect_core

# 標準入力でも渡せること
n=$((n + 1))
printf '%s' 'git push origin main' | bash "$CORE" >/dev/null 2>&1
[ "$?" -eq 2 ] || ng "核(stdin): deny のコマンドが止まらない"
n=$((n + 1))
printf '%s' 'git status' | bash "$CORE" >/dev/null 2>&1
[ "$?" -eq 0 ] || ng "核(stdin): allow のコマンドが通らない"

# 長いコマンド（パイプの SIGPIPE で deny が無効にならないこと）。
# 200KB は 1 引数の上限（128KB）を超えるため、引数ではなく標準入力で渡す。
big="$(head -c 200000 /dev/zero | tr '\0' 'a')"
n=$((n + 1))
printf 'git push origin main\n%s' "$big" | bash "$CORE" >/dev/null 2>&1
[ "$?" -eq 2 ] || ng "核(stdin): 長いコマンドで deny が無効になった"

# 異常系: 判定できなければ止める（fail-closed）
n=$((n + 1))
GUARD_RULES=/nonexistent/guard-rules.txt bash "$CORE" 'git status' >/dev/null 2>&1
[ "$?" -eq 2 ] || ng "核: ルールファイルが無いのに止まらない"
tmp_rules="$(mktemp)"
printf 'deny|書式が壊れたルール\n' > "$tmp_rules"
n=$((n + 1))
GUARD_RULES="$tmp_rules" bash "$CORE" 'git status' >/dev/null 2>&1
[ "$?" -eq 2 ] || ng "核: 書式の壊れたルールで止まらない"
printf 'deny|壊れた正規表現|([[\n' > "$tmp_rules"
n=$((n + 1))
GUARD_RULES="$tmp_rules" bash "$CORE" 'git status' >/dev/null 2>&1
[ "$?" -eq 2 ] || ng "核: 壊れた正規表現で止まらない"
rm -f "$tmp_rules"

# ---------- Claude Code アダプタ ----------
claude_payload() { printf '{"tool_name":"Bash","tool_input":{"command":%s,"description":"x"}}' "$(json_str "$1")"; }
expect_claude() { # 期待値 コマンド
  local want="$1" cmd="$2" out rc got
  n=$((n + 1))
  out="$(claude_payload "$cmd" | bash "$ADAPTERS/claude-code.sh" 2>/dev/null)"; rc=$?
  if [ "$rc" -eq 2 ]; then got=deny
  elif [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"permissionDecision":"ask"'; then got=ask
  elif [ "$rc" -eq 0 ] && [ -z "$out" ]; then got=allow
  else got="error(rc=$rc)"; fi
  [ "$got" != "$want" ] && ng "claude-code: 期待 $want / 実際 $got : $cmd"
}
core_cases expect_claude

# 異常系: 壊れた入力では止める
n=$((n + 1))
if printf 'not json' | bash "$ADAPTERS/claude-code.sh" >/dev/null 2>&1; then
  ng "claude-code: 壊れた入力で止まらなかった"
fi

# ---------- koinoyamai.love 固有ルール（AGENTS.md §1・§2・§6） ----------
project_cases() { # 実行関数名を受け取り、固有のケース一覧を流す
  local ex="$1"
  "$ex" deny  'curl -s -X POST http://127.0.0.1:8080/api/notify -d @body.json'
  "$ex" deny  'curl -X POST https://koinoyamai.love/api/notify -H "x-notify-token: x"'
  "$ex" allow 'curl -s -X POST http://127.0.0.1:8081/api/notify -d @body.json'
  "$ex" allow 'grep -rn "/api/notify" routes/'
  "$ex" ask   'pm2 restart mai-push-api --update-env'
  "$ex" ask   'pm2 reload mai-push-worker'
  "$ex" ask   'pm2 restart all'
  "$ex" ask   'pm2 kill'
  "$ex" ask   'pm2 restart mai-push-api; pm2 logs'
  "$ex" ask   'pm2 restart "mai-push-api"'
  "$ex" ask   'pm2 restart 0'
  "$ex" ask   'pm2 gracefulReload mai-push-api'
  "$ex" ask   'pm2 restart mai-push-api-test --update-env'
  "$ex" ask   'kill $(pgrep -f mai-push-api)'
  "$ex" allow 'grep -rn "killed" node_modules/x'
  "$ex" allow 'pm2 logs mai-push-api --lines 50'
  "$ex" allow 'pm2 list'
  "$ex" deny  'curl -X POST https://koinoyamai.love//api/notify'
  "$ex" deny  'curl -X POST http://127.0.0.1:8080/api//notify'
  "$ex" deny  'curl -X POST http://127.0.0.1:8080/api/../api/notify'
  "$ex" deny  'curl -X POST https://KoinoYamai.Love/api/notify'
  "$ex" deny  'curl -X POST https://koinoyamai.love:443/api/notify'
  "$ex" deny  "node -e \"fetch('http://127.0.0.1:8080/api/notify',{method:'POST'})\""
  "$ex" deny  'curl -d @body.json --url http://localhost:8080/api/notify'
  "$ex" ask   'sudo bash scripts/nginx/deploy.sh --apply'
  "$ex" allow 'bash scripts/nginx/deploy.sh'
  "$ex" ask   'bash scripts/deploy/npm-deploy.sh --apply'
  "$ex" ask   'sudo bash scripts/nginx/apply-maintenance.sh --on'
  "$ex" ask   'systemctl --user restart llama-embed.service'
  "$ex" ask   'sudo service nginx restart'
  "$ex" allow 'systemctl --user status pi-vector.service'
  "$ex" allow 'SKIP_PREPUSH_REGRESSION=1 git push -u origin agent/x'
}
project_cases expect_core
project_cases expect_claude

# 固有ルールの長いコマンド（旧 test-guard.sh の B3 ケースを Claude アダプタ経由で維持）
expect_claude deny "curl -X POST http://127.0.0.1:8080/api/notify -d @- <<EOF"$'\n'"$big"$'\n'"EOF"
expect_claude deny "git push origin main"$'\n'"$big"


# ---------- Codex アダプタ（ask は deny に倒れる） ----------
expect_codex() { # 核の期待値 コマンド
  local want="$1" cmd="$2" out rc got exp
  n=$((n + 1))
  out="$(claude_payload "$cmd" | bash "$ADAPTERS/codex.sh" 2>/dev/null)"; rc=$?
  if [ "$rc" -eq 2 ]; then got=deny
  elif [ "$rc" -eq 0 ] && [ -z "$out" ]; then got=allow
  else got="error(rc=$rc)"; fi
  exp="$want"; [ "$want" = "ask" ] && exp=deny
  [ "$got" != "$exp" ] && ng "codex: 期待 $want($exp) / 実際 $got : $cmd"
}
expect_codex deny  'git push --no-verify origin agent/x'
expect_codex deny  'git push origin main'
expect_codex deny  'git -c core.hooksPath=/dev/null push origin agent/x'
expect_codex ask   'git push --force origin agent/x'
expect_codex ask   'cat .env'
expect_codex ask   'gh pr merge 12 --squash'
expect_codex allow 'git push origin agent/x'
expect_codex allow 'npm test'
expect_codex deny  "$(printf 'git push \\\norigin main')"
n=$((n + 1))
if printf 'not json' | bash "$ADAPTERS/codex.sh" >/dev/null 2>&1; then
  ng "codex: 壊れた入力で止まらなかった"
fi

# ---------- Cursor アダプタ ----------
expect_cursor() { # 期待値 コマンド
  local want="$1" cmd="$2" out got
  n=$((n + 1))
  out="$(printf '{"hook_event_name":"beforeShellExecution","command":%s,"cwd":"/tmp"}' "$(json_str "$cmd")" \
    | bash "$ADAPTERS/cursor.sh" 2>/dev/null)"
  got="$(printf '%s' "$out" | grep -o '"permission":"[a-z]*"' | head -n1 | cut -d'"' -f4)"
  [ "$got" != "$want" ] && ng "cursor: 期待 $want / 実際 $got : $cmd"
}
expect_cursor deny  'git push --no-verify origin agent/x'
expect_cursor deny  'git push origin main'
expect_cursor deny  'SKIP_PREPUSH=1 git push origin agent/x'
expect_cursor ask   'git push --force origin agent/x'
expect_cursor ask   'git reset --hard origin/main'
expect_cursor ask   'cat .env'
expect_cursor allow 'git push origin agent/x'
expect_cursor allow 'npm test'
expect_cursor deny  "$(printf 'git push \\\norigin main')"
# 異常系: 壊れた入力では deny を返す
n=$((n + 1))
out="$(printf 'not json' | bash "$ADAPTERS/cursor.sh" 2>/dev/null)"
printf '%s' "$out" | grep -q '"permission":"deny"' || ng "cursor: 壊れた入力で deny にならない"

# ---------- Gemini CLI アダプタ（ask は deny に倒れる） ----------
expect_gemini() { # 核の期待値 コマンド
  local want="$1" cmd="$2" out got exp
  n=$((n + 1))
  out="$(printf '{"tool_name":"run_shell_command","tool_input":{"command":%s}}' "$(json_str "$cmd")" \
    | bash "$ADAPTERS/gemini.sh" 2>/dev/null)"
  got="$(printf '%s' "$out" | grep -o '"decision":"[a-z]*"' | head -n1 | cut -d'"' -f4)"
  exp="$want"; [ "$want" = "ask" ] && exp=deny
  [ "$got" != "$exp" ] && ng "gemini: 期待 $want($exp) / 実際 $got : $cmd"
}
expect_gemini deny  'git push --no-verify origin agent/x'
expect_gemini deny  'git push origin main'
expect_gemini ask   'git push --force origin agent/x'
expect_gemini ask   'cat .env'
expect_gemini allow 'git push origin agent/x'
expect_gemini allow 'npm test'
expect_gemini deny  "$(printf 'git push \\\norigin main')"
# シェル以外のツールは対象外（素通し）
n=$((n + 1))
out="$(printf '{"tool_name":"read_file","tool_input":{"file_path":"/tmp/x"}}' | bash "$ADAPTERS/gemini.sh" 2>/dev/null)"
printf '%s' "$out" | grep -q '"decision":"allow"' || ng "gemini: シェル以外のツールを止めてしまった"
# 異常系: 壊れた入力では deny を返す
n=$((n + 1))
out="$(printf 'not json' | bash "$ADAPTERS/gemini.sh" 2>/dev/null)"
printf '%s' "$out" | grep -q '"decision":"deny"' || ng "gemini: 壊れた入力で deny にならない"

# ---------- Antigravity CLI アダプタ（ask は force_ask になる） ----------
expect_antigravity() { # 期待値(decision の値) コマンド
  local want="$1" cmd="$2" out got
  n=$((n + 1))
  out="$(printf '{"toolCall":{"name":"run_command","args":{"CommandLine":%s,"Cwd":"/tmp"}},"stepIdx":0}' "$(json_str "$cmd")" \
    | bash "$ADAPTERS/antigravity.sh" 2>/dev/null)"
  got="$(printf '%s' "$out" | grep -o '"decision":"[a-z_]*"' | head -n1 | cut -d'"' -f4)"
  [ "$got" != "$want" ] && ng "antigravity: 期待 $want / 実際 $got : $cmd"
}
expect_antigravity deny      'git push --no-verify origin agent/x'
expect_antigravity deny      'git push origin main'
expect_antigravity deny      'git -c core.hooksPath=/dev/null push origin agent/x'
expect_antigravity force_ask 'git push --force origin agent/x'
expect_antigravity force_ask 'cat .env'
expect_antigravity force_ask 'gh pr merge 12 --squash'
expect_antigravity allow     'git push origin agent/x'
expect_antigravity allow     'npm test'
expect_antigravity deny      "$(printf 'git push \\\norigin main')"
# コマンド実行以外のツールは対象外（素通し）
n=$((n + 1))
out="$(printf '{"toolCall":{"name":"view_file","args":{"AbsolutePath":"/tmp/.env"}}}' | bash "$ADAPTERS/antigravity.sh" 2>/dev/null)"
printf '%s' "$out" | grep -q '"decision":"allow"' || ng "antigravity: コマンド実行以外のツールを止めてしまった"
# 異常系: 壊れた入力では deny を返す
n=$((n + 1))
out="$(printf 'not json' | bash "$ADAPTERS/antigravity.sh" 2>/dev/null)"
printf '%s' "$out" | grep -q '"decision":"deny"' || ng "antigravity: 壊れた入力で deny にならない"

# ---------- opencode アダプタ（プラグイン。判定テストは node で実行） ----------
if command -v node >/dev/null 2>&1; then
  if oc_out="$(node scripts/ci/test-guard-opencode.mjs 2>&1)"; then
    echo "  $oc_out"
    oc_n="$(printf '%s' "$oc_out" | sed -n 's/.*（\([0-9][0-9]*\) 件）.*/\1/p' | tail -n1)"
    n=$((n + ${oc_n:-0}))
  else
    printf '%s\n' "$oc_out"
    ng "opencode: 判定テストが失敗した"
    n=$((n + 1))
  fi
else
  echo "  （node が無いため opencode アダプタのテストをスキップ）"
fi

# ---------- 設定ファイルが指すアダプタの実在 ----------
for pair in ".claude/settings.json claude-code.sh" ".codex/hooks.json codex.sh" ".cursor/hooks.json cursor.sh" ".gemini/settings.json gemini.sh" ".agents/hooks.json antigravity.sh"; do
  set -- $pair
  n=$((n + 1))
  if grep -q "scripts/guard/adapters/$2" "$1" && [ -f "scripts/guard/adapters/$2" ]; then :; else
    ng "設定 $1 が scripts/guard/adapters/$2 を指していない / 実在しない"
  fi
done
# Cursor の command はプロジェクトルート相対で書く（.cursor/ 相対だとプロジェクトの外を指して起動しない）
n=$((n + 1))
grep -q '"command": "scripts/guard/adapters/cursor.sh"' .cursor/hooks.json \
  || ng "cursor: hooks.json の command がプロジェクトルート相対になっていない"
# opencode はプラグイン方式（設定ファイルではなく .opencode/plugins/ の実ファイルが核を呼ぶ）
n=$((n + 1))
if [ -f .opencode/plugins/agent-guard.js ] && grep -q 'guard-check.sh' .opencode/plugins/agent-guard.js; then :; else
  ng ".opencode/plugins/agent-guard.js が無い / 核（guard-check.sh）を呼んでいない"
fi

# ---------- アダプタ経由の長いコマンド（1 引数の上限に当たっても判定が崩れないこと） ----------
long_allow="echo $big"
n=$((n + 1))
out="$(claude_payload "$long_allow" | bash "$ADAPTERS/claude-code.sh" 2>/dev/null)"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } || ng "claude-code: 長い allow コマンドが通らない（rc=$rc）"
long_deny="git push origin main # $big"
n=$((n + 1))
err="$(claude_payload "$long_deny" | bash "$ADAPTERS/claude-code.sh" 2>&1 >/dev/null)"; rc=$?
{ [ "$rc" -eq 2 ] && [ -n "$err" ]; } || ng "claude-code: 長い deny コマンドが理由つきで止まらない（rc=$rc）"
n=$((n + 1))
out="$(printf '{"tool_name":"run_shell_command","tool_input":{"command":%s}}' "$(json_str "$long_deny")" \
  | bash "$ADAPTERS/gemini.sh" 2>/dev/null)"
printf '%s' "$out" | grep -q '"decision":"deny"' || ng "gemini: 長い deny コマンドが止まらない"
n=$((n + 1))
out="$(printf '{"tool_name":"run_shell_command","tool_input":{"command":%s}}' "$(json_str "$long_allow")" \
  | bash "$ADAPTERS/gemini.sh" 2>/dev/null)"
printf '%s' "$out" | grep -q '"decision":"allow"' || ng "gemini: 長い allow コマンドが通らない"

if [ "$fail" -ne 0 ]; then echo "[test-guard] 失敗" >&2; exit 1; fi
echo "[test-guard] OK（${n} 件）"
