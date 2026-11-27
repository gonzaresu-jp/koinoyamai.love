#!/usr/bin/env bash
# deploy.sh — テンプレートから生成した nginx 設定を本番へ配置する（フェーズ2）
#
# 使い方:
#   bash scripts/nginx/deploy.sh            # dry-run: render + 本番との diff + サンドボックス nginx -t のみ。本番へは書かない
#   sudo bash scripts/nginx/deploy.sh --apply   # 配置する（要 root。本番 nginx を reload する）
#
# --apply の流れ:
#   1. render（render.sh、一時ディレクトリへ生成）
#   2. メンテナンス ON 検出 → ON なら中止（fail-closed。下記）
#   3. 生成結果をサンドボックスで nginx -t（配置前検証）
#   4. /etc/nginx の現行ファイルを *.bak-template-<日時> へバックアップ
#   5. 配置 → 本番 nginx -t → systemctl reload nginx
#   6. いずれか失敗したらバックアップへ自動で戻し、nginx -t で復旧を確認してから終了する
#
# 配置対象（render の生成物のうち、本番で有効な設定だけ）:
#   nginx.conf / mai-test.conf / media.conf / discord.conf / snippets/mai-security-headers.conf
# snippets/maintenance.conf は配置しない:
#   メンテナンス OFF の通常状態では本番に存在しないのが正であり、
#   配置は apply-maintenance.sh --on の役割（スニペット単体では include されないため無害だが、
#   「OFF = ファイルなし」という apply-maintenance の状態管理と揃える）。
#
# メンテナンス ON の間は配置しない:
#   生成結果はメンテナンス OFF の状態（include 行なし）なので、ON のまま配置すると
#   メンテナンスが無言で解除されてしまう。先に apply-maintenance.sh --off で解除すること。
#
# .env の場所: render.sh と同じ（ENV_FILE 環境変数、既定はリポジトリ直下の .env）。
#   本番配置は本番ツリー（/var/www/html/koinoyamai.love）で実行する想定。
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-}"
case "$MODE" in
  "") MODE="dry-run" ;;
  --apply) MODE="apply" ;;
  *) echo "usage: bash scripts/nginx/deploy.sh [--apply]" >&2; exit 1 ;;
esac

TARGETS=(
  "nginx.conf"
  "mai-test.conf"
  "media.conf"
  "discord.conf"
  "snippets/mai-security-headers.conf"
)
# 配置先（既定 /etc/nginx。サンドボックス検証時のみ環境変数で差し替える）
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"

WORK="$(mktemp -d /tmp/nginx-deploy.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
RENDERED="$WORK/rendered"

echo "=== nginx deploy (mode: $MODE) ==="

# 1. render
bash "$SCRIPT_DIR/render.sh" "$RENDERED" >/dev/null
echo "[OK] render: $RENDERED"

# 2. メンテナンス ON 検出（dry-run でも状態として報告する）
MAINT_ON=0
if grep -q 'snippets/maintenance.conf' "$NGINX_DIR/nginx.conf" "$NGINX_DIR/mai-test.conf" 2>/dev/null \
   || [ -f "$NGINX_DIR/snippets/maintenance.conf" ]; then
  MAINT_ON=1
fi
if [ "$MAINT_ON" -eq 1 ]; then
  echo "[WARN] メンテナンス ON の状態です（snippets/maintenance.conf が有効）"
  if [ "$MODE" = "apply" ]; then
    echo "[ERR] メンテナンス ON のまま配置すると解除されてしまうため中止します。先に apply-maintenance.sh --off で解除してください" >&2
    exit 1
  fi
fi

# 本番との diff（dry-run の主出力。apply 時も事前確認として出す）
echo "--- 本番との diff ---"
DIFF_FOUND=0
for f in "${TARGETS[@]}"; do
  if [ -f "$NGINX_DIR/$f" ] && diff -q "$RENDERED/$f" "$NGINX_DIR/$f" >/dev/null 2>&1; then
    echo "  一致: $f"
  else
    echo "  差分あり: $f"
    DIFF_FOUND=1
  fi
done
if [ "$DIFF_FOUND" -eq 0 ]; then
  echo "  （全ファイル一致。本番はテンプレートと同内容です）"
fi

# 3. サンドボックス nginx -t（生成結果そのものは書き換えず、コピー側だけパス等を付け替える）
#    付け替え: /etc/nginx → サンドボックス、ログ/pid → サンドボックス、listen 80 → 18080
#    （一般ユーザでは特権ポートに bind できないため。root 実行時も実ポートと競合させない）
#    Certbot の証明書類が読めないユーザで実行する場合は、自己署名のダミーへ差し替える
#    （root 実行時は実ファイルで検証する）。
sandbox_test() {
  local sb="$WORK/sandbox"
  mkdir -p "$sb/etc/nginx/snippets" "$sb/log" "$sb/run" "$sb/ssl"
  cp -a "$RENDERED/." "$sb/etc/nginx/"
  cp "$NGINX_DIR/mime.types" "$NGINX_DIR/fastcgi_params" "$sb/etc/nginx/"
  cp "$NGINX_DIR/mime.types" "$sb/mime.types"
  if [ ! -r /etc/letsencrypt/options-ssl-nginx.conf ]; then
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$sb/ssl/privkey.pem" -out "$sb/ssl/fullchain.pem" \
      -days 1 -subj "/CN=localhost" >/dev/null 2>&1
    printf 'ssl_protocols TLSv1.2 TLSv1.3;\nssl_prefer_server_ciphers off;\n' > "$sb/etc/nginx/options-ssl-test.conf"
    openssl dhparam -out "$sb/ssl/dhparams.pem" 2048 >/dev/null 2>&1
  fi
  find "$sb/etc/nginx" -type f -name '*.conf' -exec sed -i \
    -e "s|/etc/nginx/|$sb/etc/nginx/|g" \
    -e "s|/var/log/nginx/|$sb/log/|g" \
    -e "s|/run/nginx.pid|$sb/run/nginx.pid|g" \
    -e 's/listen \[::\]:80;/listen [::]:18080;/' \
    -e 's/listen 80;/listen 18080;/' \
    {} +
  if [ ! -r /etc/letsencrypt/options-ssl-nginx.conf ]; then
    sed -i \
      -e "s|ssl_certificate .*|ssl_certificate $sb/ssl/fullchain.pem;|" \
      -e "s|ssl_certificate_key .*|ssl_certificate_key $sb/ssl/privkey.pem;|" \
      -e "s|include /etc/letsencrypt/options-ssl-nginx.conf;.*|include $sb/etc/nginx/options-ssl-test.conf;|" \
      -e "s|ssl_dhparam .*|ssl_dhparam $sb/ssl/dhparams.pem;|" \
      "$sb/etc/nginx/nginx.conf"
  fi
  nginx -t -c "$sb/etc/nginx/nginx.conf" -p "$sb"
}
echo "--- サンドボックス nginx -t ---"
if sandbox_test; then
  echo "[OK] nginx -t (sandbox)"
else
  echo "[ERR] 生成結果の nginx -t が失敗したため中止します（本番は無変更）" >&2
  exit 1
fi

if [ "$MODE" = "dry-run" ]; then
  echo "=== dry-run 終了（本番は無変更です） ==="
  echo "  配置するには: sudo bash scripts/nginx/deploy.sh --apply"
  exit 0
fi

# ここから --apply（root 必須）
if [ "$(id -u)" -ne 0 ]; then
  echo "[ERR] --apply は sudo で実行してください" >&2
  exit 1
fi

# 4. バックアップ
BAK_TS="$(date +%Y%m%d-%H%M%S-%N)"
MISSING_LIST="$WORK/missing-targets"
: > "$MISSING_LIST"
for f in "${TARGETS[@]}"; do
  if [ -f "$NGINX_DIR/$f" ]; then
    cp -a "$NGINX_DIR/$f" "$NGINX_DIR/$f.bak-template-$BAK_TS"
  else
    # 配置前に存在しなかったファイルは、復旧時に削除できるよう記録する
    echo "$f" >> "$MISSING_LIST"
  fi
done
echo "[OK] バックアップ: *.bak-template-$BAK_TS"

restore_from_backup() {
  echo "[WARN] バックアップへ戻します: *.bak-template-$BAK_TS" >&2
  for f in "${TARGETS[@]}"; do
    if grep -qx "$f" "$MISSING_LIST"; then
      rm -f "$NGINX_DIR/$f"
    elif [ -f "$NGINX_DIR/$f.bak-template-$BAK_TS" ]; then
      cp -a "$NGINX_DIR/$f.bak-template-$BAK_TS" "$NGINX_DIR/$f"
    fi
  done
  if nginx -t; then
    echo "[OK] 復元後の nginx -t は通りました" >&2
  else
    echo "[ERR] 復元後も nginx -t が失敗しています。手動確認が必要です" >&2
  fi
}

# 5. 配置 → nginx -t → reload
for f in "${TARGETS[@]}"; do
  install -m 0644 -o root -g root "$RENDERED/$f" "$NGINX_DIR/$f"
done
echo "[OK] 配置完了"

if ! nginx -t; then
  echo "[ERR] 配置後の nginx -t が失敗しました" >&2
  restore_from_backup
  exit 1
fi

if ! systemctl reload nginx; then
  echo "[ERR] reload が失敗しました" >&2
  restore_from_backup
  # 復元した設定で再度 reload を試みる（旧設定へ戻すため）
  systemctl reload nginx || echo "[ERR] 復元後の reload も失敗しています。手動確認が必要です" >&2
  exit 1
fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:1717/ || echo 000)"
echo "  疎通確認: http://127.0.0.1:1717/ → HTTP $CODE（200 が期待値）"
if [ "$CODE" != "200" ]; then
  echo "[WARN] 期待と異なる応答です。ログを確認してください（設定の復元はしていません）" >&2
fi
echo "=== 配置完了 ==="
