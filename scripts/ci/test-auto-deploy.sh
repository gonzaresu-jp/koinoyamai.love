#!/usr/bin/env bash
# scripts/ops/auto-deploy.sh の判定テスト（AGENTS.md §7.3.6）
#   使い捨ての git リポジトリ（リモート・本番ツリー・staging ツリー）と、pm2 / gh / curl / sleep の代役で
#   各場面を再現する。本物の本番・pm2・GitHub・Discord には一切触れない。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY="$ROOT/scripts/ops/auto-deploy.sh"
W="$(mktemp -d "${TMPDIR:-/tmp}/auto-deploy-test.XXXXXX")"
trap 'rm -rf "$W"' EXIT

# ---- 代役（PATH の先頭に置く）----
mkdir -p "$W/bin"
cat > "$W/bin/pm2" <<'EOF'
#!/usr/bin/env bash
echo "pm2 $*" >> "$TEST_LOG"
EOF
cat > "$W/bin/gh" <<'EOF'
#!/usr/bin/env bash
[ "$CI_STATE" = "error" ] && exit 1
echo "$CI_STATE"
EOF
cat > "$W/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
# curl: smoke test には環境変数で決めた HTTP コードを返し、Discord 通知は記録する。
# 秘密値（Bot トークン）が引数に出ていないかも確かめる。
cat > "$W/bin/curl" <<'EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in *"$DISCORD_BOT_TOKEN"*) echo "TOKEN_IN_ARGV" >> "$TEST_LOG" ;; esac
case "$args" in
  *discord.com*)
    cat >/dev/null   # -K - の標準入力（トークン）は読み捨てる
    title="$(printf '%s' "$args" | sed -n 's/.*"title":"\([^"]*\)".*/\1/p')"
    echo "ALERT $title" >> "$TEST_LOG"; exit 0 ;;
  *3002/api/health/live*) printf '%s' "${WORKER_CODE:-200}"; exit 0 ;;
  *8080/api/notify*|*8081/api/notify*) printf '401'; exit 0 ;;
  *8080*) printf '%s' "${PROD_CODE:-200}"; exit 0 ;;
  *8081*) printf '%s' "${STG_CODE:-200}"; exit 0 ;;
esac
printf '000'
EOF
if ! command -v flock >/dev/null 2>&1; then
  printf '#!/usr/bin/env bash\nexit 0\n' > "$W/bin/flock"
fi
chmod +x "$W/bin/"*
export PATH="$W/bin:$PATH"
export DISCORD_BOT_TOKEN="dummy-bot-token-for-test" DISCORD_CHANNEL_ID="123"
export NODE_BIN="$(type -P true)"   # node_modules の乖離検査を常に「乖離なし」にする（command -v は組み込みを返す）
export TEST_LOG="$W/log"

g() { git -c user.email=t@t -c user.name=t -c core.autocrlf=false "$@"; }

setup() { # 新しいリモート・本番・staging を作る（main に A、本番は A、staging は別ブランチ）
  rm -rf "$W/remote.git" "$W/prod" "$W/stg" "$W/dev" "$W/state" "$W/lock" "$TEST_LOG"
  : > "$TEST_LOG"
  g init -q --bare -b main "$W/remote.git"
  g clone -q "$W/remote.git" "$W/dev" 2>/dev/null
  echo A > "$W/dev/app.txt"; g -C "$W/dev" add -A; g -C "$W/dev" commit -q -m A; g -C "$W/dev" push -q origin HEAD:main
  g clone -q "$W/remote.git" "$W/prod"
  g clone -q "$W/remote.git" "$W/stg"; g -C "$W/stg" checkout -q -b docs/other
  A="$(g -C "$W/prod" rev-parse HEAD)"
  printf '{"lastDeployedCommit":"%s"}\n' "$A" > "$W/state"
  echo B > "$W/dev/app.txt"; g -C "$W/dev" commit -q -am B; g -C "$W/dev" push -q origin HEAD:main
  B="$(g -C "$W/dev" rev-parse HEAD)"
}
run() {
  AUTO_DEPLOY_PROD_DIR="$W/prod" AUTO_DEPLOY_STG_DIR="$W/stg" \
  AUTO_DEPLOY_STATE_FILE="$W/state" AUTO_DEPLOY_LOCK_FILE="$W/lock" \
    bash "$DEPLOY" >> "$W/out" 2>&1
}
state() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))" < "$W/state" | tr -d '\r'; }
prod_head() { g -C "$W/prod" rev-parse HEAD; }

fail=0; n=0
check() { # 説明 条件（評価結果）
  n=$((n + 1))
  if [ "$2" != "0" ]; then echo "  NG: $1"; fail=1; fi
}
t() { "$@" >/dev/null 2>&1; echo $?; }

# 1. CI 実行中 → 何もしない（次の回へ）。状態も変えない
setup; CI_STATE=pending run
check "CI 実行中なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "CI 実行中なら通知しない" "$(t bash -c "! grep -q ALERT '$TEST_LOG'")"
check "CI 実行中なら pm2 を触らない" "$(t bash -c "! grep -q pm2 '$TEST_LOG'")"

# 2. CI 失敗 → 配置しない・1 回だけ通知・同じコミットで再試行しない
setup; CI_STATE=failure run; CI_STATE=failure run
check "CI 失敗なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "CI 失敗は failedCommit に記録" "$(t test "$(state failedCommit)" = "$B")"
check "CI 失敗の通知は 1 回だけ" "$(t test "$(grep -c ALERT "$TEST_LOG")" = "1")"

# 3. gh が使えない → 止める（fail-closed）
setup; CI_STATE=error run
check "CI 不明なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "CI 不明は ci-unknown" "$(t test "$(state status)" = "ci-unknown")"

# 4. 正常系 → 本番は B に ff、staging は staging ブランチ、API とワーカーを再起動
setup; CI_STATE=success run
check "成功なら本番は B" "$(t test "$(prod_head)" = "$B")"
check "成功なら lastDeployedCommit=B" "$(t test "$(state lastDeployedCommit)" = "$B")"
check "staging は staging ブランチ" "$(t test "$(g -C "$W/stg" branch --show-current)" = "staging")"
check "staging にいたブランチ（docs/other）は書き換えない" "$(t test "$(g -C "$W/stg" rev-parse docs/other)" = "$A")"
check "本番 API を再起動" "$(t grep -q 'pm2 restart mai-push-api --update-env' "$TEST_LOG")"
check "本番ワーカーを再起動" "$(t grep -q 'pm2 restart mai-push-worker --update-env' "$TEST_LOG")"
check "Bot トークンがコマンド引数に出ない" "$(t bash -c "! grep -q TOKEN_IN_ARGV '$TEST_LOG'")"
CI_STATE=success run
check "成功後の再実行では何もしない" "$(t test "$(grep -c 'pm2 restart mai-push-api --update-env' "$TEST_LOG")" = "1")"

# 5. 本番ツリーに未コミットの変更 → 止めて変更を消さない
setup; echo local-edit >> "$W/prod/app.txt"; CI_STATE=success run
check "未コミットの変更があれば本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "未コミットの変更を消さない" "$(t grep -q local-edit "$W/prod/app.txt")"
check "prod-dirty を記録" "$(t test "$(state status)" = "prod-dirty")"

# 6. 本番ツリーに未 push のコミット（cron の push 失敗）→ 止めてコミットを消さない
setup; echo data > "$W/prod/data.txt"; g -C "$W/prod" add data.txt; g -C "$W/prod" commit -q -m data
LOCAL="$(prod_head)"; CI_STATE=success run
check "未 push のコミットがあれば本番はそのまま" "$(t test "$(prod_head)" = "$LOCAL")"
check "prod-diverged を記録" "$(t test "$(state status)" = "prod-diverged")"

# 7. staging ツリーに未コミットの変更 → 止める（本番も触らない）
setup; echo stg-edit >> "$W/stg/app.txt"; CI_STATE=success run
check "staging が dirty なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "staging の変更を消さない" "$(t grep -q stg-edit "$W/stg/app.txt")"

# 8. staging の smoke 失敗 → 本番に触らない・再試行しない
setup; CI_STATE=success STG_CODE=500 run; CI_STATE=success STG_CODE=500 run
check "staging 失敗なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "staging 失敗の通知は 1 回だけ" "$(t test "$(grep -c ALERT "$TEST_LOG")" = "1")"

# 9. 本番の smoke 失敗 → A に戻して再起動・再試行しない
setup; CI_STATE=success PROD_CODE=500 run
check "本番失敗なら A に戻す" "$(t test "$(prod_head)" = "$A")"
check "rolled-back を記録" "$(t test "$(state status)" = "rolled-back")"
check "ロールバック後もワーカーを再起動" "$(t test "$(grep -c 'pm2 restart mai-push-worker' "$TEST_LOG")" = "2")"
before="$(grep -c pm2 "$TEST_LOG")"; CI_STATE=success PROD_CODE=500 run
check "ロールバックしたコミットは再試行しない" "$(t test "$(grep -c pm2 "$TEST_LOG")" = "$before")"
# 新しいコミットが来たら再開する
echo C > "$W/dev/app.txt"; g -C "$W/dev" commit -q -am C; g -C "$W/dev" push -q origin HEAD:main
C="$(g -C "$W/dev" rev-parse HEAD)"; CI_STATE=success run
check "新しいコミットで再開し本番は C" "$(t test "$(prod_head)" = "$C")"

if [ "$fail" -ne 0 ]; then
  echo "[test-auto-deploy] 失敗（出力の末尾）:" >&2; tail -20 "$W/out" >&2
  exit 1
fi
echo "[test-auto-deploy] OK（${n} 件）"
