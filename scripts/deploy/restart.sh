#!/bin/bash
# pm2 restart wrapper -- always passes --update-env so ecosystem.config.js changes take effect
# Usage: ./scripts/deploy/restart.sh [worker|api|discord|all|staging|worker-test]
#
# 重要（2026-10-21）:
#   - `pm2 start ecosystem.config.js`（--only なし）は ecosystem 内の全アプリを起動する。
#     mai-push-worker-test は常時停止運用（x.com 等への負荷）のため、対象を明示する。
#   - interpreter を変えたときは **pm2 save** が必要。systemd の pm2-yuzuki.service は
#     `pm2 resurrect` で ~/.pm2/dump.pm2 から復元するため、dump が古いままだと
#     再起動後に EOL 版 Node で復活する（AGENTS.md §5）。
#   - pm2 describe の interpreter 欄は信用できない（cluster モードでは無視される）。
#     実プロセスの /proc/<pid>/exe で検証する。
set -euo pipefail

CDIR="$(cd "$(dirname "$0")/../.." && pwd)"

# node は明示指定する（PATH 依存だと /usr/bin/node = v18 EOL を掴む。AGENTS.md §5）
NODE_BIN="/home/yuzuki/.nvm/versions/node/v24.22.1/bin/node"

# 実際に起動したバイナリを検証する（pm2 describe ではなく /proc を見る）
verify_interpreter() {
  local app="$1" expected="$2" pid actual
  pid="$(pm2 pid "$app" 2>/dev/null | tail -1)"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    echo "  [warn] $app: プロセスを特定できません（起動していない?）" >&2
    return 1
  fi
  actual="$(readlink -f "/proc/${pid}/exe" 2>/dev/null || echo '(判読不能)')"
  if [ "$actual" = "$expected" ]; then
    echo "  [ok] $app: $actual"
    return 0
  fi
  echo "  [NG] $app: 期待 $expected / 実際 $actual" >&2
  return 1
}

# 指定したアプリだけ検証する
verify_apps() {
  local expected fail=0 app
  expected="$("$NODE_BIN" -e "console.log(require('$CDIR/ecosystem.config.js').apps[0].interpreter)")"
  for app in "$@"; do
    verify_interpreter "$app" "$expected" || fail=1
  done
  return $fail
}

case "${1:-all}" in
  worker)
    echo "Restarting mai-push-worker with --update-env..."
    pm2 start "$CDIR/ecosystem.config.js" --only mai-push-worker --update-env
    TARGETS=(mai-push-worker)
    ;;
  api)
    echo "Restarting mai-push-api with --update-env..."
    pm2 start "$CDIR/ecosystem.config.js" --only mai-push-api --update-env
    TARGETS=(mai-push-api)
    ;;
  discord)
    echo "Restarting discord-bot with --update-env..."
    pm2 start "$CDIR/ecosystem.config.js" --only discord-bot --update-env
    TARGETS=(discord-bot)
    ;;
  all)
    # 本番プロセスだけ（staging の test worker は起動しない）
    echo "Restarting production processes with --update-env..."
    pm2 start "$CDIR/ecosystem.config.js" --only mai-push-api --only mai-push-worker --only discord-bot --update-env
    TARGETS=(mai-push-api mai-push-worker discord-bot)
    ;;
  staging)
    echo "Restarting mai-push-api-test with --update-env..."
    pm2 start "$CDIR/ecosystem.config.js" --only mai-push-api-test --update-env
    TARGETS=(mai-push-api-test)
    ;;
  worker-test)
    echo "Starting mai-push-worker-test with --update-env..."
    pm2 start "$CDIR/ecosystem.config.js" --only mai-push-worker-test --update-env
    TARGETS=(mai-push-worker-test)
    ;;
  *)
    echo "Usage: $0 [worker|api|discord|all|staging|worker-test]"
    exit 1
    ;;
esac

# dump を更新する（再起動後の pm2 resurrect が古い interpreter で復活しないため）
pm2 save >/dev/null 2>&1 || echo "[warn] pm2 save に失敗しました" >&2

echo "==> verifying actual node binary"
if ! verify_apps "${TARGETS[@]}"; then
  echo "[NG] 実行バイナリが想定と異なります。ecosystem.config.js の interpreter / exec_mode を確認してください" >&2
  exit 1
fi

echo "Done. Use 'pm2 status' to verify."
