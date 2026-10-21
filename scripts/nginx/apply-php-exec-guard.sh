#!/usr/bin/env bash
# apply-php-exec-guard.sh — nginx の elza vhost で PHP 実行を 404 にする
#
# 用途（2026-10-21 実測に基づく）:
#   /etc/nginx/nginx.conf の `server_name elza.poitou-mora.ts.net` の vhost は
#   root が `/var/www/html` で、**旧 PHP が残っている**:
#     /var/www/html/henkan/henkan.php … move_uploaded_file() + exec()（allow all で無認証）
#     /var/www/html/henkan/con.php    … move_uploaded_file() + exec()
#     /var/www/html/index.php 等      … 旧サーバーステータス
#   現在は php-fpm の open_basedir（docroot 2 つ + /tmp ほか）により
#   「No input file specified.」で実行できないが、
#   **basedir が緩んだ / 別 SAPI が Reading 始めた瞬間に無認証の公開 RCE になる**。
#   → この vhost では PHP を実行しない（404）ことにする。
#
#   ※ 本番 vhost（listen 1717 / koinoyamai.love）と
#     staging vhost（/etc/nginx/mai-test.conf, listen 80 / test.koinoyamai.love）は
#     **対象外**。サイトの PHP は引き続き正常稼働させる。
#
# 実行（要 sudo）:
#   sudo bash scripts/nginx/apply-php-exec-guard.sh          # dry-run（変更しない・root 不要）
#   sudo bash scripts/nginx/apply-php-exec-guard.sh --apply  # 適用
#
# 安全:
#   - 冪等（適用済みなら何もせず exit 0）
#   - アンカーが曖昧なら fail-closed（何も書き換えない）
#   - atomic（一時ファイルへ書き出してから install で差し替える）
#   - バックアップ → nginx -t 失敗時は即座に復元し、復元後に nginx -t を再実行
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

CONF="/etc/nginx/nginx.conf"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PATCH_JS="$REPO_ROOT/scripts/nginx/apply-php-exec-guard.js"
# node は明示指定する（sudo 実行では nvm の PATH が読めず /usr/bin/node = v18 EOL を掴むため。AGENTS.md §5）
NODE_BIN="${NODE_BIN:-/home/yuzuki/.nvm/versions/node/v24.22.1/bin/node}"

[ -f "$CONF" ] || { echo "[ERR] $CONF が見つかりません"; exit 1; }
[ -f "$PATCH_JS" ] || { echo "[ERR] $PATCH_JS が見つかりません"; exit 1; }
[ -x "$NODE_BIN" ] || { echo "[ERR] node が見つかりません: $NODE_BIN（NODE_BIN 環境変数で指定可）"; exit 1; }

echo "=== nginx PHP 実行ガード（elza vhost）の適用 ==="
echo "  対象      : $CONF"
echo "  パッチ    : $PATCH_JS"
echo "  node      : $NODE_BIN ($("$NODE_BIN" -v))"
echo
echo "  効果:"
echo "    - elza vhost（elza.poitou-mora.ts.net / root=/var/www/html）の PHP 実行を 404 にする"
echo "    - /henkan/henkan.php（exec + move_uploaded_file、無認証）を 404 にする"
echo "    - 本番(:1717) と staging(:80) の PHP は変更しない"

if [ "$APPLY" = "0" ]; then
  echo
  echo "--- dry-run: 適用後の確認手順 ---"
  cat <<'TXT'
  sudo bash scripts/nginx/apply-php-exec-guard.sh --apply
  # 適用後: 旧 PHP は 404 になる
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: elza.poitou-mora.ts.net' http://127.0.0.1:80/henkan/henkan.php
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: elza.poitou-mora.ts.net' http://127.0.0.1:80/index.php
  # 本番は影響を受けない（200 のまま）
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1717/index.php
TXT
  exit 0
fi

# 以降は nginx.conf を書き換えるので root が必要
[ "$(id -u)" -eq 0 ] || { echo "[ERR] 適用には root が必要です（sudo bash ... --apply で実行）"; exit 1; }

BAK="$CONF.bak-php-exec-guard-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BAK"
echo "[OK] backup: $BAK"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# atomic: 一時ファイルへ書き出してから install で差し替える
"$NODE_BIN" "$PATCH_JS" "$CONF" "$TMP"
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

echo "--- 反映確認 ---"
for p in /henkan/henkan.php /index.php; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: elza.poitou-mora.ts.net' "http://127.0.0.1:80$p" || echo 000)"
  echo "  elza $p → HTTP $code（404 なら期待どおり）"
done
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:1717/index.php || echo 000)"
echo "  本番 /index.php → HTTP $code（200 なら影響なし）"

cat <<'TXT'
ロールバック:
  sudo cp <BACKUP> /etc/nginx/nginx.conf && sudo nginx -t && sudo nginx -s reload
TXT
