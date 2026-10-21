#!/usr/bin/env bash
# apply-domain-final.sh
# 2026-10-19 ドメイン完全移行: mai.honna-yuzuki.com -> koinoyamai.love
#   1) 旧ドメイン(:1700) を全パス 301（例外なし）に変更
#   2) ツリーパスを新名へ（/var/www/html/mai-push -> koinoyamai.love 等）
#   3) 廃止した /migration.js location を削除
#   4) pushweb の CORS 旧ドメインを新ドメインへ
#   5) default vhost の旧パス deny を新名へ
#   6) リポジトリの scripts/nginx/mai-test.conf を /etc/nginx/mai-test.conf へ導入
#      （nginx.conf が include する staging vhost。server_name test.koinoyamai.love）
# 実行（要 sudo, リポジトリ内から）: sudo bash scripts/nginx/apply-domain-final.sh
#   ※ 先に scripts/deploy/migrate-domain-final.sh でフォルダ移動を済ませておくこと
#   ※ このスクリプトは非冪等（2 回目はアンカー不一致で fail-closed 停止）。再実行は
#      バックアップから戻すか、適用済みチェックを手動で行うこと。
set -euo pipefail

CONF=/etc/nginx/nginx.conf
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_MAI_TEST="$REPO_ROOT/scripts/nginx/mai-test.conf"
[ "$(id -u)" -eq 0 ] || { echo "[ERR] sudo で実行してください"; exit 1; }
[ -f "$CONF" ] || { echo "[ERR] $CONF が見つかりません"; exit 1; }

BAK="$CONF.bak-domain-final-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BAK"
echo "[OK] backup: $BAK"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# node は明示指定する（sudo 実行では nvm の PATH が読めず /usr/bin/node = v18 EOL を掴むため。AGENTS.md §5）
NODE_BIN="/home/yuzuki/.nvm/versions/node/v24.22.0/bin/node"

"$NODE_BIN" - "$CONF" "$TMP" <<'NODE'
const fs = require("fs");
const [src, dst] = process.argv.slice(2);
let s = fs.readFileSync(src, "utf8");
let changed = 0;

function replace(name, oldStr, newStr, want) {
  const n = s.split(oldStr).length - 1;
  if (n !== want) {
    console.error(`ABORT: ${name}: expected ${want} occurrence(s), found ${n}`);
    process.exit(1);
  }
  s = s.split(oldStr).join(newStr);
  changed += n;
  console.log(`OK: ${name} (${n})`);
}

function replaceAtLeast(name, oldStr, newStr) {
  const n = s.split(oldStr).length - 1;
  if (n < 1) {
    console.error(`ABORT: ${name}: expected >=1 occurrence(s), found 0`);
    process.exit(1);
  }
  s = s.split(oldStr).join(newStr);
  changed += n;
  console.log(`OK: ${name} (${n})`);
}

// 0 件でも可（staging vhost は別ファイル mai-test.conf 側にある）
function replaceOptional(name, oldStr, newStr) {
  const n = s.split(oldStr).length - 1;
  if (n > 0) {
    s = s.split(oldStr).join(newStr);
    changed += n;
    console.log(`OK: ${name} (${n})`);
  } else {
    console.log(`skip: ${name} (0; 別ファイル管理)`);
  }
}

// 1) 旧ドメイン: 条件付き301 -> 全パス301（例外なし）
replace("1700-full-301",
`    # フェーズ2 (2026-10-10): ページは新ドメイン koinoyamai.love へ301。
    # 旧アプリ(Android1.4等)向けに /api・/auth・/dl・/pushweb、
    # LAN保険・Tailnet受け皿の /admin 系は移行期間中そのまま配信する。
    set $mai_to_new 1;
    if ($uri ~ "^/(api|auth|dl|pushweb)(/|$)|^/admin(\\.html|/|$)") { set $mai_to_new 0; }
    if ($mai_to_new = 1) { return 301 https://koinoyamai.love$request_uri; }`,
`    # 完全移行 (2026-10-19): 旧ドメインは全パス301で koinoyamai.love へ（例外なし）。
    # 旧 /api・/auth・/dl・/pushweb・/admin の例外は撤廃。旧アプリは非対応。
    return 301 https://koinoyamai.love$request_uri;`,
1);

// 2) 廃止: /migration.js location（移行カード廃止に伴い）
replace("remove-migration.js",
`location = /migration.js {
    root /var/www/html/mai-push/webui;
    try_files /migration.js =404;
}
`,
"",
1);

// 3) ツリーパスを新名へ
replaceAtLeast("tree-path", "/var/www/html/mai-push", "/var/www/html/koinoyamai.love");
replaceOptional("staging-path", "/home/yuzuki/mai-push-test", "/home/yuzuki/koinoyamai.love-test");

// 4) pushweb CORS 旧ドメイン -> 新ドメイン
replace("cors-origin", "'https://mai.honna-yuzuki.com'", "'https://koinoyamai.love'", 2);

// 5) default vhost の旧パス deny を新名へ
replace("default-deny", "location ^~ /mai-push/ { deny all; }", "location ^~ /koinoyamai.love/ { deny all; }", 1);

// 残存チェック（server_name mai.honna-yuzuki.com 以外に旧メインドメインが残っていないこと）
const leftover = s.split("mai.honna-yuzuki.com").length - 1;
console.log(`[info] remaining "mai.honna-yuzuki.com": ${leftover} (server_name 由来の 1 のみ想定)`);
if (leftover > 1) {
  console.error("WARN: 旧メインドメインの参照が残っています。手動確認してください。");
}

console.log(`[OK] ${changed} replacements`);
fs.writeFileSync(dst, s);
NODE

install -m 0644 "$TMP" "$CONF"

# 6) staging vhost（include される別ファイル）を新ホスト・新パスへ導入
if [ -f "$SRC_MAI_TEST" ]; then
  if [ -f /etc/nginx/mai-test.conf ]; then
    BAK2="/etc/nginx/mai-test.conf.bak-domain-final-$(date +%Y%m%d-%H%M%S)"
    cp -a /etc/nginx/mai-test.conf "$BAK2"
    echo "[OK] backup: $BAK2"
  fi
  install -m 0644 "$SRC_MAI_TEST" /etc/nginx/mai-test.conf
  echo "[OK] installed /etc/nginx/mai-test.conf (test.koinoyamai.love)"
else
  echo "[WARN] $SRC_MAI_TEST が見つかりません（staging vhost 未更新）"
fi

if nginx -t; then
  systemctl reload nginx
  echo "[OK] nginx reloaded"
else
  echo "[ERR] nginx -t 失敗。バックアップから復旧します"
  cp -a "$BAK" "$CONF"
  [ -n "${BAK2:-}" ] && cp -a "$BAK2" /etc/nginx/mai-test.conf
  nginx -t
  exit 1
fi
