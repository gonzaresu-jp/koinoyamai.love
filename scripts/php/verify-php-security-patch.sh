#!/bin/bash
# verify-php-security-patch.sh — PHP コア RCE (CVE-2026-109618 / CVE-2026-109619) パッチ適用結果の検証
#
# 確認すること:
#   1) 修正CVEが実際に適用されているか（Debian changelog / upstream バージョン）
#   2) php8.3-fpm が稼働しているか（ソケットも）
#   3) サイト（本番 vhost 直叩き・公開URL）が 200 を返すか
#   4) 未追跡の .php が混入していないか（webshell 简易チェック）
#   5) EOL で未修正の php8.1 などが動いていないか
#
# 使い方: bash scripts/php/verify-php-security-patch.sh
# 終了コード: 0 = 修正済み / 1 = 未修正 or 異常あり
set -uo pipefail

CVE_RE="CVE-2026-10961[89]"
FIX_MIN_83="8.3.34"      # 修正を含む最初の upstream 8.3 系
FPM_SERVICE="php8.3-fpm"
FPM_SOCK="/run/php/php8.3-fpm.sock"
ORIGIN="http://127.0.0.1:1717"
PUBLIC_URL="https://koinoyamai.love"
PROD_WEBUI="/var/www/html/koinoyamai.love/webui"

FAIL=0
ok()   { echo "  ✓ $*"; }
ng()   { echo "  ✗ $*"; FAIL=1; }
info() { echo "  - $*"; }

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" || echo "000"; }

echo "==========================================================="
echo " PHP 緊急パッチ 検証 (${CVE_RE})"
echo "==========================================================="
echo

# --- 1) 修正の適用確認 --------------------------------------------------
echo "--- 1) 修正の適用確認 ---"
INST="$(dpkg-query -W -f='${Version}' php8.3-fpm 2>/dev/null || echo 'not-installed')"
UPV="$(echo "${INST#*:}" | sed 's/-.*//')"
info "php8.3-fpm パッケージ: ${INST}"
info "upstream バージョン  : ${UPV}"

CHANGED=0
if zcat /usr/share/doc/php8.3-common/changelog.Debian.gz 2>/dev/null | grep -qE "$CVE_RE"; then
  ok "Debian changelog に ${CVE_RE} の記載あり（Ubuntu バックポートで適用済み）"
  CHANGED=1
fi
# upstream 版が修正を同梱した版以上なら（ondrej PPA 経由など）
if [ "$UPV" != "${INST}" ] && [ "$(printf '%s\n%s\n' "$FIX_MIN_83" "$UPV" | sort -V | head -1)" = "$FIX_MIN_83" ]; then
  ok "upstream ${UPV} >= ${FIX_MIN_83}（修正を同梱した版）"
  CHANGED=1
fi
if [ "$CHANGED" = "0" ]; then
  ng "修正が検出できません（changelog に CVE 記載なし / upstream ${UPV} < ${FIX_MIN_83}）"
  echo "    → 適用: sudo bash scripts/php/apply-php-security-patch.sh --apply"
fi
echo

# --- 2) fpm の稼働 ------------------------------------------------------
echo "--- 2) php-fpm の稼働 ---"
if systemctl is-active --quiet "$FPM_SERVICE"; then
  ok "$FPM_SERVICE: active"
else
  ng "$FPM_SERVICE: $(systemctl is-active "$FPM_SERVICE" 2>/dev/null) （停止している）"
fi
if [ -S "$FPM_SOCK" ]; then
  ok "ソケット: $FPM_SOCK"
else
  ng "ソケットが無い: $FPM_SOCK"
fi
echo

# --- 3) サイトの応答 ----------------------------------------------------
echo "--- 3) サイトの応答 ---"
C1="$(http_code "${ORIGIN}/")"
[ "$C1" = "200" ] && ok "本番 vhost 直叩き ${ORIGIN}/ : HTTP $C1" || ng "本番 vhost 直叩き ${ORIGIN}/ : HTTP $C1"
C2="$(http_code "${PUBLIC_URL}/")"
[ "$C2" = "200" ] && ok "公開 URL ${PUBLIC_URL}/ : HTTP $C2" || ng "公開 URL ${PUBLIC_URL}/ : HTTP $C2"
C3="$(http_code "${ORIGIN}/index.php")"
[ "$C3" = "200" ] && ok "PHP 直実行 ${ORIGIN}/index.php : HTTP $C3" || ng "PHP 直実行 ${ORIGIN}/index.php : HTTP $C3"
echo

# --- 4) webshell 简易チェック -------------------------------------------
echo "--- 4) 未追跡 .php の混入チェック（webshell 简易）---"
if [ -d "$PROD_WEBUI" ]; then
  UNTRACKED="$(cd /var/www/html/koinoyamai.love 2>/dev/null && git ls-files --others --exclude-standard -- 'webui/*.php' 2>/dev/null | head -20 || true)"
  if [ -n "$UNTRACKED" ]; then
    ng "git 管理外の .php があります:"
    echo "$UNTRACKED" | sed 's/^/      /'
  else
    ok "git 管理外の .php なし"
  fi
  RECENT="$(find "$PROD_WEBUI" -maxdepth 2 -name '*.php' -mtime -2 2>/dev/null | head -10 || true)"
  if [ -n "$RECENT" ]; then
    info "過去48時間に更新された .php（要目視）:"
    echo "$RECENT" | sed 's/^/      /'
  else
    ok "過去48時間に更新された .php なし"
  fi
else
  info "$PROD_WEBUI が無い（本番ツリー未配置？）→ スキップ"
fi
echo

# --- 5) 未修正の旧 PHP が動いていないか --------------------------------
echo "--- 5) EOL / 未修正 PHP の稼働確認 ---"
for svc in php8.1-fpm php8.2-fpm php7.4-fpm php5.6-fpm; do
  if systemctl list-unit-files "${svc}.service" --no-legend 2>/dev/null | grep -q .; then
    ST="$(systemctl is-active "$svc" 2>/dev/null || true)"
    EN="$(systemctl is-enabled "$svc" 2>/dev/null || true)"
    if [ "$ST" = "active" ]; then
      ng "$svc が active（upstream 未サポート版は修正不能）: state=$ST enabled=$EN"
    else
      ok "$svc: 停止済み（state=$ST / enabled=$EN）"
    fi
  fi
done
echo

# --- 6) fpm ログ --------------------------------------------------------
echo "--- 6) php-fpm ログ（直近）---"
if [ -r /var/log/php8.3-fpm.log ]; then
  tail -5 /var/log/php8.3-fpm.log | sed 's/^/    /'
else
  info "/var/log/php8.3-fpm.log を読み取れません（要 root）"
fi
echo

echo "=== 判定 ==="
if [ "$FAIL" = "0" ]; then
  echo "✓ PHP 緊急パッチは適用済み。サービスは正常。"
  exit 0
else
  echo "✗ 異常があります。上の ✗ の項目を確認してください。"
  exit 1
fi
