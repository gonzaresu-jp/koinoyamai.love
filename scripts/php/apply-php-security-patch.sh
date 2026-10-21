#!/bin/bash
# apply-php-security-patch.sh — PHP コア RCE (CVE-2026-109618 / CVE-2026-109619) の緊急パッチ適用
#
# 背景（2026-10-21 作成）:
#   PHP セキュリティチームが事前告知した緊急セキュリティリリース。
#     - リリース日時: 2026-10-21 14:00 UTC = JST 23:00
#     - 対象: CVE-2026-109618 / CVE-2026-109619（PHP コアの RCE / CVSS v4.0 = 9.2 Critical）
#     - 影響範囲の報告: PHP 5 以降すべて（公式 advisory の確定はリリース時）
#     - 技術的詳細はリリース時に公開（embargo 中）／in-the-wild 悪用報告はなし
#   出典: php.net の事前告知 / CERT-EU 2026-018 / watchTowr FAQ（2026-10-21 時点）
#
#   本サーバの構成: Ubuntu 24.04 (noble) + php8.3-fpm（php-cgi / apache2 は未導入）。
#   **Ubuntu は upstream の security パッチをバックポートする運用**なので、
#   パッチを当てても `php -v` のバージョン文字列は 8.3.6 のまま（-security リビジョンだけ上がる）。
#   → 適用判定は `php -v` ではなく **Debian changelog に CVE ID が載っているか** で行うこと。
#
# 使い方:
#   bash scripts/php/apply-php-security-patch.sh              # dry-run（既定・root 不要）
#   sudo bash scripts/php/apply-php-security-patch.sh --apply  # 適用（Ubuntu archive に修正がある場合）
#   sudo bash scripts/php/apply-php-security-patch.sh --apply --ppa
#       # Ubuntu に修正がまだ無い場合: ondrej/php PPA で upstream 8.3.34 を入れる
#
# 設計方針:
#   - dry-run / --apply の 2 段（既存の apply-*.sh と同じ流儀）。冪等。
#   - `apt-get upgrade`（全体）はしない。無関係パッケージを巻き込まないよう
#     php8.3-* だけを `--only-upgrade` で上げる。
#   - 適用前のバージョンと apt 状態を /var/lib/mai-push/ に記録し、ロールバック手順を提示。
#   - **Web 公開ツリー（/var/www/html）へは何も書かない**。
#
# 検証: bash scripts/php/verify-php-security-patch.sh
set -euo pipefail

APPLY=0
USE_PPA=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --ppa)   USE_PPA=1 ;;
    -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
    *) echo "error: 不明な引数: $arg（--apply / --ppa のみ）" >&2; exit 1 ;;
  esac
done

CVE_A="CVE-2026-109618"
CVE_B="CVE-2026-109619"
CVE_RE="CVE-2026-10961[89]"
FPM_SERVICE="php8.3-fpm"
FPM_SOCK="/run/php/php8.3-fpm.sock"
ORIGIN="http://127.0.0.1:1717"   # 本番 vhost 直叩き（AGENTS.md §7.1 の ORIGINAL_BASE 相当）
STATE_DIR="/var/lib/mai-push"
PUBLIC_URL="https://koinoyamai.love"

log()  { echo "[$(date '+%F %T')] $*"; }
warn() { echo "  ! $*"; }
die()  { echo "error: $*" >&2; exit 1; }

have_root() { [ "$(id -u)" = "0" ]; }

# --- 現在の状態 ---------------------------------------------------------
installed_ver() { dpkg-query -W -f='${Version}' php8.3-fpm 2>/dev/null || echo "not-installed"; }
# Debian バージョン "epoch:upstream-revision" → upstream 部分だけ
pkg_upstream_ver() { local v; v="$(installed_ver)"; echo "${v#*:}" | sed 's/-.*//'; }
# ※ apt の出力が日本語ロケールだと "Candidate:" が "候補:" になるため LC_ALL=C を固定する
candidate_ver()   { LC_ALL=C apt-cache policy php8.3-fpm 2>/dev/null | awk '/Candidate:/{print $2}'; }
# A >= B （バージョン比較）
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

# --- upstream 側の確認 --------------------------------------------------
upstream_latest_83() {
  curl -fsSL --max-time 25 https://www.php.net/releases/ 2>/dev/null \
    | grep -oE '8\.3\.[0-9]+' | sort -t. -k3 -n | tail -1
}
# リリースページに修正CVEが記載されているか
upstream_release_has_cve() {
  local ver="$1"
  [ -n "$ver" ] || return 1
  curl -fsSL --max-time 25 "https://www/php.net/releases/8_3_${ver//./_}.php" 2>/dev/null \
    | grep -qE "$CVE_RE"
}
# Ubuntu CVE トラッカーの状態（404 = 未登録 = USN 出ていない）
ubuntu_cve_status() {
  local cve="$1" code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://ubuntu.com/security/${cve}" || echo 000)"
  case "$code" in
    200) echo "登録済み（tracker に掲載）" ;;
    404) echo "未登録（Canonical の USN  未発行）" ;;
    *)   echo "判定不能（HTTP ${code}）" ;;
  esac
}
# 適用済み Debian changelog に修正CVEが載っているか
changelog_has_cve() {
  zcat /usr/share/doc/php8.3-common/changelog.Debian.gz 2>/dev/null | grep -qE "$CVE_RE"
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" || echo "000"; }

echo "==========================================================="
echo " PHP 緊急セキュリティパッチ適用 (${CVE_A} / ${CVE_B})"
echo "==========================================================="
echo

# --- 1. 現状 ------------------------------------------------------------
log "1) 現状"
echo "  OS           : $(. /etc/os-release && echo "${PRETTY_NAME}")"
echo "  php8.3-fpm   : $(installed_ver)"
echo "  upstream版   : $(pkg_upstream_ver)"
echo "  php -v       : $(php -v 2>/dev/null | head -1 || echo '（php コマンドなし）')"
echo "  fpm サービス : $(systemctl is-active "$FPM_SERVICE" 2>/dev/null || true) / enabled=$(systemctl is-enabled "$FPM_SERVICE" 2>/dev/null || true)"
echo "  ソケット     : $( [ -S "$FPM_SOCK" ] && echo あり || echo なし )"
echo "  チャンジログ : $(changelog_has_cve && echo '修正CVE記載あり（適用済み）' || echo '修正CVE記載なし（未適用）')"
echo

# --- 2. upstream リリースの確認 ----------------------------------------
log "2) upstream リリース確認"
UP_VER="$(upstream_latest_83 || true)"
if [ -z "$UP_VER" ]; then
  warn "php.net/releases/ を取得できませんでした（php.net が 504 等）。手動確認: https://www.php.net/releases/"
  UP_VER="(不明)"
  UP_HAS_CVE="不明"
else
  echo "  最新 upstream 8.3.x : ${UP_VER}"
  if upstream_release_has_cve "$UP_VER"; then
    UP_HAS_CVE="あり"
    echo "  リリースページ記載   : 修正CVE あり → https://www.php.net/releases/8_3_${UP_VER//./_}.php"
  else
    UP_HAS_CVE="なし"
    warn "リリースページに ${CVE_A}/${CVE_B} の記載が見つかりません（未リリース or ページ未更新）"
  fi
fi
echo

# --- 3. Ubuntu archive / Ubuntu CVE トラッカー --------------------------
log "3) Ubuntu（Canonical）側の状況"
echo "  candidate : $(candidate_ver || echo unknown)"
echo "  ${CVE_A} : $(ubuntu_cve_status "$CVE_A")"
echo "  ${CVE_B} : $(ubuntu_cve_status "$CVE_B")"
echo

# --- 4. 経路判定 --------------------------------------------------------
log "4) 適用経路の判定"
INST="$(installed_ver)"
CAND="$(candidate_ver || echo '')"
USE_ONDREJ=0

if [ "$UP_HAS_CVE" = "あり" ] && [ -n "$CAND" ] && [ "$CAND" != "$INST" ]; then
  echo "  → 経路A: Ubuntu archive に修正が存在（${INST} → ${CAND}）"
elif [ "$USE_PPA" = "1" ]; then
  USE_ONDREJ=1
  echo "  → 経路B: ondrej/php PPA を使う（--ppa 指定）"
elif [ "$UP_HAS_CVE" = "あり" ]; then
  echo "  → 経路B: ondrej/php PPA が必要（Ubuntu archive に修正が無いため）"
  warn "   --ppa を付けると PPA を追加して upstream 版を入れる。"
  warn "   PPA 追加は php8.1 系などの他パッケージに影響しうるため、実行前に --ppa を確認のこと。"
else
  echo "  → 保留: upstream リリースが未確定、または Ubuntu に修正が未投入"
  warn "   23:00（JST）のリリース後に再実行してください。"
fi
echo

if [ "$APPLY" = "0" ]; then
  echo "--- dry-run: 適用後の検証手順 ---"
  cat <<'TXT'
  sudo bash scripts/php/apply-php-security-patch.sh --apply          # Ubuntu archive に修正がある場合
  sudo bash scripts/php/apply-php-security-patch.sh --apply --ppa    # ondrej PPA を使う場合
  bash scripts/php/verify-php-security-patch.sh                      # 適用結果の検証
TXT
  exit 0
fi

# --- 5. 適用 ------------------------------------------------------------
have_root || die "--apply は root が必要です（sudo bash ... --apply で実行）"
log "5) 適用開始"

# 5a. ondrej PPA の追加（必要な場合）
if [ "$USE_ONDREJ" = "1" ]; then
  echo "  - ondrej/php PPA を追加"
  export DEBIAN_FRONTEND=noninteractive
  if [ ! -f /etc/apt/sources.list.d/php-sury.list ]; then
    curl -fsSL --max-time 30 https://packages.sury.org/php/apt.gpg \
      | gpg --dearmor -o /usr/share/keyrings/deb.sury.org-php.gpg
    echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ $(lsb_release -sd) main" \
      > /etc/apt/sources.list.d/php-sury.list
  else
    echo "    （PPA 追加済み）"
  fi
fi

echo "  - apt-get update"
LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get update -qq

# 5b. シミュレーション（何を触るかを先に提示）
PKGS="php8.3-cli php8.3-common php8.3-fpm php8.3-gd php8.3-opcache php8.3-readline"
echo "  - シミュレーション（apt-get -s install --only-upgrade $PKGS）"
LC_ALL=C apt-get -s install --only-upgrade $PKGS 2>&1 \
  | grep -E '^(Inst|Conf|Remv|The following packages|[0-9]+ upgraded)' | sed 's/^/    /' || true

# 5c. ロールバック記録
mkdir -p "$STATE_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
ROLLBACK_FILE="${STATE_DIR}/php-rollback-${STAMP}.txt"
{
  echo "# PHP パッチ適用前記録（${STAMP}）"
  echo "date        : $(date -Is)"
  echo "pkg_version : ${INST}"
  echo "pkg_upstream: $(pkg_upstream_ver)"
  echo "php -v      : $(php -v 2>/dev/null | head -1)"
  echo "apt policy  :"
  LC_ALL=C apt-cache policy php8.3-fpm | sed 's/^/  /'
  echo
  echo "# ロールバック手順:"
  echo "#   sudo apt-get install --only-upgrade php8.3-fpm php8.3-cli php8.3-common php8.3-gd php8.3-opcache php8.3-readline=${INST}"
  echo "#   sudo systemctl restart ${FPM_SERVICE}"
} > "$ROLLBACK_FILE"
echo "  - ロールバック記録: $ROLLBACK_FILE"

# 5d. アップグレード（全体 upgrade はしない）
echo "  - apt-get install --only-upgrade"
LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade $PKGS

# 5e. fpm 再起動
echo "  - systemctl restart ${FPM_SERVICE}"
systemctl restart "$FPM_SERVICE"
for _ in $(seq 1 20); do
  [ -S "$FPM_SOCK" ] && break
  sleep 0.5
done
systemctl is-active --quiet "$FPM_SERVICE" || die "${FPM_SERVICE} が active になりません（ロールバック手順は $ROLLBACK_FILE）"
echo

# --- 6. 適用後の確認 ----------------------------------------------------
log "6) 適用後の確認"
NEW_INST="$(installed_ver)"
echo "  pkg_version : ${INST} → ${NEW_INST}"
echo "  upstream版  : $(pkg_upstream_ver)"
echo "  php -v      : $(php -v 2>/dev/null | head -1)"
echo "  チャンジログ : $(changelog_has_cve && echo '修正CVE記載あり ✓' || echo '修正CVE記載なし（要確認）')"
echo "  fpm         : $(systemctl is-active "$FPM_SERVICE") / socket=$([ -S "$FPM_SOCK" ] && echo あり || echo なし)"
echo "  origin(1717): HTTP $(http_code "${ORIGIN}/")"
echo "  public      : HTTP $(http_code "${PUBLIC_URL}/")"
echo

if [ "$NEW_INST" = "$INST" ]; then
  warn "バージョン文字列が変わっていません（Ubuntu は upstream 版番号を据え置き revise するため当然）。"
  warn "修正の適用は changelog の CVE 記載で判定してください（上記）。"
fi

cat <<TXT

=== 完了 ===
適用記録: $ROLLBACK_FILE
次の検証: bash scripts/php/verify-php-security-patch.sh
監視     : journalctl -u ${FPM_SERVICE} -n 50 --no-pager
TXT
