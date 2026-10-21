#!/usr/bin/env bash
# apply-maintenance.sh — メンテナンスモードの ON/OFF（PHP 実行の遮断）
#
# 目的（2026-10-21）:
#   PHP コアの緊急 RCE（CVE-2026-109618 / CVE-2026-109619・CVSS v4.0 9.2・詳細未公開）は
#   回避策が不明なため、**公開 PHP ページへの到達を nginx 側で遮断**する。
#   （CERT-EU: 「パッチが間に合わない場合は公開アプリを隔離せよ」）
#
# 影響:
#   - **止まる**: PHP で描画される公開ページ（index.php / archive.php など） → 503 メンテナンス
#   - **止まらない**: API（`/api/`）・ワーカー・通知（push）・静的ファイル
#     → 通知は届き続け、デスクトップアプリも通常どおり動く
#
# 実行（要 sudo）:
#   sudo bash scripts/nginx/apply-maintenance.sh --on     # メンテナンス開始
#   sudo bash scripts/nginx/apply-maintenance.sh --off    # 解除
#
# 安全性:
#   - 冪等（--on を2回実行しても二重に入らない）
#   - バックアップ → nginx -t が失敗したら即座に復元
#   - include は server ブロックの開き括弧直後（＝既存 `location ~ \.php$` より前）に入る
#   - 解除（--off）も同じコマンドでministrations設定を完全に外す
set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  --on) MODE="on" ;;
  --off) MODE="off" ;;
  *) echo "usage: sudo bash scripts/nginx/apply-maintenance.sh [--on|--off]" >&2; exit 1 ;;
esac

CONF="/etc/nginx/nginx.conf"
STAGING_CONF="/etc/nginx/mai-test.conf"
SNIPPET="/etc/nginx/snippets/maintenance.conf"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BLOCK_FILE="$REPO_ROOT/scripts/nginx/maintenance.conf"
PATCH_JS="$REPO_ROOT/scripts/nginx/apply-maintenance.js"
# node は明示指定する（sudo 実行では nvm の PATH が読めず /usr/bin/node = v18 EOL を掴むため。AGENTS.md §5）
NODE_BIN="${NODE_BIN:-/home/yuzuki/.nvm/versions/node/v24.22.0/bin/node}"

[ "$(id -u)" -eq 0 ] || { echo "[ERR] sudo で実行してください"; exit 1; }
[ -f "$CONF" ] || { echo "[ERR] $CONF が見つかりません"; exit 1; }
[ -f "$BLOCK_FILE" ] || { echo "[ERR] $BLOCK_FILE が見つかりません"; exit 1; }
[ -f "$PATCH_JS" ] || { echo "[ERR] $PATCH_JS が見つかりません"; exit 1; }
[ -x "$NODE_BIN" ] || { echo "[ERR] node が見つかりません: $NODE_BIN（NODE_BIN 環境変数で指定可）"; exit 1; }

echo "=== メンテナンスモード: ${MODE} ==="

if [ "$MODE" = "on" ]; then
  # スニペットを配置する（サーバー単位の add_header 継承を壊さないため include 方式）
  mkdir -p "$(dirname "$SNIPPET")"
  install -m 0644 "$BLOCK_FILE" "$SNIPPET"
  echo "[OK] スニペット配置: $SNIPPET"
fi

BAK_DIR="/etc/nginx"
TS="$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "${CONF}.bak-maintenance-${TS}"
[ -f "$STAGING_CONF" ] && cp -a "$STAGING_CONF" "${STAGING_CONF}.bak-maintenance-${TS}"
echo "[OK] バックアップ: *.bak-maintenance-${TS}"

TARGETS=("$CONF")
[ -f "$STAGING_CONF" ] && TARGETS+=("$STAGING_CONF")

if ! "$NODE_BIN" "$PATCH_JS" "$MODE" "${TARGETS[@]}"; then
  echo "[ERR] パッチに失敗したためバックアップへ戻します" >&2
  cp -a "${CONF}.bak-maintenance-${TS}" "$CONF"
  [ -f "${STAGING_CONF}.bak-maintenance-${TS}" ] && cp -a "${STAGING_CONF}.bak-maintenance-${TS}" "$STAGING_CONF"
  exit 1
fi

if ! nginx -t; then
  echo "[ERR] nginx -t が失敗したためバックアップへ戻します" >&2
  cp -a "${CONF}.bak-maintenance-${TS}" "$CONF"
  [ -f "${STAGING_CONF}.bak-maintenance-${TS}" ] && cp -a "${STAGING_CONF}.bak-maintenance-${TS}" "$STAGING_CONF"
  if nginx -t; then echo "[OK] 復元後の nginx -t は通りました" >&2; else echo "[ERR] 復元後も失敗" >&2; fi
  exit 1
fi

if [ "$MODE" = "on" ]; then
  nginx -s reload
  echo "=== メンテナンス開始 ==="
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:1717/index.php || echo 000)"
  echo "  /index.php → HTTP ${CODE}（503 が期待値）"
  [ "$CODE" = "503" ] || echo "  [WARN] 503 になっていません。include の位置と既存 location の順序を確認してください" >&2
  echo "  解除: sudo bash scripts/nginx/apply-maintenance.sh --off"
else
  # include  removed ならスニペット本体は不要
  if ! grep -rq "snippets/maintenance.conf" "$CONF" "$STAGING_CONF" 2>/dev/null; then
    rm -f "$SNIPPET"
    echo "[OK] スニペット削除: $SNIPPET"
  fi
  nginx -s reload
  echo "=== メンテナンス解除 ==="
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:1717/index.php || echo 000)"
  echo "  /index.php → HTTP ${CODE}（200 が期待値。php-fpm が停止中なら 502）"
fi
