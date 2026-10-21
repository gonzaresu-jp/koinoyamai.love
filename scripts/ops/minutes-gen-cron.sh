#!/usr/bin/env bash
# minutes-gen-cron.sh - 要約自動生成 (Cloudflare Workers AI 無料枠)
# - flock で多重起動防止 (毎日 cron が叩いても稼働中のプロセスがあればスキップ)
# - 無料枠 9500 neurons/日を使い切ったら翌日 UTC 00:15(=JST 09:15) まで自動待機し継続
# - cron は再始動 watchdog の役割: プロセスが落ちていれば翌朝に立ち上がり、既生成分はスキップして続行
# - ログは logs/minutes-gen-YYYYMMDD.log に日別追記
#
# node は明示指定する: cron の PATH は /usr/bin/node（Node v18 = EOL）を掴むため
#   （AGENTS.md §5 / ecosystem.config.js と同じ v24.22.0 に揃える）
NODE_BIN="/home/yuzuki/.nvm/versions/node/v24.22.0/bin/node"
LOCK=/tmp/minutes-gen.lock
cd /var/www/html/koinoyamai.love || exit 1
if [ ! -x "$NODE_BIN" ]; then
  echo "$(date '+%F %T') ERROR: node が見つかりません: $NODE_BIN" >> logs/minutes-gen-cron.log 2>/dev/null
  exit 1
fi
exec 9>"$LOCK"
flock -n 9 || { echo "$(date '+%F %T') skip: another minutes-gen running" >> logs/minutes-gen-cron.log 2>/dev/null; exit 0; }
LOG="logs/minutes-gen-$(date +%Y%m%d).log"
{
  echo "=== $(date '+%F %T %Z') minutes-gen start ==="
  "$NODE_BIN" scripts/ops/minutes-gen.js --recent 800 --embed
  RC=$?
  # 終了コードは $? ではなく退避した RC を使う（コマンド置換 $(date) を先に評価すると
  # $? が date の終了コード=0 になるため）。脚本全体の終了コードも RC を返す。
  echo "=== $(date '+%F %T %Z') minutes-gen end (rc=$RC) ==="
  exit $RC
} >> "$LOG" 2>&1