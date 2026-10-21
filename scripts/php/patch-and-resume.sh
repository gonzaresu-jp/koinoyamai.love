#!/usr/bin/env bash
# patch-and-resume.sh — PHP 緊急パッチを適用し、停止していたサービスを再開する
#
# 目的（2026-10-21）:
#   PHP コアの緊急 RCE（CVE-2026-109618 / CVE-2026-109619・CVSS v4.0 9.2）の
#   修正版が出たあとに、**1コマンドで**
#     1) パッチを適用（php-fpm の再起動を含む）
#     2) **パッチ状態だけ**を検証（サイト応答はメンテナンス解除後にしか 200 にならないため）
#     3) メンテナンスモードを解除（公開ページを再開）
#     4) 停止していた pm2 プロセスを再開（稼働中なら再起動しない）
#     5) 最終確認（サイト / API / 各ポート）
#
# 実行（要 sudo）:
#   sudo bash scripts/php/patch-and-resume.sh              # Ubuntu archive を使う
#   sudo bash scripts/php/patch-and-resume.sh --ppa        # Ubuntu に修正が無い場合（sury）
#   sudo bash scripts/php/patch-and-resume.sh --force      # upstream 判定を飛ばす
#
# 安全性:
#   - どこかで失敗したら、その時点で止まる（patch-and-resume の「_patch適用済みだが
#     メンテナンスのまま_」の状態は 3 段目の前に 만들らない）
#   - pm2 の操作は **yuzuki ユーザーとして**実行する（root の PM2_HOME を作らない）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PM2_USER="${PM2_USER:-yuzuki}"
PM2_HOME_DIR="${PM2_HOME_DIR:-/home/yuzuki/.pm2}"
NODE_BIN="${NODE_BIN:-/home/yuzuki/.nvm/versions/node/v24.22.1/bin/node}"
MAINT_SCRIPT="$REPO_ROOT/scripts/nginx/apply-maintenance.sh"
APPLY_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --ppa|--force) APPLY_ARGS+=("$arg") ;;
    *) echo "error: 不明な引数: $arg（--ppa / --force のみ）" >&2; exit 1 ;;
  esac
done

say() { echo; echo "=== $* ==="; }

[ "$(id -u)" -eq 0 ] || { echo "error: sudo で実行してください" >&2; exit 1; }

# --- 1) PHP パッチ適用 ---------------------------------------------------
say "1) PHP 緊急パッチの適用"
bash "$REPO_ROOT/scripts/php/apply-php-security-patch.sh" --apply ${APPLY_ARGS[@]+"${APPLY_ARGS[@]}"}

# --- 2) パッチ状態の検証（サイト応答はメンテナンス解除後に判定する） ------
say "2) パッチ状態の検証（Debian changelog の CVE 記載）"
if ! bash "$REPO_ROOT/scripts/php/verify-php-security-patch.sh" --patch-only; then
  echo "error: パッチ状態の検証に失敗しました（上の ✗ を確認してください）。" >&2
  echo "       公開ページはメンテナンスのまま維持します（fail-safe）。" >&2
  echo "       よくある原因: php-fpm が再起動されていない → sudo systemctl restart php8.3-fpm" >&2
  exit 1
fi
echo "→ パッチ適用 OK"

# --- 3) メンテナンス解除 -------------------------------------------------
say "3) メンテナンスモードの解除"
if [ -f "$MAINT_SCRIPT" ]; then
  bash "$MAINT_SCRIPT" --off || {
    echo "error: メンテナンス解除に失敗しました（公開ページは 503 のまま）" >&2
    exit 1
  }
else
  echo "[WARN] $MAINT_SCRIPT が見つかりません（手動で解除してください）" >&2
fi

# --- 4) pm2 プロセスの再開 ----------------------------------------------
say "4) pm2 プロセスの再開"
pm2_as_user() {
  runuser -u "$PM2_USER" -- env HOME="/home/$PM2_USER" PM2_HOME="$PM2_HOME_DIR" \
    PATH="$NODE_BIN:$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    pm2 "$@"
}
for name in mai-push-api mai-push-worker discord-bot mai-push-api-test; do
  ST="$(pm2_as_user jlist 2>/dev/null | "$NODE_BIN" -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const a=JSON.parse(s).find(p=>p.name==='$name'); console.log(a?a.pm2_env.status:'absent');}catch(e){console.log('unknown');}
});" 2>/dev/null || echo unknown)"
  if [ "$ST" = "online" ]; then
    echo "  $name: 稼働中 → 再起動しない"
    continue
  fi
  echo "  $name: $ST → 起動"
  pm2_as_user start ecosystem.config.js --only "$name" >/dev/null 2>&1 || echo "    [WARN] $name の起動に失敗" >&2
done
pm2_as_user save >/dev/null 2>&1 && echo "  [OK] pm2 save 完了" || echo "  [WARN] pm2 save に失敗" >&2

# --- 5) 最終確認 ---------------------------------------------------------
say "5) 最終確認"
# 5a) PHP 実行時ハードニングのランタイム検証（存在する場合のみ）
#     ※ プローブは webui に .php を置いて FPM ワーカーの解釈を実測するため、
#       **メンテナンス解除後**に実行する（解除前は 503 が返りプローブが取れない）
HARDEN_VERIFY=""
for cand in "$REPO_ROOT/scripts/php/verify-php-hardening.sh" \
            "/home/yuzuki/koinoyamai.love-test/scripts/php/verify-php-hardening.sh"; do
  [ -f "$cand" ] && { HARDEN_VERIFY="$cand"; break; }
done
if [ -n "$HARDEN_VERIFY" ]; then
  echo "  ハードニングのランタイム検証: $HARDEN_VERIFY"
  bash "$HARDEN_VERIFY" || echo "  [WARN] ハードニングの検証に失敗（上の出力を確認）" >&2
else
  echo "  （ハードニング検証スクリプトが見つからないためスキップ）"
fi
sleep 3
for p in 8080 3002 8081; do
  printf "  自社 %-5s " "$p"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:${p}/" || echo "  (応答なし)"
done
for p in 7080 3131 3333 5000 3100; do
  printf "  他社 %-5s " "$p"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:${p}/" || echo "  (応答なし・意図して止めている場合あり)"
done
printf "  公開   "; curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 15 https://koinoyamai.love/ || echo "(応答なし)"
printf "  PHP    "; curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 10 http://127.0.0.1:1717/index.php || echo "(応答なし)"

cat <<'TXT'

=== 完了 ===
以下を最終確認してください:
  bash scripts/php/verify-php-security-patch.sh
  bash scripts/deploy/assert-port.sh prod && bash scripts/deploy/assert-port.sh staging
  bash scripts/deploy/check-drift.sh

補足:
  - security-watch が Canonical のバックポートを検知したら
    `sudo bash scripts/php/apply-php-security-patch.sh --apply` で追加適用できます。
  - 通知の抜け（停止中の分）はワーカー再開後に遡及検知される分のみです。
TXT
