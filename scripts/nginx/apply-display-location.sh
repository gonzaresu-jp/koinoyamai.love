#!/usr/bin/env bash
# apply-display-location.sh — nginx に「旅先ディスプレイ」の location を追加する
#
# 用途:
#   https://koinoyamai.love/display/ で旅先ディスプレイを配信するための
#   `location ^~ /display/` を nginx.conf（koinoyamai.love vhost）へ追加する。
#
# 実行（要 sudo）:
#   sudo bash scripts/nginx/apply-display-location.sh          # dry-run（変更しない）
#   sudo bash scripts/nginx/apply-display-location.sh --apply  # 適用
#
# 安全:
#   - 冪等（適用済みなら何もせず exit 0）
#   - アンカーが曖昧なら fail-closed（何も書き換えない）
#   - バックアップtaken → nginx -t が失敗したら即座に復元
#   - 配置先のディレクトリ（/var/www/html/smart-display/）が無い 404 になるだけなので、
#     nginx の変更と资产的配置は独立に行える
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

CONF="/etc/nginx/nginx.conf"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BLOCK_FILE="$REPO_ROOT/scripts/nginx/display-location.conf"
PATCH_JS="$REPO_ROOT/scripts/nginx/apply-display-location.js"
# node は明示指定する（sudo 実行では nvm の PATH が読めず /usr/bin/node = v18 EOL を掴むため。AGENTS.md §5）
NODE_BIN="/home/yuzuki/.nvm/versions/node/v24.22.0/bin/node"

[ "$(id -u)" -eq 0 ] || { echo "[ERR] sudo で実行してください"; exit 1; }
[ -f "$CONF" ] || { echo "[ERR] $CONF が見つかりません"; exit 1; }
[ -f "$BLOCK_FILE" ] || { echo "[ERR] $BLOCK_FILE が見つかりません"; exit 1; }
[ -f "$PATCH_JS" ] || { echo "[ERR] $PATCH_JS が見つかりません"; exit 1; }

echo "=== 旅先ディスプレイの nginx location 適用 ==="
echo "  対象     : $CONF"
echo "  ブロック : $BLOCK_FILE"

if [ "$APPLY" = "0" ]; then
  echo "--- dry-run: 適用後の確認手順 ---"
  cat <<'TXT'
  sudo bash scripts/nginx/apply-display-location.sh --apply
  curl -sI http://127.0.0.1:1717/display/ | head -5
  curl -sI https://koinoyamai.love/display/ | head -5
TXT
  exit 0
fi

BAK="$CONF.bak-display-location-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BAK"
echo "[OK] backup: $BAK"

"$NODE_BIN" "$PATCH_JS" "$CONF" "$BLOCK_FILE"

# nginx -t が失敗したらバックアップへ戻す（壊れた config を残さない）
if ! nginx -t; then
  echo "[ERR] nginx -t が失敗したためバックアップへ戻します" >&2
  cp -a "$BAK" "$CONF"
  echo "復元: $CONF" >&2
  exit 1
fi

nginx -s reload
echo "=== 完了 ==="
cat <<'TXT'
確認:
  curl -sI http://127.0.0.1:1717/display/ | head -5
  curl -sI https://koinoyamai.love/display/ | head -5
  # 資産が未配置なら 404 になる（配置は smart-display リポジトリの scripts/deploy-display.sh）
TXT
