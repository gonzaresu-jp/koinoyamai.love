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

# 乖離判定は scripts/deploy/check-node-modules-drift.js（全パッケージ比較）に委譲する。
# 2026-10-24 実測: 以前は監視対象が固定 9 個だったため、body-parser 2.3.0→2.4.0 /
# 入れ子 undici 6.28.1→6.29.1 / qs 6.16.0→6.16.1 の更新を「乖離なし」と誤判定し、
# install をスキップした（lockfile だけ新しく実体は脆弱なまま＝偽の安全感）。
# ヘルパは「このスクリプトの隣」から解決する（cwd は $ROOT のままなので lockfile は $ROOT を読む）。
# $ROOT 相対にすると、pull 前のツリーで MODULE_NOT_FOUND のスタックトレースになり
# 「lockfile が読めない」と誤読される（2026-10-24 レビュー指摘）。
DRIFT_CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-node-modules-drift.js"

cd "$ROOT" || { echo "error: $ROOT に移動できません" >&2; exit 1; }
[ -x "$NODE_BIN" ] || { echo "error: node が見つかりません: $NODE_BIN" >&2; exit 1; }
[ -f package-lock.json ] || { echo "error: package-lock.json がありません" >&2; exit 1; }
[ -f "$DRIFT_CHECK" ] || { echo "error: 乖離チェックのヘルパが見つかりません: $DRIFT_CHECK" >&2; exit 1; }

echo "=== node_modules の同期（$ROOT） ==="

# --- 1. 乖離検出（全パッケージ） ---
# exit 0=乖離なし / 10=乖離あり / 1=判定不能。判定不能は「正常」に倒さない（fail-closed）。
DIFF_OUT=""
set +e
DIFF_OUT="$("$NODE_BIN" "$DRIFT_CHECK")"
DRIFT_RC=$?
set -e
if [ "$DRIFT_RC" -ne 0 ] && [ "$DRIFT_RC" -ne 10 ]; then
  echo "[NG] 乖離チェック自体に失敗しました（lockfile を読めない等）。install も再起動も行いません。" >&2
  exit 1
fi

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

# 停止した後は「どのステップで失敗しても必ず再起動する」。
# 2026-10-23 実測: 検証ステップ（下のロード確認）が exit 1 したとき、
# 再起動の前にスクリプトが終了して **本番 3 プロセスが止まったまま**になった。
# trap を EXIT に掛けることで、検証失敗・構文エラー・中断（Ctrl+C）でも復旧する。
restore_pm2() {
  local st=$?
  if [ -n "${STOPPED:-}" ]; then
    echo "==> 復旧: 停止していたアプリを再起動します（exit=$st）" >&2
    for app in $STOPPED; do
      pm2 start ecosystem.config.js --only "$app" --update-env >/dev/null 2>&1 || true
    done
    pm2 save >/dev/null 2>&1 || true
    STOPPED=""
  fi
  exit "$st"
}
trap restore_pm2 EXIT

# --- 3. npm install ---
echo "==> npm install（Node $(basename "$(dirname "$NODE_BIN")")）"
export PATH="$(dirname "$NODE_BIN"):$PATH"
if ! npm install 2>&1 | tail -5; then
  echo "[NG] npm install に失敗しました" >&2
  echo "==> 復旧: lockfile を戻して再インストールします（再起動は EXIT の trap が行います）" >&2
  (umask 002; git checkout -- package-lock.json) 2>/dev/null || true
  npm install >/dev/null 2>&1 || true
  exit 1
fi

# --- 4. 検証 ---
echo "==> 乖離の再検証（全パッケージ）"
DIFF2=""
set +e
DIFF2="$("$NODE_BIN" "$DRIFT_CHECK")"
DRIFT2_RC=$?
set -e
if [ "$DRIFT2_RC" -ne 0 ]; then
  echo "[NG] 更新後も乖離が残っています（または判定不能）:" >&2
  [ -n "$DIFF2" ] && echo "$DIFF2" | sed 's/^/  /' >&2
  exit 1
fi
echo "  ✓ node_modules は package-lock.json と一致"

echo "==> 主要モジュールのロード確認"
# firebase-admin v14 は名前空間 API（admin.messaging）を廃止している。
# ここを旧 API のままにしておくと、更新完了後に必ず exit 1 になる
# （2026-10-23 実測: 本番が停止したまま再起動されなかった）。
# puppeteer は v25 が ESM のみなので、require できる＝Node の版が仕様を満たす確認を兼ねる。
"$NODE_BIN" -e '
require("sqlite3"); require("bcrypt");
const s = require("sharp"); if (!s.versions.vips) throw new Error("sharp vips なし");
const fa = require("firebase-admin/app");
if (typeof fa.initializeApp !== "function") throw new Error("firebase-admin/app.initializeApp なし");
if (typeof fa.getApps !== "function") throw new Error("firebase-admin/app.getApps なし");
if (typeof fa.cert !== "function") throw new Error("firebase-admin/app.cert なし");
const fm = require("firebase-admin/messaging");
if (typeof fm.getMessaging !== "function") throw new Error("firebase-admin/messaging.getMessaging なし");
const p = require("puppeteer"); if (typeof p.launch !== "function") throw new Error("puppeteer.launch なし");
console.log("  ✓ sqlite3 / bcrypt / sharp / firebase-admin(app+messaging) / puppeteer");
' || { echo "[NG] モジュールのロードに失敗しました" >&2; exit 1; }

# --- 5. 再起動 ---
echo "==> 再起動"
for app in $STOPPED; do
  pm2 start ecosystem.config.js --only "$app" --update-env >/dev/null 2>&1
  echo "  start $app"
done
pm2 save >/dev/null 2>&1 || true
STOPPED=""   # 再起動済み。trap に二重起動させない

echo "=== 完了 ==="
