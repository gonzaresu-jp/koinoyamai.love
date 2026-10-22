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
# 実行:
#   bash scripts/nginx/apply-dmedia-tunnel-only.sh          # dry-run（変更しない・root 不要）
#   sudo bash scripts/nginx/apply-dmedia-tunnel-only.sh --apply  # 適用（要 root）
#
# 安全:
#   - 冪等（適用済みマーカー **かつ** 規則があれば何もしない / 規則だけ欠けていれば自己修復）
#   - アンカーが曖昧なら fail-closed（何も書き換えない）
#   - atomic（一時ファイルを**同一ディレクトリ**に作り `mv -f` で差し替える = rename(2)）
#   - バックアップ → nginx -t 失敗時は即座に復元（自分が書いた内容が残っている場合のみ）
#   - 反映確認が期待値と違えば **非 0 終了**する
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

# 差分プレビュー用の一時出力（同ディレクトリに置くと mv で atomic に差し替えられる）
PREVIEW="$(mktemp)"
trap 'rm -f "$PREVIEW"' EXIT
if ! "$NODE_BIN" "$PATCH_JS" "$CONF" "$PREVIEW"; then
  echo "[ERR] パッチが失敗しました（fail-closed）。conf は変更していません。" >&2
  exit 1
fi

if [ "$APPLY" = "0" ]; then
  echo
  echo "--- dry-run: 適用される差分 ---"
  if cmp -s "$CONF" "$PREVIEW"; then
    echo "  （差分なし = 適用済み）"
  else
    diff -u "$CONF" "$PREVIEW" | sed 's/^/  /' || true
  fi
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

# 同一ディレクトリの一時ファイル → mv -f で atomic に差し替える（rename(2)）
TMP="$(dirname "$CONF")/.$(basename "$CONF").tmp.$$"
trap 'rm -f "$TMP" "$PREVIEW"' EXIT

# バックアップ取得後に他者が conf を変更していないか確認してから差し替える
if ! cmp -s "$CONF" "$BAK"; then
  echo "[ERR] $CONF はバックアップ取得後に変更されています（並行した適用の疑い）。" >&2
  echo "     他方の変更を潰さないよう **一切書き換えず中断**します。" >&2
  exit 1
fi

install -m 0644 "$PREVIEW" "$TMP"
if [ ! -s "$TMP" ]; then
  echo "[ERR] 一時ファイル（$TMP）が空です。conf を書き換えずに中断します" >&2
  exit 1
fi
mv -f "$TMP" "$CONF"

# nginx -t が失敗したらバックアップへ戻す（壊れた config を残さない）
if ! nginx -t; then
  echo "[ERR] nginx -t が失敗したためバックアップへ戻します" >&2
  if cmp -s "$CONF" "$BAK"; then
    # すでにバックアップと同じ（＝自分の書き込みが消えている）なら何もしない
    echo "     なお $CONF は既にバックアップと同一です（復元不要）" >&2
  elif ! cmp -s "$CONF" "$PREVIEW"; then
    # 他者が自分の書き込みを書き換えている → 復元すると他方の変更を潰す
    echo "     なお $CONF は自分が書き込んだ内容と異なります（並行した変更が疑われます）。" >&2
    echo "     他方の変更を潰さないよう **復元せず中断**します。差分は以下です:" >&2
    diff -u "$BAK" "$CONF" | sed 's/^/     /' >&2 || true
    echo "     手動で復旧してください: $BAK" >&2
    exit 1
  else
    cp -a "$BAK" "$CONF"
    echo "復元: $CONF" >&2
    if nginx -t; then
      echo "[OK] 復元後の nginx -t は通りました" >&2
    else
      echo "[ERR] 復元後も nginx -t が失敗します。手動で $BAK を確認してください" >&2
    fi
  fi
  exit 1
fi

nginx -s reload
echo "=== 完了 ==="

# 反映確認（期待値と違えば非 0 終了する）
FAILED=0
FILE="$(ls -1 /var/www/html/discord-media/ 2>/dev/null | head -1)"
if [ -n "$FILE" ]; then
  echo "--- 反映確認（対象: $FILE） ---"
  check() { # $1=説明 $2=期待 $3=期待値
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${@:4}" || echo 000)"
    if [ "$code" = "$3" ]; then
      echo "  $1 → HTTP $code（期待どおり）"
    else
      echo "  $1 → HTTP $code（期待 $3 のはず）  [ERR]"
      FAILED=1
    fi
  }
  check "tunnel 経由（公開 URL + Discordbot UA）" "" 200 \
    -A 'Discordbot/2.0' "https://discord.honna-yuzuki.com/dmedia/$FILE"
  check "通常 UA" "" 403 \
    "https://discord.honna-yuzuki.com/dmedia/$FILE"
  check "localhost 経由" "" 200 \
    -A 'Discordbot/2.0' -H 'Host: discord.honna-yuzuki.com' "http://127.0.0.1/dmedia/$FILE"
  check "LAN IP 経由（127.0.0.1 以外）" "" 403 \
    -A 'Discordbot/2.0' -H 'Host: discord.honna-yuzuki.com' "http://192.168.1.72/dmedia/$FILE"
else
  echo "  （/var/www/html/discord-media/ にファイルが無く確認を省略）"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "[ERR] 反映確認が期待値と異なります。ロールバック手順:" >&2
  echo "  sudo cp $BAK $CONF && sudo nginx -t && sudo nginx -s reload" >&2
  exit 1
fi

cat <<TXT
ロールバック:
  sudo cp $BAK $CONF && sudo nginx -t && sudo nginx -s reload
TXT
