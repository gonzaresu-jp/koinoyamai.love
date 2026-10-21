#!/usr/bin/env bash
# scripts/deploy/npm-deploy.sh - node_modules を package-lock.json に同期する（依存更新の本番反映）
#
# なぜ必要か（2026-10-21 実測）:
#   `git pull` で package-lock.json だけ更新しても **node_modules は更新されない**。
#   その状態で:
#     - 本番は古い（脆弱な）依存で動き続ける
#     - 一方 `npm audit` は **lockfile 基準**で判定するため、
#       security-watch が「critical 解消」と報告してしまう（偽の安全感）
#   つまり「lockfile と node_modules の乖離」自体が検出されなければsilent に壊れる。
#
# 手順:
#   1. lockfile と node_modules の乖離を検出（主要パッケージのバージョン比較）
#   2. 乖離があれば **pm2 を停止**してから `npm install`（ネイティブ実ファイルを
#      差し替えるため、実行中のプロセスはクラッシュしうる。AGENTS.md §5）
#   3. 検証（lockfile と node_modules の一致・主要モジュールのロード）
#   4. pm2 を再起動（新しい interpreter で）
#   5. 失敗時は lockfile を git から戻して `npm install` し直して復旧
#
# `npm ci` ではなく `npm install` をを使う理由:
#   `npm ci` は node_modules を全削除してから再取得するため、レジストリ障害時に
#   本番が依存ごと無くなる。`npm install` は必要な差分だけ更新する。
#
# 使い方:
#   bash scripts/deploy/npm-deploy.sh                 # dry-run（検査のみ）
#   bash scripts/deploy/npm-deploy.sh --apply         # 適用
#   ROOT=/path/to/tree bash scripts/deploy/npm-deploy.sh --apply   # 対象ツリーを指定
set -euo pipefail

ROOT="${ROOT:-/var/www/html/koinoyamai.love}"
NODE_BIN="${NODE_BIN:-/home/yuzuki/.nvm/versions/node/v24.22.1/bin/node}"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

# 監視対象にする主要パッケージ（lockfile と node_modules の両方で版を見る）
KEY_PACKAGES=(proxy-addr sharp esbuild undici follow-redirects firebase-admin puppeteer sqlite3 bcrypt)

cd "$ROOT" || { echo "error: $ROOT に移動できません" >&2; exit 1; }
[ -x "$NODE_BIN" ] || { echo "error: node が見つかりません: $NODE_BIN" >&2; exit 1; }
[ -f package-lock.json ] || { echo "error: package-lock.json がありません" >&2; exit 1; }

echo "=== node_modules の同期（$ROOT） ==="

# --- 1. 乖離検出 ---
DIFF_OUT="$("$NODE_BIN" -e '
const lock = require("./package-lock.json");
const pkgs = process.argv.slice(1);
const out = [];
for (const name of pkgs) {
  const key = "node_modules/" + name;
  const locked = lock.packages && lock.packages[key] && lock.packages[key].version;
  let installed = null;
  try { installed = require("./node_modules/" + name + "/package.json").version; } catch (e) {}
  if (locked && installed && locked !== installed) out.push(`${name}: lock=${locked} installed=${installed}`);
  else if (locked && !installed) out.push(`${name}: lock=${locked} installed=(未インストール)`);
}
console.log(out.join("\n"));
' "${KEY_PACKAGES[@]}")"

if [ -z "$DIFF_OUT" ]; then
  echo "✓ 乖離なし（node_modules は package-lock.json と一致）"
  if [ "$APPLY" -eq 0 ]; then
    echo "--- dry-run: 何もしません ---"
    exit 0
  fi
  echo "適用指定 있지만更新不要のため終了します"
  exit 0
fi

echo "乖離を検出:"
echo "$DIFF_OUT" | sed 's/^/  /'

if [ "$APPLY" -eq 0 ]; then
  echo "--- dry-run: 適用後の手順 ---"
  echo "  1. pm2 停止（このツリーの mai-push プロセス）"
  echo "  2. PATH=$NODE_BIN npm install"
  echo "  3. 乖離の再検証と主要モジュールのロード確認"
  echo "  4. pm2 再起動"
  exit 0
fi

# --- 2. pm2 を停止 ---
APPS="$(echo "$("$NODE_BIN" -e '
const eco = require("./ecosystem.config.js");
console.log((eco.apps || []).filter((a) => a.cwd === process.cwd()).map((a) => a.name).join(" "));
')")"
echo "==> 停止対象: ${APPS:-（なし）}"
STOPPED=""
for app in $APPS; do
  if pm2 pid "$app" >/dev/null 2>&1 && [ "$(pm2 pid "$app" 2>/dev/null | tail -1)" != "0" ]; then
    echo "  stop $app"
    pm2 stop "$app" >/dev/null 2>&1 && STOPPED="$STOPPED $app"
  fi
done

# --- 3. npm install ---
echo "==> npm install（Node $(basename "$(dirname "$NODE_BIN")")）"
export PATH="$(dirname "$NODE_BIN"):$PATH"
if ! npm install 2>&1 | tail -5; then
  echo "[NG] npm install に失敗しました" >&2
  echo "==> 復旧: lockfile を戻して再インストールします" >&2
  (umask 002; git checkout -- package-lock.json) 2>/dev/null || true
  npm install >/dev/null 2>&1 || true
  for app in $STOPPED; do pm2 start ecosystem.config.js --only "$app" --update-env >/dev/null 2>&1 || true; done
  echo "[NG] 復旧を試みましたが、サービスが戻っていない可能性があります" >&2
  exit 1
fi

# --- 4. 検証 ---
echo "==> 乖離の再検証"
DIFF2="$("$NODE_BIN" -e '
const lock = require("./package-lock.json");
const pkgs = process.argv.slice(1);
const out = [];
for (const name of pkgs) {
  const key = "node_modules/" + name;
  const locked = lock.packages && lock.packages[key] && lock.packages[key].version;
  let installed = null;
  try { installed = require("./node_modules/" + name + "/package.json").version; } catch (e) {}
  if (locked && installed && locked !== installed) out.push(`${name}: lock=${locked} installed=${installed}`);
  else if (locked && !installed) out.push(`${name}: lock=${locked} installed=(未インストール)`);
}
console.log(out.join("\n"));
' "${KEY_PACKAGES[@]}")"
if [ -n "$DIFF2" ]; then
  echo "[NG] 更新後も乖離が残っています:" >&2
  echo "$DIFF2" | sed 's/^/  /' >&2
  exit 1
fi
echo "  ✓ node_modules は package-lock.json と一致"

echo "==> 主要モジュールのロード確認"
"$NODE_BIN" -e '
require("sqlite3"); require("bcrypt");
const s = require("sharp"); if (!s.versions.vips) throw new Error("sharp vips なし");
const a = require("firebase-admin"); if (typeof a.messaging !== "function") throw new Error("firebase-admin.messaging なし");
console.log("  ✓ sqlite3 / bcrypt / sharp / firebase-admin");
' || { echo "[NG] モジュールのロードに失敗しました" >&2; exit 1; }

# --- 5. 再起動 ---
echo "==> 再起動"
for app in $STOPPED; do
  pm2 start ecosystem.config.js --only "$app" --update-env >/dev/null 2>&1
  echo "  start $app"
done
pm2 save >/dev/null 2>&1 || true

echo "=== 完了 ==="
