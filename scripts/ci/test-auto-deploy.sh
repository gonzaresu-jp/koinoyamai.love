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
# pm2 の代役: 呼び出しを記録。jlist には discord-bot の状態を返す
# （本番の app.txt が BOT_BAD と同じなら errored ＝ 悪いコミットで Bot が落ちる）
cat > "$W/bin/pm2" <<'EOF'
#!/usr/bin/env bash
echo "pm2 $*" >> "$TEST_LOG"
if [ "${1:-}" = "jlist" ]; then
  st=online
  if [ -n "${BOT_BAD:-}" ] && [ "$(tr -d '\r\n' < "$AUTO_DEPLOY_PROD_DIR/app.txt" 2>/dev/null)" = "$BOT_BAD" ]; then st=errored; fi
  printf '[{"name":"mai-push-api","pm2_env":{"status":"online"}},{"name":"discord-bot","pm2_env":{"status":"%s"}}]\n' "$st"
fi
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
# curl の代役:
#   - Discord 通知: 標準入力の本文が正しい JSON かを確かめて記録（壊れていれば BAD_JSON）
#   - smoke test: 本番に配置された app.txt の中身が PROD_BAD / WORKER_BAD と同じなら失敗を返す
#     （「悪いコミット」を表す。ロールバックで中身が戻れば成功に戻る）。PROD_CODE は常に返すコード
#   - CONCURRENT=1: 本番の smoke 中に、同じツリーへ cron のコミットを模して 1 件コミットする
#   - Bot トークンが引数に出ていないかも確かめる
cat > "$W/bin/curl" <<'EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in *"$DISCORD_BOT_TOKEN"*) echo "TOKEN_IN_ARGV" >> "$TEST_LOG" ;; esac
content() { tr -d '\r\n' < "$AUTO_DEPLOY_PROD_DIR/app.txt" 2>/dev/null; }
case "$args" in
  *discord.com*)
    if title="$(python3 -c 'import sys,json; print(json.loads(sys.stdin.buffer.read().decode("utf-8"))["embeds"][0]["title"])' 2>/dev/null)"; then
      echo "ALERT $(printf '%s' "$title" | tr -d '\r')" >> "$TEST_LOG"
    else
      echo "BAD_JSON" >> "$TEST_LOG"
    fi
    exit 0 ;;
  *3002/api/health/live*)
    if [ -n "${WORKER_BAD:-}" ] && [ "$(content)" = "$WORKER_BAD" ]; then printf '500'; else printf '200'; fi
    exit 0 ;;
  *8080/api/notify*|*8081/api/notify*) printf '401'; exit 0 ;;
  *8080*)
    if [ -n "${PROD_CODE:-}" ]; then printf '%s' "$PROD_CODE"; exit 0; fi
    if [ -n "${PROD_BAD:-}" ] && [ "$(content)" = "$PROD_BAD" ]; then
      if [ "${CONCURRENT:-}" = "1" ] && [ ! -e "$TEST_LOG.concurrent" ]; then
        touch "$TEST_LOG.concurrent"
        ( cd "$AUTO_DEPLOY_PROD_DIR" && echo data > cron-data.txt && git add cron-data.txt \
          && git -c user.email=t@t -c user.name=t commit -q -m cron-data ) >/dev/null 2>&1
      fi
      printf '500'; exit 0
    fi
    printf '200'; exit 0 ;;
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
export PYTHONIOENCODING=utf-8

g() { git -c user.email=t@t -c user.name=t -c core.autocrlf=false "$@"; }

setup() { # 新しいリモート・本番・staging を作る（main に A、本番は A、staging は別ブランチ、main に B を追加）
  rm -rf "$W/remote.git" "$W/prod" "$W/stg" "$W/dev" "$W/state" "$W/lock" "$TEST_LOG" "$TEST_LOG.concurrent" "$W/out"
  : > "$TEST_LOG"
  g init -q --bare -b main "$W/remote.git"
  g clone -q "$W/remote.git" "$W/dev" 2>/dev/null
  echo A > "$W/dev/app.txt"; g -C "$W/dev" add -A; g -C "$W/dev" commit -q -m A; g -C "$W/dev" push -q origin HEAD:main
  g clone -q "$W/remote.git" "$W/prod"
  g clone -q "$W/remote.git" "$W/stg"; g -C "$W/stg" checkout -q -b docs/other
  A="$(g -C "$W/prod" rev-parse HEAD)"
  printf '{"lastDeployedCommit":"%s"}\n' "$A" > "$W/state"
  # 通知の JSON が壊れないか試すため、改行と " を含むコミットメッセージを 2 件にする
  echo B0 > "$W/dev/note.txt"; g -C "$W/dev" add note.txt; g -C "$W/dev" commit -q -m 'fix "quoted" title'
  echo B > "$W/dev/app.txt"; g -C "$W/dev" commit -q -am "B"$'\n\n'"body line"; g -C "$W/dev" push -q origin HEAD:main
  B="$(g -C "$W/dev" rev-parse HEAD)"
}
add_commit() { # 内容 → main に新しいコミット
  echo "$1" > "$W/dev/app.txt"; g -C "$W/dev" commit -q -am "$1"; g -C "$W/dev" push -q origin HEAD:main
  g -C "$W/dev" rev-parse HEAD
}
run() {
  AUTO_DEPLOY_PROD_DIR="$W/prod" AUTO_DEPLOY_STG_DIR="$W/stg" \
  AUTO_DEPLOY_STATE_FILE="$W/state" AUTO_DEPLOY_LOCK_FILE="$W/lock" AUTO_DEPLOY_REPO="test/repo" \
    bash "$DEPLOY" >> "$W/out" 2>&1
}
state() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))" < "$W/state" | tr -d '\r'; }
prod_head() { g -C "$W/prod" rev-parse HEAD; }
alerts() { grep -c '^ALERT' "$TEST_LOG"; }

fail=0; n=0
check() { # 説明 条件（評価結果）
  n=$((n + 1))
  if [ "$2" != "0" ]; then echo "  NG: $1"; fail=1; fi
}
t() { "$@" >/dev/null 2>&1; echo $?; }
no_bad_json() { check "通知の JSON が正しい（$1）" "$(t bash -c "! grep -q -e BAD_JSON -e TOKEN_IN_ARGV '$TEST_LOG'")"; }

# 1. CI 実行中 → 何もしない（次の回へ）。状態も変えない
setup; CI_STATE=pending run
check "CI 実行中なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "CI 実行中なら通知しない" "$(t test "$(alerts)" = "0")"
check "CI 実行中なら pm2 を触らない" "$(t bash -c "! grep -q pm2 '$TEST_LOG'")"

# 2. CI 失敗 → 配置しない・1 回だけ通知・同じコミットで再試行しない
setup; CI_STATE=failure run; CI_STATE=failure run
check "CI 失敗なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "CI 失敗は failedCommit に記録" "$(t test "$(state failedCommit)" = "$B")"
check "CI 失敗の通知は 1 回だけ" "$(t test "$(alerts)" = "1")"
no_bad_json "CI 失敗"

# 3. gh が使えない → 保留（止める）。通知は 1 回、解消すれば同じコミットを再試行する
setup; CI_STATE=error run; CI_STATE=error run
check "CI 不明なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "CI 不明は ci-unknown" "$(t test "$(state status)" = "ci-unknown")"
check "CI 不明は failedCommit にしない" "$(t test -z "$(state failedCommit)")"
check "CI 不明の通知は 1 回だけ" "$(t test "$(alerts)" = "1")"
CI_STATE=success run
check "CI が取れるようになれば同じコミットを配置" "$(t test "$(prod_head)" = "$B")"

# 4. 正常系 → 本番は B に ff、staging は staging ブランチ、API とワーカーを再起動
setup; CI_STATE=success run
check "成功なら本番は B" "$(t test "$(prod_head)" = "$B")"
check "成功なら lastDeployedCommit=B" "$(t test "$(state lastDeployedCommit)" = "$B")"
check "staging は staging ブランチ" "$(t test "$(g -C "$W/stg" branch --show-current)" = "staging")"
check "staging にいたブランチ（docs/other）は書き換えない" "$(t test "$(g -C "$W/stg" rev-parse docs/other)" = "$A")"
check "本番 API を再起動" "$(t grep -q 'pm2 restart mai-push-api --update-env' "$TEST_LOG")"
check "本番ワーカーを再起動" "$(t grep -q 'pm2 restart mai-push-worker --update-env' "$TEST_LOG")"
check "本番 discord-bot を再起動" "$(t grep -q 'pm2 restart discord-bot --update-env' "$TEST_LOG")"
no_bad_json "成功（新コミット 2 件・改行と \" を含む）"
CI_STATE=success run
check "成功後の再実行では何もしない" "$(t test "$(grep -c 'pm2 restart mai-push-api --update-env' "$TEST_LOG")" = "1")"

# 5. 本番ツリーに未コミットの変更 → 保留して変更を消さない。片付けば再試行
setup; echo local-edit >> "$W/prod/app.txt"; CI_STATE=success run
check "未コミットの変更があれば本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "未コミットの変更を消さない" "$(t grep -q local-edit "$W/prod/app.txt")"
check "prod-dirty を記録" "$(t test "$(state status)" = "prod-dirty")"
g -C "$W/prod" checkout -q -- app.txt; CI_STATE=success run
check "変更が片付けば同じコミットを配置" "$(t test "$(prod_head)" = "$B")"

# 6. 本番ツリーに未 push のコミット（cron の push 失敗）→ 保留してコミットを消さない
setup; echo data > "$W/prod/data.txt"; g -C "$W/prod" add data.txt; g -C "$W/prod" commit -q -m data
LOCAL="$(prod_head)"; CI_STATE=success run
check "未 push のコミットがあれば本番はそのまま" "$(t test "$(prod_head)" = "$LOCAL")"
check "prod-diverged を記録" "$(t test "$(state status)" = "prod-diverged")"

# 7. staging ツリーに未コミットの変更 → 保留（本番も触らない）
setup; echo stg-edit >> "$W/stg/app.txt"; CI_STATE=success run
check "staging が dirty なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "staging の変更を消さない" "$(t grep -q stg-edit "$W/stg/app.txt")"

# 8. staging の smoke 失敗 → 本番に触らない・再試行しない
setup; CI_STATE=success STG_CODE=500 run; CI_STATE=success STG_CODE=500 run
check "staging 失敗なら本番は A のまま" "$(t test "$(prod_head)" = "$A")"
check "staging 失敗の通知は 1 回だけ" "$(t test "$(alerts)" = "1")"

# 9. 本番の smoke 失敗（悪いコミット）→ A に戻して再起動・戻した後は PASS・再試行しない
setup; CI_STATE=success PROD_BAD=B run
check "本番失敗なら A に戻す" "$(t test "$(prod_head)" = "$A")"
check "rolled-back を記録" "$(t test "$(state status)" = "rolled-back")"
check "ロールバック後もワーカーを再起動" "$(t test "$(grep -c 'pm2 restart mai-push-worker' "$TEST_LOG")" = "2")"
before="$(grep -c pm2 "$TEST_LOG")"; CI_STATE=success PROD_BAD=B run
check "ロールバックしたコミットは再試行しない" "$(t test "$(grep -c pm2 "$TEST_LOG")" = "$before")"
C="$(add_commit C)"; CI_STATE=success PROD_BAD=B run
check "新しいコミットで再開し本番は C" "$(t test "$(prod_head)" = "$C")"

# 10. ワーカーだけ異常（API は正常）→ ロールバック（ワーカーの確認が効いていること）
setup; CI_STATE=success WORKER_BAD=B run
check "ワーカー異常なら A に戻す" "$(t test "$(prod_head)" = "$A")"
check "ワーカー異常も rolled-back" "$(t test "$(state status)" = "rolled-back")"

# 10b. discord-bot だけ異常（落ちる）→ ロールバック。成功時は discord-bot も再起動している
setup; CI_STATE=success BOT_BAD=B run
check "discord-bot 異常なら A に戻す" "$(t test "$(prod_head)" = "$A")"
check "discord-bot 異常も rolled-back" "$(t test "$(state status)" = "rolled-back")"
check "discord-bot を再起動（配置時とロールバック時）" "$(t test "$(grep -c 'pm2 restart discord-bot --update-env' "$TEST_LOG")" = "2")"

# 11. 戻しても直らない → rolled-back-unhealthy
setup; CI_STATE=success PROD_CODE=500 run
check "戻しても異常なら rolled-back-unhealthy" "$(t test "$(state status)" = "rolled-back-unhealthy")"

# 12. smoke の最中に cron が同じツリーへコミット → 自動ロールバックせず、コミットを消さない
setup; CI_STATE=success PROD_BAD=B CONCURRENT=1 run
check "同時コミットがあればロールバックしない" "$(t test "$(state status)" = "rollback-skipped")"
check "同時コミットを消さない" "$(t g -C "$W/prod" log -1 --format=%s HEAD)"
check "同時コミットが HEAD に残る" "$(t test "$(g -C "$W/prod" log -1 --format=%s HEAD)" = "cron-data")"
no_bad_json "ロールバック系"

if [ "$fail" -ne 0 ]; then
  echo "[test-auto-deploy] 失敗（出力の末尾）:" >&2; tail -20 "$W/out" >&2
  exit 1
fi
echo "[test-auto-deploy] OK（${n} 件）"
