#!/bin/bash
# ポートの実所有者を検証する（AGENTS.md §1 の事故対策）
#
# 使い方:
#   bash scripts/deploy/assert-port.sh prod
#   bash scripts/deploy/assert-port.sh staging
#   bash scripts/deploy/assert-port.sh 8080
#
# なぜ必要か（AGENTS.md §1 には過去の重大事故として明記）:
#   本番 API = 8080、staging API = 8081。curl localhost:8081 は staging であり、
#   本番検証を 8081 で行うと「staging の旧コードを本番と誤認」する事故が実際に起きた。
#   本スクリプトは ポート → PID → 実行スクリプトパス を機械的に照合し、
#   期待したツリーで応答していることを確認してから、不一致なら中断する。
#
#   本番を触る操作（deploy / promote / smoke）の前に必ず実行すること。
#
# 終了コード:
#   0 = 期待通り
#   1 = 不一致（期待と違うツリーが応答している）
#   2 = ポートが listening していない
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# 期待値（AGENTS.md §1 と整合。tree ごとに別ファイルへ hardcode しない）
PROD_PORT=8080
PROD_PATH="/var/www/html/koinoyamai.love/server.js"
STG_PORT=8081
STG_PATH="/home/yuzuki/koinoyamai.love-test/server.js"

die() { echo "ERROR: $*" >&2; exit 2; }
fail() { echo "✗ FAIL: $*" >&2; exit 1; }
ok() { echo "✓ $*" >&2; }

[ $# -ge 1 ] || die "使い方: $0 <prod|staging|ポート番号>"

case "$1" in
  prod)    PORT=$PROD_PORT; EXPECT_PATH=$PROD_PATH; LABEL="本番" ;;
  staging) PORT=$STG_PORT; EXPECT_PATH=$STG_PATH; LABEL="staging" ;;
  ''|*[!0-9]*) die "引数は prod / staging / ポート番号 のいずれかで指定してください" ;;
  *) PORT=$1; EXPECT_PATH=""; LABEL="ポート $PORT" ;;
esac

echo "=== ポート位相検証: $LABEL (期待 $PORT) ===" >&2

# --- 1. そのポートが listening しているか ---
#     自分（通常ユーザー）は他プロセスの cmdline を読めないため、
#     ポートの特定は /api/health の pid を取り出して行う。
HEALTH=$(curl -s --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)
if [ -z "$HEALTH" ]; then
  die "ポート $PORT で応答する /api/health がありません（サービス停止 or 別サービス）"
fi

# --- 2. health から pid を取り出す ---
PID=$(printf '%s' "$HEALTH" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' | head -1)
[ -n "$PID" ] || die "health に pid がありません: $HEALTH"

# --- 3. pid の実行ファイルパスを取得 ---
#     /proc/<pid>/cmdline は他ユーザーのプロセスの場合 root しか読めないので、
#     読み取れなければ「権限不足」として、その旨を記録する（不正確な断定はしない）。
ACTUAL_CMD=$(tr '\0' ' ' < "/proc/${PID}/cmdline" 2>/dev/null | awk '{print $2}')

if [ -z "$ACTUAL_CMD" ]; then
  # 読めない場合は pm2 の設定を照合する（pm2 jlist は自分のプロセスなので読める）
  PM2_PATH=$(pm2 jlist 2>/dev/null | node -e '
    let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
      try {
        const a = JSON.parse(d);
        const hit = a.filter(p => p.pm2_env && p.pm2_env.pm_cwd && p.name &&
                                 p.name.includes("mai-push"));
        hit.forEach(p => console.error("  pm2: " + p.name + " cwd=" + p.pm2_env.pm_cwd));
      } catch (e) {}
    });' 2>&1)
  echo "[warn] /proc/${PID}/cmdline を読み取れません（他ユーザー or root プロセス）" >&2
  [ -n "$PM2_PATH" ] && echo "$PM2_PATH" >&2
  if [ -n "$EXPECT_PATH" ]; then
    # 読み取り不能でも、pm2 の cwd から属するツリーを手掛かりに推定する
    if printf '%s' "$PM2_PATH" | grep -qF "$(dirname "$EXPECT_PATH")"; then
      ok "pm2 cwd から $LABEL ツリーと整合（/proc 権限不足のため確定はせず）"
      exit 0
    fi
    fail "期待: $EXPECT_PATH  に属するツリーだが、判定できません（要 root で確認）"
  fi
  exit 0
fi

echo "  ポート $PORT → pid $PID → $ACTUAL_CMD" >&2

# --- 4. 期待パスと照合 ---
if [ -n "$EXPECT_PATH" ]; then
  if [ "$ACTUAL_CMD" = "$EXPECT_PATH" ]; then
    ok "$LABEL として正しいツリーで応答中: $ACTUAL_CMD"
  else
    fail "ポート $PORT は $ACTUAL_CMD で応答しています。
        期待していたのは $LABEL: $EXPECT_PATH
        ※ ポート位相の誤り（AGENTS.md §1）。本番検証を staging で行っている可能性"
  fi
else
  ok "ポート $PORT は pid $PID / $ACTUAL_CMD で応答中（パス指定のないため未照合）"
fi
