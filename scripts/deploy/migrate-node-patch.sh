#!/usr/bin/env bash
# migrate-node-patch.sh — pm2 アプリを Node のパッチ版へ移行する
#
# 用途:
#   Node のパッチ版（例: v24.22.0 → v24.22.1）へ全 pm2 アプリを移行する。
#   セキュリティリリース（LTS の security release）が出たときに使う。
#
# 使い方:
#   bash scripts/deploy/migrate-node-patch.sh --from v24.22.0 --to v24.22.1            # dry-run
#   bash scripts/deploy/migrate-node-patch.sh --from v24.22.0 --to v24.22.1 --apply
#
# 前提（これを満たさないと「新版に写了一瞬で旧版に戻る」事故になる）:
#   1. `nvm install <to>` で新しい Node を入手済みであること
#   2. **当リポジトリの interpreter は --to に更新済みであること**
#      （ecosystem.config.js / .nvmrc / scripts の NODE_BIN / systemd unit）
#   3. pm2 デーモンも新しい Node で起動すること（systemd pm2-yuzuki.service の PATH）
#      ※ cluster モードでは interpreter が無視されデーモンの Node で動くため、
#        環境変数 exec_mode: 'fork' が必須（AGENTS.md §5）
#
# 手順（1本ずつ・失敗したらそのアプリだけ旧版へ戻す）:
#   1. pm2 delete <name>
#   2. 起動（本リポジトリの4本は ecosystem.config.js --only、他5本は直接 start）
#   3. 検証: /proc/<pid>/exe が新しい Node を指すこと + ポートが応答すること
#   4. 全件通ったら `pm2 save`（reboot 後の pm2 resurrect 用。忘れると旧版で復活する）
#
# 安全性:
#   - 冪等: 既に新しい Node で動いているアプリはスキップする
#   - 1本でも失敗したら、そのアプリだけ旧 interpreter に戻す（他は新版のまま）
#   - 定義のバックアップを /var/lib/mai-push/backups/ に残す
set -euo pipefail

FROM="v24.22.0"
TO="v24.22.1"
APPLY=0

# 引数解析（--from X / --to X / --apply）
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --to)   TO="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "error: 不明な引数: $1" >&2; exit 1 ;;
  esac
done
[ -n "$FROM" ] && [ -n "$TO" ] || { echo "error: --from / --to には値を指定してください" >&2; exit 1; }

NODE_BASE="$HOME/.nvm/versions/node"
OLD_NODE="${NODE_BASE}/${FROM}/bin/node"
NEW_NODE="${NODE_BASE}/${TO}/bin/node"
NEW_NPM="${NODE_BASE}/${TO}/bin/npm"
BACKUP_DIR="/var/lib/mai-push/backups"

PROD_DIR="/var/www/html/koinoyamai.love"
STG_DIR="/home/yuzuki/koinoyamai.love-test"

echo "=== Node パッチ版移行: ${FROM} → ${TO} ==="
echo "  旧: $OLD_NODE"
echo "  新: $NEW_NODE"
[ -x "$NEW_NODE" ] || { echo "error: $NEW_NODE が見つかりません（nvm install ${TO} を先に実行）" >&2; exit 1; }

# --- 対象アプリ ---
# 形式: name | 種別 | script | cwd | port
#   種別 eco: ecosystem.config.js から起動（--only）
#           plain: 直接 start（--interpreter を明示）
#           npm:   npm run serve を起動（interpreter は npm 本体）
APPS=(
  "mai-push-api|eco|./server.js|${PROD_DIR}|8080"
  "mai-push-worker|eco|./main.js|${PROD_DIR}|3002"
  "discord-bot|eco|./discord-bot.js|${PROD_DIR}|"
  "mai-push-api-test|eco|./server.js|${STG_DIR}|8081"
  "fcpass|plain|/var/www/private/fcpass/server.js|/var/www/private/fcpass|7080"
  "air-monitor|plain|/var/www/html/temp/monitor.js|/var/www/html/temp|3131"
  "hitori-twitter|plain|/opt/hitori-twitter/server.js|/opt/hitori-twitter|3333"
  "squiish|npm|${NEW_NPM}|/var/www/html/app/squiish|5000"
  "upload-file|plain|/var/www/html/upload/server.js|/var/www/html/upload|3100"
)

app_pid() { pm2 pid "$1" 2>/dev/null | tail -1 || true; }
app_exe() { local p; p="$(app_pid "$1")"; [ -n "$p" ] && readlink -f "/proc/${p}/exe" 2>/dev/null || echo ""; }

wait_port() {
  local port="$1" limit="${2:-25}" i code
  [ -n "$port" ] || return 0
  for i in $(seq 1 "$limit"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:${port}/" 2>/dev/null || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then echo "$code"; return 0; fi
    sleep 1
  done
  return 1
}

start_app() {
  # start_app <name> <種別> <script> <cwd> [args...]
  local name="$1" kind="$2" script="$3" cwd="$4"; shift 4
  case "$kind" in
    eco)
      # ecosystem.config.js の interpreter（新版に更新済み）を使う
      ( cd "$cwd" && pm2 start ecosystem.config.js --only "$name" >/dev/null 2>&1 )
      ;;
    npm)
      ( cd "$cwd" && DEV_PORT=5000 pm2 start "$script" --name "$name" --cwd "$cwd" \
          --interpreter "$NEW_NODE" --max-memory-restart 512M -- "$@" >/dev/null 2>&1 )
      ;;
    plain)
      ( cd "$cwd" && pm2 start "$script" --name "$name" --cwd "$cwd" \
          --interpreter "$NEW_NODE" --max-memory-restart 512M "$@" >/dev/null 2>&1 )
      ;;
  esac
}

start_app_old() {
  # 失敗時に旧 interpreter に戻す
  local name="$1" kind="$2" script="$3" cwd="$4"; shift 4
  case "$kind" in
    eco)
      ( cd "$cwd" && pm2 start ecosystem.config.js --only "$name" >/dev/null 2>&1 )
      ;;
    npm)
      ( cd "$cwd" && DEV_PORT=5000 pm2 start "$script" --name "$name" --cwd "$cwd" \
          --interpreter "$OLD_NODE" --max-memory-restart 512M -- "$@" >/dev/null 2>&1 )
      ;;
    plain)
      ( cd "$cwd" && pm2 start "$script" --name "$name" --cwd "$cwd" \
          --interpreter "$OLD_NODE" --max-memory-restart 512M "$@" >/dev/null 2>&1 )
      ;;
  esac
}

if [ "$APPLY" = "0" ]; then
  echo "--- dry-run ---"
  for spec in "${APPS[@]}"; do
    IFS='|' read -r name kind script cwd port <<< "$spec"
    cur="$(app_exe "$name")"
    if [ "$cur" = "$NEW_NODE" ]; then
      printf "  %-16s :%-6s すでに新版（%s）→ スキップ\n" "$name" "$port" "$TO"
    else
      printf "  %-16s :%-6s 現=%s → 移行後=%s\n" "$name" "$port" "${cur:-未稼働}" "$NEW_NODE"
    fi
  done
  echo
  echo "--- 適用後の検証手順 ---"
  echo "  pm2 ls"
  echo "  bash scripts/deploy/migrate-node-patch.sh --from ${FROM} --to ${TO}   # 再度実行して確認"
  echo "  for p in 8080 3002 8081 7080 3131 3333 5000 3100; do curl -s -o /dev/null -w \"\\\$p %{http_code}\\n\" http://127.0.0.1:\\\$p/; done"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
BK="$BACKUP_DIR/pm2-jlist-before-${TO}-$(date +%Y%m%d-%H%M%S).json"
pm2 jlist > "$BK" 2>/dev/null && echo "[OK] 定義バックアップ: $BK"

FAIL=0
for spec in "${APPS[@]}"; do
  IFS='|' read -r name kind script cwd port <<< "$spec"
  cur="$(app_exe "$name")"
  if [ "$cur" = "$NEW_NODE" ]; then
    echo "--- $name: すでに新版のためスキップ"
    continue
  fi
  echo "--- $name (:${port})  移行前=${cur:-未稼働}"
  if [ -z "$cur" ]; then
    echo "    稼働していないためスキップ（必要なら手動で起動してください）"
    continue
  fi

  pm2 delete "$name" >/dev/null 2>&1 || true
  if [ "$kind" = "npm" ]; then
    start_app "$name" "$kind" "$script" "$cwd" run serve
  else
    start_app "$name" "$kind" "$script" "$cwd"
  fi
  sleep 2

  new_exe="$(app_exe "$name")"
  if [ "$new_exe" != "$NEW_NODE" ]; then
    echo "    [NG] 実バイナリが想定外: ${new_exe:-無} → 旧版に戻す" >&2
    pm2 delete "$name" >/dev/null 2>&1 || true
    if [ "$kind" = "npm" ]; then
      start_app_old "$name" "$kind" "$script" "$cwd" run serve
    else
      start_app_old "$name" "$kind" "$script" "$cwd"
    fi
    FAIL=1
    continue
  fi
  if [ -n "$port" ]; then
    code="$(wait_port "$port" 25 || echo 000)"
    if [ "$code" = "000" ]; then
      echo "    [NG] :${port} が応答しません → 旧版に戻す" >&2
      pm2 delete "$name" >/dev/null 2>&1 || true
      if [ "$kind" = "npm" ]; then
        start_app_old "$name" "$kind" "$script" "$cwd" run serve
      else
        start_app_old "$name" "$kind" "$script" "$cwd"
      fi
      FAIL=1
      continue
    fi
    echo "    [OK] exe=${new_exe} :${port} → HTTP ${code}"
  else
    echo "    [OK] exe=${new_exe}"
  fi
done

if [ "$FAIL" != "0" ]; then
  echo "=== 一部アプリの移行に失敗しました（該当アプリだけ旧版に戻しました）===" >&2
  echo "    原因を確認して再実行してください（pm2 save は行いません）" >&2
  exit 1
fi

echo "=== pm2 save ==="
pm2 save >/dev/null 2>&1 && echo "[OK] pm2 save 完了（~/.pm2/dump.pm2 を更新）" || { echo "[ERR] pm2 save に失敗" >&2; exit 1; }

cat <<TXT
=== 完了 ===
移行: ${FROM} → ${TO}
確認:
  pm2 ls
  bash scripts/deploy/migrate-node-patch.sh --from ${FROM} --to ${TO}   # 全アプリが新版なら「スキップ」になる
  for p in 8080 3002 8081 7080 3131 3333 5000 3100; do curl -s -o /dev/null -w "\\\$p %{http_code}\\n" http://127.0.0.1:\\\$p/; done

まだ足りないもの（root が必要・別途実施）:
  - systemd pm2-yuzuki.service の PATH（デーモンの Node）→ v${TO}
  - systemd pi-vector.service / hitori-twitter.service の ExecStart → v${TO}
  - デーモンの再起動: sudo systemctl restart pm2-yuzuki
TXT
