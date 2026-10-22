#!/usr/bin/env bash
# apply-dmedia-tunnel-only.sh — Discord 専用メディア（/dmedia/）を tunnel 経由のみに限定する
#
# 用途（2026-10-22 実測に基づく）:
#   `discord.honna-yuzuki.com` の DNS は**既に cloudflared tunnel を指している**が、
#   nginx 側は「どこから来たリクエストでも受け付けている」。
#   残るのは UA 判定（User-Agent=Discordbot のみ許可）1 枚だけで、
#   UA はクライアントが自由に偽装できる（`curl -A Discordbot` で 200 / 実ファイル取得を実測）。
#   → `location ^~ /dmedia/` に allow 127.0.0.1 / allow ::1 / deny all を足し、
#     「tunnel 経由（cloudflared は 127.0.0.1 から接続）だけ」を強制する。
#
#   ※ UA 判定は残す（rewrite フェーズで先に走るため、Discordbot 以外は従来どおり 403）。
#   ※ URL 側は 128bit ランダム ID（推測不能）にしてある（upload サービス側）。
#
# 実行（要 sudo）:
#   sudo bash scripts/nginx/apply-dmedia-tunnel-only.sh          # dry-run（変更しない・root 不要）
#   sudo bash scripts/nginx/apply-dmedia-tunnel-only.sh --apply  # 適用
#
# 安全:
#   - 冪等（適用済みマーカーがあれば何もせず exit 0）
#   - アンカーが曖昧なら fail-closed（何も書き換えない）
#   - atomic（一時ファイルへ書き出してから install で差し替える）
#   - バックアップ → nginx -t 失敗時は即座に復元し、復元後に nginx -t を再実行
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

CONF="/etc/nginx/discord.conf"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PATCH_JS="$REPO_ROOT/scripts/nginx/apply-dmedia-tunnel-only.js"
# node は明示指定する（sudo 実行では nvm の PATH が読めず /usr/bin/node = v18 EOL を掴むため。AGENTS.md §5）
NODE_BIN="${NODE_BIN:-/home/yuzuki/.nvm/versions/node/v24.22.1/bin/node}"

[ -f "$CONF" ] || { echo "[ERR] $CONF が見つかりません"; exit 1; }
[ -f "$PATCH_JS" ] || { echo "[ERR] $PATCH_JS が見つかりません"; exit 1; }
[ -x "$NODE_BIN" ] || { echo "[ERR] node が見つかりません: $NODE_BIN（NODE_BIN 環境変数で指定可）"; exit 1; }

echo "=== Discord 専用メディアの tunnel 限定 ==="
echo "  対象      : $CONF"
echo "  パッチ    : $PATCH_JS"
echo "  node      : $NODE_BIN ($("$NODE_BIN" -v))"
echo
echo "  効果:"
echo "    - /dmedia/ は cloudflared（127.0.0.1 / ::1）からのみ許可される"
echo "    - origin の :80 へ直接叩いた場合は 403（allow/deny は access フェーズで判定）"
echo "    - UA 判定は残す（Discordbot 以外は従来どおり 403）"
echo "    - 他の vhost（media / 本番 / staging / LAN vhost）は触らない"

if [ "$APPLY" = "0" ]; then
  echo
  echo "--- dry-run: 適用後の確認手順 ---"
  cat <<'TXT'
  sudo bash scripts/nginx/apply-dmedia-tunnel-only.sh --apply
  # 1) tunnel 経由は取得できる（Discordbot UA）
  curl -s -o /dev/null -w '%{http_code}\n' -A 'Discordbot/2.0' https://discord.honna-yuzuki.com/dmedia/<ファイル名>
  # 2) 通常 UA は 403 のまま
  curl -s -o /dev/null -w '%{http_code}\n' https://discord.honna-yuzuki.com/dmedia/<ファイル名>
  # 3) localhost 経由（= tunnel と同じ 127.0.0.1）は 200
  curl -s -o /dev/null -w '%{http_code}\n' -A 'Discordbot/2.0' -H 'Host: discord.honna-yuzuki.com' http://127.0.0.1/dmedia/<ファイル名>
  # 4) LAN IP 経由（= 127.0.0.1 以外）は 403 ← これが今回の目的
  curl -s -o /dev/null -w '%{http_code}\n' -A 'Discordbot/2.0' -H 'Host: discord.honna-yuzuki.com' http://192.168.1.72/dmedia/<ファイル名>
TXT
  exit 0
fi

# 以降は nginx 設定を書き換えるので root が必要
[ "$(id -u)" -eq 0 ] || { echo "[ERR] 適用には root が必要です（sudo bash ... --apply で実行）"; exit 1; }

BAK="$CONF.bak-dmedia-tunnel-only-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BAK"
echo "[OK] backup: $BAK"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# atomic: 一時ファイルへ書き出してから install で差し替える
"$NODE_BIN" "$PATCH_JS" "$CONF" "$TMP"
# ★ 出力が空（= 0 byte）なら install しない（conf が 0 byte になると vhost が消える）
if [ ! -s "$TMP" ]; then
  echo "[ERR] パッチの出力（$TMP）が空です。conf を書き換えずに中断します" >&2
  exit 1
fi
install -m 0644 "$TMP" "$CONF"

# nginx -t が失敗したらバックアップへ戻す（壊れた config を残さない）
if ! nginx -t; then
  echo "[ERR] nginx -t が失敗したためバックアップへ戻します" >&2
  if ! cmp -s "$CONF" "$BAK"; then
    echo "     なお $CONF はバックアップ取得後に変更されています（並行した変更が疑われます）。" >&2
    echo "     他方の変更を潰さないよう **復元せず中断**します。" >&2
    exit 1
  fi
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

# 反映確認（実ファイルがあれば確認する）
FILE="$(ls -1 /var/www/html/discord-media/ 2>/dev/null | head -1)"
if [ -n "$FILE" ]; then
  echo "--- 反映確認（対象: $FILE） ---"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -A 'Discordbot/2.0' "https://discord.honna-yuzuki.com/dmedia/$FILE" || echo 000)"
  echo "  tunnel 経由（公開 URL + Discordbot UA） → HTTP $code（200 なら期待どおり）"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://discord.honna-yuzuki.com/dmedia/$FILE" || echo 000)"
  echo "  通常 UA                                → HTTP $code（403 なら期待どおり）"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -A 'Discordbot/2.0' -H 'Host: discord.honna-yuzuki.com' "http://127.0.0.1/dmedia/$FILE" || echo 000)"
  echo "  localhost 経由                         → HTTP $code（200 なら期待どおり）"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -A 'Discordbot/2.0' -H 'Host: discord.honna-yuzuki.com' "http://192.168.1.72/dmedia/$FILE" || echo 000)"
  echo "  LAN IP 経由（127.0.0.1 以外）          → HTTP $code（403 なら期待どおり）"
else
  echo "  （/var/www/html/discord-media/ にファイルが無く確認を省略）"
fi

cat <<TXT
ロールバック:
  sudo cp $BAK $CONF && sudo nginx -t && sudo nginx -s reload
TXT
