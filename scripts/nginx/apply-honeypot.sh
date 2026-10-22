#!/usr/bin/env bash
# apply-honeypot.sh — nginx にハニーポット（偽物の秘密ファイル）を配信させる
#
# 何をするか（2026-10-22 実測に基づく）:
#   - 公開サイトには既に秘密ファイル探索が来ている（アクセスログ 217 件: /.env /.git/config
#     /id_rsa /database.sqlite /backup.zip /.aws/credentials など）。
#   - 現状は「見つからない」だけなので**証拠が残らない**。
#     そこで**本物そっくりの偽物**を配信し、取得されたら通知する。
#
# 入れるもの（`listen 1717` + `server_name koinoyamai.love` の vhost のみ）:
#   - 機密ファイル名っぽいパスは `/var/lib/mai-push/honeypot/` の**偽物だけ**を返す
#     （他所の実ファイルは公開されない。先にマッチするため）
#   - `/_canary/` は 204 を返し honey.log に記録（＝「盗んだ情報を使った」証拠）
#   - その他の機密拡張子は deny
#   - honey.log 用のログフォーマット（時刻・UA・クライアント IP 入り）
#
# 実行（要 sudo）:
#   sudo bash scripts/nginx/apply-honeypot.sh          # dry-run（変更しない）
#   sudo bash scripts/nginx/apply-honeypot.sh --apply  # 適用
#
# 前提:
#   bash scripts/security/honeypot-setup.sh   # 偽物と canary token を生成済み
#
# 安全:
#   - 冪等（適用済みなら何もせず exit 0）
#   - アンカーが曖昧なら fail-closed（何も書き換えない）
#   - atomic（一時ファイルへ書き出してから install で差し替える）
#   - バックアップ → nginx -t 失敗時は即座に復元し、復元後に nginx -t を再実行
#   - 中身は**すべて偽物**（実物の秘密値は含まれない）
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

CONF="/etc/nginx/nginx.conf"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PATCH_JS="$REPO_ROOT/scripts/nginx/apply-honeypot.js"
HONEY_DIR="/var/lib/mai-push/honeypot"
# node は明示指定する（sudo 実行では nvm の PATH が読めず /usr/bin/node = v18 EOL を掴むため。AGENTS.md §5）
NODE_BIN="${NODE_BIN:-/home/yuzuki/.nvm/versions/node/v24.22.1/bin/node}"

[ -f "$CONF" ] || { echo "[ERR] $CONF が見つかりません"; exit 1; }
[ -f "$PATCH_JS" ] || { echo "[ERR] $PATCH_JS が見つかりません"; exit 1; }
[ -x "$NODE_BIN" ] || { echo "[ERR] node が見つかりません: $NODE_BIN（NODE_BIN 環境変数で指定可）"; exit 1; }

echo "=== nginx ハニーポットの適用 ==="
echo "  対象      : $CONF"
echo "  パッチ    : $PATCH_JS"
echo "  配信元    : $HONEY_DIR"
echo "  node      : $NODE_BIN ($("$NODE_BIN" -v))"

if [ ! -d "$HONEY_DIR" ]; then
  echo "[ERR] 偽物が生成されていません: $HONEY_DIR" >&2
  echo "      先に bash scripts/security/honeypot-setup.sh を実行してください" >&2
  exit 1
fi

# --- 事前チェック（fail-closed）---
# ハニー/deny のパターンに webroot の実ファイルがマッチすると、
# そのページが偽物（または 403）に差し替わる＝**既存サイト品位壊れる**。
# 該当があれば適用しない。
WEBROOT="${WEBROOT:-/var/www/html/koinoyamai.love/webui}"
HONEY_RE='^/(?:[\w.\-]+/)*(?:\.env(?:\.[\w.\-]+)?|\.git/(?:config|HEAD)|\.aws/credentials|\.ssh/id_\w+|id_rsa(?:\.pub)?|backup\.(?:zip|tar|gz|7z)|(?:database|db|app|prod|main|site|dump)\.(?:sqlite3?|sql)|config\.(?:php|json|ya?ml)|wp-config\.php|(?:credentials|secret|secrets|passwords?)\.(?:txt|json|ya?ml|db)|dump\.sql)$'
DENY_RE='\.(?:env|bak|old|orig|save|swp|swo|sql|sqlite3?|db|db3|log|key|pem|p12|pfx|jks|keystore|asc|gpg|pgp|ovpn|tar|tgz|gz|bz2|7z|rar)$'
echo "--- 事前チェック（webroot と honey/deny パターンの衝突）---"
if [ -d "$WEBROOT" ]; then
  CONFLICT="$(cd "$WEBROOT" && find . -type f | sed 's|^\.||' | grep -P "$HONEY_RE" || true)"
  DENYED="$(cd "$WEBROOT" && find . -type f | grep -P "$DENY_RE" || true)"
  if [ -n "$CONFLICT" ]; then
    echo "[ERR] webroot にハニーパターンと衝突するファイルがあります。適用しません:" >&2
    echo "$CONFLICT" | sed 's/^/       /' >&2
    echo "       （そのファイルは偽物に差し替わります。先に退避してください）" >&2
    exit 1
  fi
  echo "  [OK] ハニーパターンと衝突するファイルはない"
  if [ -n "$DENYED" ]; then
    echo "  [INFO] deny ルールで 403 になるファイル（残骸の想定）:"
    echo "$DENYED" | sed 's/^/         /'
  fi
else
  echo "  [INFO] $WEBROOT が存在しません（事前チェックをスキップ）"
fi

if [ "$APPLY" = "0" ]; then
  echo
  echo "--- dry-run: 適用後の確認手順 ---"
  cat <<'TXT'
  bash scripts/security/honeypot-setup.sh            # 偽物の生成（未実施なら）
  sudo bash scripts/nginx/apply-honeypot.sh --apply
  # 偽物が配信されるか
  curl -sI http://127.0.0.1:1717/.env            | head -5   # 200 になる（偽物）
  curl -s  http://127.0.0.1:1717/.env | head -3            # 偽物の中身
  curl -sI http://127.0.0.1:1717/database.sqlite  | head -5
  # 既存サイトに影響がないこと
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1717/index.php
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1717/dl/android.json
  # 監視
  node scripts/security/honeypot-watch.js --dry-run
TXT
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo "[ERR] 適用には root が必要です（sudo bash ... --apply で実行）" >&2; exit 1; }

BAK="$CONF.bak-honeypot-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BAK"
echo "[OK] backup: $BAK"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

"$NODE_BIN" "$PATCH_JS" "$CONF" "$TMP"
install -m 0644 "$TMP" "$CONF"

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
for p in /.env /database.sqlite /.git/config /backup.zip /config.php; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:1717$p" || echo 000)"
  size="$(curl -s --max-time 10 "http://127.0.0.1:1717$p" 2>/dev/null | wc -c)"
  echo "  $p → HTTP $code（${size} bytes）"
done
echo "  honey.log の最終行:"; tail -1 /var/log/nginx/honey.log 2>/dev/null | sed 's/^/    /' || echo "    (まだ記録なし)"
echo "--- 既存サイトの生存確認 ---"
for p in /index.php /archive.php /dl/android.json /manifest.json /css/header.css; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:1717$p" || echo 000)"
  echo "  $p → HTTP $code"
done

cat <<'TXT'
監視の有効化（cron）:
  */5 * * * *  mkdir -p /var/www/html/koinoyamai.love/logs && /home/yuzuki/.nvm/versions/node/v24.22.1/bin/node /var/www/html/koinoyamai.love/scripts/security/honeypot-watch.js >> /var/www/html/koinoyamai.love/logs/honeypot-cron.log 2>&1
  ※ watcher 自身のイベントログは logs/honeypot.log（cron の stdout とは別のファイル）
通知の疎通テスト:
  node scripts/security/honeypot-watch.js --test
ロールバック:
  sudo cp <BACKUP> /etc/nginx/nginx.conf && sudo nginx -t && sudo nginx -s reload
TXT
