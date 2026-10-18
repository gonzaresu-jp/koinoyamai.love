#!/usr/bin/env bash
# minutes-gen-cron.sh - 要約自動生成 (Cloudflare Workers AI 無料枠)
# - flock で多重起動防止 (毎日 cron が叩いても稼働中のプロセスがあればスキップ)
# - 無料枠 9500 neurons/日を使い切ったら翌日 UTC 00:15(=JST 09:15) まで自動待機し継続
# - cron は再始動 watchdog の役割: プロセスが落ちていれば翌朝に立ち上がり、既生成分はスキップして続行
# - ログは logs/minutes-gen-YYYYMMDD.log に日別追記
LOCK=/tmp/minutes-gen.lock
cd /var/www/html/mai-push || exit 1
exec 9>"$LOCK"
flock -n 9 || { echo "$(date '+%F %T') skip: another minutes-gen running" >> logs/minutes-gen-cron.log 2>/dev/null; exit 0; }
LOG="logs/minutes-gen-$(date +%Y%m%d).log"
{
  echo "=== $(date '+%F %T %Z') minutes-gen start ==="
  node scripts/ops/minutes-gen.js --recent 800 --embed
  echo "=== $(date '+%F %T %Z') minutes-gen end (rc=$?) ==="
} >> "$LOG" 2>&1