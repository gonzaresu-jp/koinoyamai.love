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
#   - **atomic**: 一時ファイルへ書き出してから `install` で差し替える
#     （途中で kill されても nginx.conf が壊れない）
#   - バックアップ → nginx -t 失敗時は即座に復元し、復元後に nginx -t を再実行
#   - 配置先のディレクトリ（/var/www/html/smart-display/）が無い 404 になるだけなので、
#     nginx の変更と資産の配置は独立に行える
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

CONF="/etc/nginx/nginx.conf"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BLOCK_FILE="$REPO_ROOT/scripts/nginx/display-location.conf"
PATCH_JS="$REPO_ROOT/scripts/nginx/apply-display-location.js"
# node は明示指定する（sudo 実行では nvm の PATH が読めず /usr/bin/node = v18 EOL を掴むため。AGENTS.md §5）
NODE_BIN="${NODE_BIN:-/home/yuzuki/.nvm/versions/node/v24.22.1/bin/node}"

[ -f "$CONF" ] || { echo "[ERR] $CONF が見つかりません"; exit 1; }
[ -f "$BLOCK_FILE" ] || { echo "[ERR] $BLOCK_FILE が見つかりません"; exit 1; }
[ -f "$PATCH_JS" ] || { echo "[ERR] $PATCH_JS が見つかりません"; exit 1; }
[ -x "$NODE_BIN" ] || { echo "[ERR] node が見つかりません: $NODE_BIN（NODE_BIN 環境変数で指定可）"; exit 1; }

echo "=== 旅先ディスプレイの nginx location 適用 ==="
echo "  対象     : $CONF"
echo "  ブロック : $BLOCK_FILE"
echo "  リポジトリ: $REPO_ROOT"
echo "  node     : $NODE_BIN ($("$NODE_BIN" -v))"

if [ "$APPLY" = "0" ]; then
  # dry-run は変更しないので root 不要（他の apply-*.sh と同じ運用）
  echo "--- dry-run: 適用後の確認手順 ---"
  cat <<'TXT'
  sudo bash scripts/nginx/apply-display-location.sh --apply
  curl -sI http://127.0.0.1:1717/display/ | head -5
  curl -sI https://koinoyamai.love/display/ | head -5
TXT
  exit 0
fi

# 以降は nginx.conf を書き換えるので root が必要
[ "$(id -u)" -eq 0 ] || { echo "[ERR] 適用には root が必要です（sudo bash ... --apply で実行）"; exit 1; }

BAK="$CONF.bak-display-location-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BAK"
echo "[OK] backup: $BAK"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# atomic: 一時ファイルへ書き出してから install で差し替える
"$NODE_BIN" "$PATCH_JS" "$CONF" "$BLOCK_FILE" "$TMP"
install -m 0644 "$TMP" "$CONF"

# nginx -t が失敗したらバックアップへ戻す（壊れた config を残さない）
if ! nginx -t; then
  echo "[ERR] nginx -t が失敗したためバックアップへ戻します" >&2
  cp -a "$BAK" "$CONF"
  echo "復元: $CONF" >&2
  if nginx -t; then
    echo "[OK] 復元後の nginx -t は通りました" >&2
  else
    echo "[ERR] 復元後も nginx -t が失敗します。手動で $BAK を確認してください" >&2
  fi
  exit 1
fi

nginx -s reload
echo "=== 完了 ==="

# 反映確認（資産未配置なら 404 になる）
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:1717/display/ || echo 000)"
if [ "$CODE" = "200" ]; then
  echo "[OK] http://127.0.0.1:1717/display/ → HTTP $CODE"
else
  echo "[WARN] http://127.0.0.1:1717/display/ → HTTP $CODE（資産未配置なら smart-display の scripts/deploy-display.sh --apply で配置）" >&2
fi

cat <<'TXT'
確認:
  curl -sI http://127.0.0.1:1717/display/ | head -5
  curl -sI https://koinoyamai.love/display/ | head -5
  # 資産の配置は smart-display リポジトリの scripts/deploy-display.sh で行う
TXT
