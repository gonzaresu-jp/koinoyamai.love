#!/bin/bash
# verify-php-security-patch.sh — PHP コア RCE (CVE-2026-109618 / CVE-2026-109619) パッチ適用結果の検証
#
# 確認すること:
#   1) 修正CVEが実際に適用されているか（Debian changelog / upstream バージョン）
#   2) 稼働バイナリが更新済みか（パッケージ更新後に再起動し忘れていると旧バイナリが動き続ける）
#   3) php8.3-fpm が稼働しているか（ソケットも）
#   4) サイト（本番 vhost 直叩き・公開URL）が 200 を返すか
#   5) 未追跡 / 怪しい .php が混入していないか（webshell 簡易チェック）
#   6) EOL で未修正の php8.1 などが動いていないか
#
# 判定は fail-closed: 判定できなければ「未修正」扱い（exit 1）。
#
# 使い方: bash scripts/php/verify-php-security-patch.sh
# 終了コード: 0 = 修正済み / 1 = 未修正 or 異常あり
set -uo pipefail

CVE_RE="CVE-2026-10961[89]"
CVE_LIST=("CVE-2026-109618" "CVE-2026-109619")
UPSTREAM_CHANGELOG="https://www.php.net/ChangeLog-8.php"
FPM_SERVICE="php8.3-fpm"
FPM_SOCK="/run/php/php8.3-fpm.sock"
ORIGIN="http://127.0.0.1:1717"
PUBLIC_URL="https://koinoyamai.love"
WEBUI_DIRS=("/var/www/html/koinoyamai.love/webui" "/home/yuzuki/koinoyamai.love-test/webui")

FAIL=0
ok()   { echo "  ✓ $*"; }
ng()   { echo "  ✗ $*"; FAIL=1; }
info() { echo "  - $*"; }

http_code() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || true)"
  echo "${code:-000}"
}
installed_ver() { dpkg-query -W -f='${Version}' php8.3-fpm 2>/dev/null || echo "not-installed"; }
pkg_upstream_ver() { local v; v="$(installed_ver)"; echo "${v#*:}" | sed 's/+.*//; s/-.*//'; }
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
changelog_has_cve() {
  local f
  for f in /usr/share/doc/php8.3-common/changelog.Debian.gz /usr/share/doc/php8.3-fpm/changelog.Debian.gz; do
    [ -r "$f" ] || continue
    if zcat "$f" 2>/dev/null | grep -qE "$CVE_RE"; then return 0; fi
  done
  return 1
}
# upstream の「CVE を含む最小の 8.3.x」を ChangeLog から取得（>= 比較の基準）
upstream_fix_version() {
  local tmp
  tmp="$(mktemp)"
  if curl -fsSL --max-time 60 "$UPSTREAM_CHANGELOG" -o "$tmp" 2>/dev/null; then
    python3 - "$tmp" "${CVE_LIST[@]}" <<'PY' 2>/dev/null
import re, sys
path, cves = sys.argv[1], sys.argv[2:]
s = open(path, encoding='utf-8', errors='replace').read()
secs = re.split(r'<section class="version" id="([0-9.]+)">', s)
pairs = [(secs[i], secs[i+1]) for i in range(1, len(secs)-1, 2)]
vs = [v for v, _ in pairs if v.startswith('8.3.')]
def key(v): return tuple(int(x) for x in v.split('.'))
vs.sort(key=key)
for v in vs:                            # 昇順 = 修正を含む最小版
    if all(c in dict(pairs)[v] for c in cves):
        print(v)
        break
PY
  fi
  rm -f "$tmp"
}

echo "==========================================================="
echo " PHP 緊急パッチ 検証 (${CVE_LIST[0]} / ${CVE_LIST[1]})"
echo "==========================================================="
echo

# --- 1) 修正の適用確認 --------------------------------------------------
echo "--- 1) 修正の適用確認 ---"
INST="$(installed_ver)"
UPV="$(pkg_upstream_ver)"
info "php8.3-fpm パッケージ: ${INST}"
info "upstream バージョン  : ${UPV}"

PATCHED=0
if changelog_has_cve; then
  ok "Debian changelog に ${CVE_LIST[0]}/${CVE_LIST[1]} の記載あり（Ubuntu バックポートで適用済み）"
  PATCHED=1
fi
FIX_VER="$(upstream_fix_version || true)"
if [ -n "$FIX_VER" ]; then
  info "upstream の修正版（最小含有版）: ${FIX_VER}"
  if version_ge "$UPV" "$FIX_VER"; then
    ok "upstream ${UPV} >= ${FIX_VER}（修正を同梱した版）"
    PATCHED=1
  fi
else
  info "upstream の修正版: 未判定（ChangeLog を取得できない、または未リリース）"
fi
if [ "$PATCHED" = "0" ]; then
  ng "修正が検出できません（changelog に CVE 記載なし / upstream ${UPV} が修正版未満）"
  echo "    → 適用: sudo bash scripts/php/apply-php-security-patch.sh --apply"
fi
echo

# --- 2) 稼働バイナリが更新済みか ---------------------------------------
echo "--- 2) 稼働バイナリとパッケージの整合 ---"
FPM_PID="$(pgrep -x php-fpm8.3 2>/dev/null | head -1 || true)"
if [ -n "$FPM_PID" ]; then
  info "稼働 master: PID=${FPM_PID}"
  # (a) root 不要の判定: パッケージのインストール時刻と fpm の起動時刻を比較
  ETIMES="$(ps -o etimes= -p "${FPM_PID}" 2>/dev/null | tr -d ' ' || true)"
  FPM_START=""
  [ -n "${ETIMES:-}" ] && FPM_START="$(( $(date +%s) - ETIMES ))"
  PKG_INST="$(grep -hE "(status installed| install) ${FPM_SERVICE}:" /var/log/dpkg.log 2>/dev/null \
              | tail -1 | awk '{print $1" "$2}' | xargs -I{} date -d "{}" +%s 2>/dev/null || true)"
  if [ -n "$FPM_START" ] && [ -n "$PKG_INST" ]; then
    info "fpm 起動時刻 epoch=${FPM_START} / ${FPM_SERVICE} 導入時刻 epoch=${PKG_INST}"
    if [ "$PKG_INST" -gt "$FPM_START" ]; then
      ng "パッケージ更新が fpm の起動より新しい → 古いバイナリが動作中。sudo systemctl restart ${FPM_SERVICE}"
    else
      ok "fpm はパッケージ更新より後に起動している（バイナリは最新）"
    fi
  else
    info "時刻比較ができません（dpkg.log が読めない等）"
  fi
  # (b) root があれば実行ファイルの実体も確認
  BIN="$(readlink -f "/proc/${FPM_PID}/exe" 2>/dev/null || true)"
  if [ -n "$BIN" ] && [ -e "$BIN" ]; then
    info "実行ファイル: ${BIN}"
    FILE_MTIME="$(stat -c %Y "/usr/sbin/php-fpm8.3" 2>/dev/null || echo 0)"
    BIN_MTIME="$(stat -c %Y "$BIN" 2>/dev/null || echo 0)"
    if [ "$BIN_MTIME" -lt "$FILE_MTIME" ]; then
      ng "実行バイナリがパッケージのファイルより古い: systemctl restart ${FPM_SERVICE}"
    else
      ok "実行バイナリは最新"
    fi
  else
    info "実行ファイルの実体確認は root が必要です（/proc/${FPM_PID}/exe が読めない）"
  fi
else
  ng "php-fpm8.3 の master プロセスが居ません"
fi
echo

# --- 3) fpm の稼働 ------------------------------------------------------
echo "--- 3) php-fpm の稼働 ---"
if systemctl is-active --quiet "$FPM_SERVICE"; then
  ok "$FPM_SERVICE: active"
else
  ng "$FPM_SERVICE: $(systemctl is-active "$FPM_SERVICE" 2>/dev/null || true) （停止している）"
fi
if [ -S "$FPM_SOCK" ]; then
  ok "ソケット: $FPM_SOCK"
else
  ng "ソケットが無い: $FPM_SOCK"
fi
echo

# --- 4) サイトの応答 ----------------------------------------------------
echo "--- 4) サイトの応答 ---"
C1="$(http_code "${ORIGIN}/")"
[ "$C1" = "200" ] && ok "本番 vhost 直叩き ${ORIGIN}/ : HTTP $C1" || ng "本番 vhost 直叩き ${ORIGIN}/ : HTTP $C1"
C2="$(http_code "${PUBLIC_URL}/")"
[ "$C2" = "200" ] && ok "公開 URL ${PUBLIC_URL}/ : HTTP $C2" || ng "公開 URL ${PUBLIC_URL}/ : HTTP $C2"
C3="$(http_code "${ORIGIN}/index.php")"
[ "$C3" = "200" ] && ok "PHP 直実行 ${ORIGIN}/index.php : HTTP $C3" || ng "PHP 直実行 ${ORIGIN}/index.php : HTTP $C3"
echo

# --- 5) webshell 簡易チェック -------------------------------------------
echo "--- 5) .php の混入チェック（webshell 簡易）---"
for D in "${WEBUI_DIRS[@]}"; do
  if [ ! -d "$D" ]; then
    info "$D が無い → スキップ"
    continue
  fi
  echo "  [$D]"
  REPO_ROOT="$(dirname "$D")"
  UNTRACKED="$(cd "$REPO_ROOT" 2>/dev/null && git ls-files --others --exclude-standard -- 'webui/*.php' 2>/dev/null | head -20 || true)"
  if [ -n "$UNTRACKED" ]; then
    ng "git 管理外の .php があります:"
    echo "$UNTRACKED" | sed 's/^/        /'
  else
    ok "git 管理外の .php なし"
  fi
  SUSPICIOUS="$(grep -rlE '(^|[^a-zA-Z_])(eval|assert|base64_decode|shell_exec|passthru|proc_open|popen)[[:space:]]*\(' \
      --include='*.php' "$D" 2>/dev/null | head -10 || true)"
  if [ -n "$SUSPICIOUS" ]; then
    ng "危険な関数呼び出しを含む .php:"
    echo "$SUSPICIOUS" | sed 's/^/        /'
  else
    ok "危険な関数呼び出し（eval/assert/base64_decode/shell_exec 等）はなし"
  fi
done
echo

# --- 6) 未修正の旧 PHP が動いていないか --------------------------------
echo "--- 6) EOL / 未修正 PHP の稼働確認 ---"
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

# --- 7) fpm ログ --------------------------------------------------------
echo "--- 7) php-fpm ログ（直近）---"
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
