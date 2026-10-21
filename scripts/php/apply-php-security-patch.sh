#!/bin/bash
# apply-php-security-patch.sh — PHP コア RCE (CVE-2026-109618 / CVE-2026-109619) の緊急パッチ適用
#
# 背景（2026-10-21 作成）:
#   PHP セキュリティチームが事前告知した緊急セキュリティリリース。
#     - リリース日時: 2026-10-21 14:00 UTC = JST 23:00
#     - 対象: CVE-2026-109618 / CVE-2026-109619（PHP コアの RCE / CVSS v4.0 = 9.2 Critical）
#     - 影響範囲の報告: PHP 5 以降すべて（公式 advisory の確定はリリース時）
#     - 技術的詳細はリリース時に公開（embargo 中）／in-the-wild 悪用報告はなし
#   出典: php.net の事前告知 / CERT-EU 2026-018 / watchTowr FAQ
#
#   本サーバの構成: Ubuntu 24.04 (noble) + php8.3-fpm（php-cgi / apache2 は未導入）。
#   **Ubuntu は upstream の security パッチをバックポートする運用**なので、
#   パッチを当てても `php -v` のバージョン文字列は 8.3.6 のまま（-security リビジョンだけ上がる）。
#   → 適用判定は `php -v` ではなく **Debian changelog に CVE ID が載っているか** で行うこと。
#
#   upstream の修正版は **ChangeLog-8.php** から機械判定する
#   （リリース案内ページ releases/8_3_XX.php には CVE ID が載らない・URL も不安定）。
#   判定するのは「CVE を含む**最小**の 8.3.x」（>= 比較の基準になるため）。
#
# 使い方:
#   bash scripts/php/apply-php-security-patch.sh               # dry-run（既定・root 不要）
#   sudo bash scripts/php/apply-php-security-patch.sh --apply   # 適用
#   sudo bash scripts/php/apply-php-security-patch.sh --apply --ppa
#       # Ubuntu archive に修正が無い場合: ondrej/sury PPA で upstream 版を入れる
#   sudo bash scripts/php/apply-php-security-patch.sh --apply --force
#       # upstream の判定（ChangeLog 取得失敗・HTML 構造変化など）を飛ばしたい場合のみ。
#       # Ubuntu に更新が無いときは --ppa が必要（--force はそれ Specifiesれを消さない）。
#
# 設計方針（fail-closed）:
#   - 修正が利用できない場合は **必ず exit 1**。「完了」を出さずに終わる。
#   - 適用済み（changelog に CVE 記載あり）なら何もしない（冪等）。
#   - `apt-get upgrade`（全体）はしない。`php8.3-*` だけを `--only-upgrade` で上げる。
#     シミュレーションに削除(Remv)が出る場合・シミュレーション自体が失敗する場合は中断する。
#   - 適用前のバージョンを /var/lib/mai-push/ に記録し、ロールバック手順を提示。
#   - **Web 公開ツリー（/var/www/html）へは何も書かない**。
#
# 検証: bash scripts/php/verify-php-security-patch.sh
set -euo pipefail

APPLY=0
USE_PPA=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --ppa)   USE_PPA=1 ;;
    --force) FORCE=1 ;;
    -h|--help) awk 'NR>1 && /^#/ {print} NR>1 && !/^#/ {exit}' "$0"; exit 0 ;;
    *) echo "error: 不明な引数: $arg（--apply / --ppa / --force のみ）" >&2; exit 1 ;;
  esac
done

CVE_RE="CVE-2026-10961[89]"
CVE_LIST=("CVE-2026-109618" "CVE-2026-109619")
# upstream 8.3.36 の ChangeLog は **CVE ID ではなく GHSA ID** で記載している
# （2026-10-21 実測: "Core: Fixed GHSA-w8hw-w9fx-j79w , GHSA-6wmf-4rv5-p3rp"）。
# CVE→GHSA の対応表はまだ公開されていない（GitHub Advisory は 404）のため、
# 修正版の判定は **CVE ID と GHSA ID のどちらかを検出**する。
GHSA_LIST=("GHSA-w8hw-w9fx-j79w" "GHSA-6wmf-4rv5-p3rp")
SEC_RE="(CVE-2026-10961[89]|GHSA-w8hw-w9fx-j79w|GHSA-6wmf-4rv5-p3rp)"
UPSTREAM_CHANGELOG="https://www.php.net/ChangeLog-8.php"
FPM_SERVICE="php8.3-fpm"
FPM_SOCK="/run/php/php8.3-fpm.sock"
ORIGIN="http://127.0.0.1:1717"     # 本番 vhost 直叩き（AGENTS.md §7.1 の配信元相当）
PUBLIC_URL="https://koinoyamai.love"
STATE_DIR="/var/lib/mai-push"
SURY_LIST="/etc/apt/sources.list.d/php.list"
SURY_KEYRING_DEB="/tmp/debsuryorg-archive-keyring.deb"

log()  { echo "[$(date '+%F %T')] $*"; }
warn() { echo "  ! $*" >&2; }
die()  { echo "error: $*" >&2; exit 1; }

ROLLBACK_FILE=""
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -n "$ROLLBACK_FILE" ] && [ -f "$ROLLBACK_FILE" ]; then
    echo >&2
    echo "=== 適用に失敗しました。ロールバック手順 ===" >&2
    sed -n '/# ロールバック手順/,$p' "$ROLLBACK_FILE" >&2
  fi
}
trap on_exit EXIT

# --- 状態取得 -----------------------------------------------------------
installed_ver() { dpkg-query -W -f='${Version}' php8.3-fpm 2>/dev/null || echo "not-installed"; }
# Debian バージョン "epoch:upstream-revision" → upstream 部分（sury の "+200" 等を除去）
pkg_upstream_ver() { local v; v="$(installed_ver)"; echo "${v#*:}" | sed 's/+.*//; s/-.*//'; }
# ※ apt の出力が日本語ロケールだと "Candidate:" が "候補:" になるため LC_ALL=C を固定する
candidate_ver()   { LC_ALL=C apt-cache policy php8.3-fpm 2>/dev/null | awk '/Candidate:/{print $2}'; }
# 実際に「導入済み」の php8.3-* のみ（rc 状態・仮想パッケージは除外）
installed_php83_pkgs() {
  dpkg-query -W -f='${Package} ${Version} ${db:Status-Status}\n' 'php8.3-*' 2>/dev/null \
    | awk '$3=="installed" {print $1}'
}
# 各パッケージの現在版（ロールバック用）
pkg_version_of() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null || echo ""; }
# ローカルの Debian changelog に修正CVEが載っているか（Ubuntu バックポート判定）
changelog_has_cve() {
  local f
  for f in /usr/share/doc/php8.3-common/changelog.Debian.gz /usr/share/doc/php8.3-fpm/changelog.Debian.gz; do
    [ -r "$f" ] || continue
    # ⚠️ `zcat | grep -q` は **pipefail + SIGPIPE** で終了コード 141 になり
    #   「CVE 記載なし」と**偽の失敗**になる（CVE が changelog の先頭にある場合）。
    #   zgrep なら grep の終了コードがそのまま返る。
    if zgrep -qE "$CVE_RE" "$f" 2>/dev/null; then return 0; fi
  done
  return 1
}
http_code() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || true)"
  echo "${code:-000}"
}

# --- upstream 判定（ChangeLog-8.php をパース） --------------------------
# 出力形式（KEY=VALUE）:
#   latest_83=<最新8.3.x> fix_83=<CVEを含む最小の8.3.x（無ければ空）>
#   latest_82/fix_82, latest_84/fix_84, latest_85/fix_85
fetch_upstream_info() {
  local tmp rc=1
  tmp="$(mktemp)"
  if curl -fsSL --max-time 60 "$UPSTREAM_CHANGELOG" -o "$tmp" 2>/dev/null; then
    if python3 - "$tmp" "${CVE_LIST[@]}" <<'PY' > "${tmp}.info" 2>/dev/null
import re, sys
path, cves = sys.argv[1], sys.argv[2:]
sec_ids = ['GHSA-w8hw-w9fx-j79w', 'GHSA-6wmf-4rv5-p3rp']
s = open(path, encoding='utf-8', errors='replace').read()
secs = re.split(r'<section class="version" id="([0-9.]+)">', s)
pairs = [(secs[i], secs[i+1]) for i in range(1, len(secs)-1, 2)]
def key(v): return tuple(int(x) for x in v.split('.'))
for series in ('8.2', '8.3', '8.4', '8.5'):
    vs = [v for v, _ in pairs if v.startswith(series + '.')]
    vs.sort(key=key)
    latest = vs[-1] if vs else ''
    fix = ''
    for v in vs:                                # 昇順 = 修正を含む最小版（>= 比較の基準）
        body = dict(pairs)[v]
        if all(c in body for c in cves) or any(g in body for g in sec_ids):
            fix = v
            break
    print(f'latest_{series.replace(".", "")}={latest}')
    print(f'fix_{series.replace(".", "")}={fix}')
PY
    then rc=0; cat "${tmp}.info"; fi
  fi
  rm -f "$tmp" "${tmp}.info"
  return $rc
}

echo "==========================================================="
echo " PHP 緊急セキュリティパッチ適用 (${CVE_LIST[0]} / ${CVE_LIST[1]})"
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
echo "  適用前応答   : origin=$(http_code "${ORIGIN}/") / public=$(http_code "${PUBLIC_URL}/")"
echo

# 適用済みなら何もしない（冪等）
if changelog_has_cve; then
  echo "=== すでに適用済みです。対応不要のため終了します ==="
  exit 0
fi

# --- 2. upstream の修正版を判定 ----------------------------------------
log "2) upstream 修正版の判定（${UPSTREAM_CHANGELOG}）"
UPSTREAM_FIXED=0
if UPSTREAM_INFO="$(fetch_upstream_info)" && [ -n "$UPSTREAM_INFO" ]; then
  eval "$UPSTREAM_INFO"
  echo "  latest upstream 8.3.x : ${latest_83:-不明}"
  if [ -n "${fix_83:-}" ]; then
    echo "  修正を含む upstream 版 : ${fix_83}（${CVE_LIST[0]} / ${CVE_LIST[1]} 記載あり）"
    UPSTREAM_FIXED=1
  else
    echo "  修正を含む upstream 版 : 未検出（ChangeLog に ${CVE_LIST[0]}/${CVE_LIST[1]} の記載なし）"
    UPSTREAM_FIXED=0
  fi
  echo "  参考: 8.2=${latest_82:-?}(fix=${fix_82:-–}) 8.4=${latest_84:-?}(fix=${fix_84:-–}) 8.5=${latest_85:-?}(fix=${fix_85:-–})"
else
  echo "  ! ChangeLog を取得できませんでした（$UPSTREAM_CHANGELOG）"
  echo "  ! 手動確認: https://www.php.net/ChangeLog-8.php"
  UPSTREAM_FIXED=0
fi
echo

# --- 3. Ubuntu（Canonical）側の状況 -------------------------------------
log "3) Ubuntu（Canonical）側の状況"
CAND="$(candidate_ver || true)"
INST="$(installed_ver)"
echo "  installed : ${INST}"
echo "  candidate : ${CAND:-不明}"
for cve in "${CVE_LIST[@]}"; do
  ( code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://ubuntu.com/security/${cve}" 2>/dev/null || true)"
    case "${code:-000}" in
      200) echo "  ${cve} : Ubuntu トラッカー登録済み" ;;
      404) echo "  ${cve} : 未登録（Canonical の USN 未発行）" ;;
      *)   echo "  ${cve} : 判定不能（HTTP ${code:-000}／タイムアウトの可能性。参考情報）" ;;
    esac ) &
done
wait
echo

# --- 4. 適用経路の判定（fail-closed） ----------------------------------
log "4) 適用経路の判定"
ROUTE=""
if [ "$UPSTREAM_FIXED" = "0" ] && [ "$FORCE" = "0" ]; then
  die "upstream の修正版が未リリース、または ChangeLog を取得できませんでした。
     23:00（JST）のリリース後に再実行してください:
       bash scripts/php/apply-php-security-patch.sh            # dry-run
       sudo bash scripts/php/apply-php-security-patch.sh --apply
     （upstream 判定だけを飛ばす場合は --force）"
fi
if [ "$USE_PPA" = "1" ]; then
  ROUTE="ppa"
  echo "  → 経路B: ondrej/sury PPA（--ppa 指定）"
  if [ -n "$CAND" ] && [ "$CAND" != "$INST" ]; then
    warn "Ubuntu archive にも更新（${CAND}）がありますが、--ppa 指定により sury 版に切り替えます。"
  fi
  if [ "$UPSTREAM_FIXED" = "0" ] && [ "$FORCE" = "0" ]; then
    die "upstream の修正版が未リリースです。--ppa で未修正の版を入れることはしない。"
  fi
elif [ -n "$CAND" ] && [ "$CAND" != "$INST" ]; then
  ROUTE="ubuntu"
  echo "  → 経路A: Ubuntu archive に修正が存在（${INST} → ${CAND}）"
else
  die "Ubuntu archive に修正がありません（candidate=${CAND:-不明} = installed=${INST}）。
     選択肢:
       - Canonical の USN が出るまで待つ（unattended-upgrades が自動適用）
       - upstream 版を入れる: sudo bash scripts/php/apply-php-security-patch.sh --apply --ppa
     ※ --force は upstream 判定だけを飛ばすもので、Ubuntu に更新が無ければ適用対象がありません。"
fi
echo

if [ "$APPLY" = "0" ]; then
  echo "--- dry-run: 適用後の検証手順 ---"
  cat <<'TXT'
  sudo bash scripts/php/apply-php-security-patch.sh --apply          # Ubuntu archive に修正がある場合
  sudo bash scripts/php/apply-php-security-patch.sh --apply --ppa    # sury PPA を使う場合
  bash scripts/php/verify-php-security-patch.sh                      # 適用結果の検証
TXT
  exit 0
fi

# --- 5. 適用 ------------------------------------------------------------
[ "$(id -u)" = "0" ] || die "--apply は root が必要です（sudo bash ... --apply で実行）"
log "5) 適用開始"

# 5a. sury PPA の追加（経路B）
if [ "$ROUTE" = "ppa" ]; then
  echo "  - sury PPA を追加（公式手順: packages.sury.org/php/README.txt）"
  export DEBIAN_FRONTEND=noninteractive
  if [ ! -f "$SURY_LIST" ]; then
    curl -fsSL --max-time 60 -o "$SURY_KEYRING_DEB" https://packages.sury.org/debsuryorg-archive-keyring.deb \
      || die "sury の keyring を取得できません"
    dpkg -i "$SURY_KEYRING_DEB" >/dev/null || die "sury keyring の導入に失敗しました"
    echo "deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" \
      > "$SURY_LIST"
  else
    echo "    （PPA 追加済み）"
  fi
fi

echo "  - apt-get update"
if ! LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get update -qq; then
  warn "apt-get update が失敗しました（third-party repo の不具合の可能性）。続行して candidate を確認します。"
  if [ "$ROUTE" = "ppa" ]; then
    warn "sury の sources.list を削除して apt の状態を復旧します。"
    rm -f "$SURY_LIST"
    LC_ALL=C apt-get update -qq || warn "（apt-get update は依然失敗）"
    die "sury PPA の追加に失敗しました（sources.list は削除済み）。"
  fi
fi

CAND="$(candidate_ver || true)"
[ -n "$CAND" ] || die "candidate を取得できません"
if [ "$CAND" = "$INST" ]; then
  die "candidate が installed と同じ（${CAND}）。修正が配布されていないか apt の更新に失敗しています。"
fi

# 5b. シミュレーション（失敗したら中断・削除が絡むなら中断）
PKGS="$(installed_php83_pkgs | tr '\n' ' ')"
PKGS="${PKGS% }"
[ -n "$PKGS" ] || die "導入済みの php8.3-* パッケージが見つかりません"
echo "  - 対象パッケージ: ${PKGS}"
echo "  - シミュレーション（apt-get -s install --only-upgrade）"
if ! SIM="$(LC_ALL=C apt-get -s install --only-upgrade $PKGS 2>&1)"; then
  echo "$SIM" | sed 's/^/    /' >&2
  die "シミュレーションが失敗しました（安全ゲートのため中止します）"
fi
echo "$SIM" | grep -E '^(Inst|Conf|Remv|The following packages|[0-9]+ upgraded)' | sed 's/^/    /' || true
if echo "$SIM" | grep -q '^Remv'; then
  die "シミュレーションでパッケージの削除（Remv）が検出されました。適用を中止します。"
fi

# 5c. ロールバック記録（0600 で作成）
mkdir -p "$STATE_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
ROLLBACK_FILE="${STATE_DIR}/php-rollback-${STAMP}.txt"
ROLLBACK_SPEC=""
for p in $PKGS; do ROLLBACK_SPEC="${ROLLBACK_SPEC} ${p}=$(pkg_version_of "$p")"; done
ROLLBACK_SPEC="${ROLLBACK_SPEC# }"
( umask 077
  {
    echo "# PHP パッチ適用前記録（${STAMP}）"
    echo "date        : $(date -Is)"
    echo "pkg_version : ${INST}"
    echo "pkg_upstream: $(pkg_upstream_ver)"
    echo "php -v      : $(php -v 2>/dev/null | head -1)"
    echo "packages    : ${PKGS}"
    echo "apt policy  :"
    LC_ALL=C apt-cache policy php8.3-fpm | sed 's/^/  /'
    echo
    echo "# ロールバック手順:"
    echo "#   1) 旧版は noble-updates 等に残っている場合がある。dpkg の exact 依存"
    echo "#      （php8.3-common (= 同版)）のため、**全パッケージを同版で指定**すること。"
    echo "#      ダウングレードになるので --allow-downgrades が必要:"
    echo "#      sudo apt-get update"
    echo "#      sudo apt-get install -y --allow-downgrades ${ROLLBACK_SPEC}"
    echo "#      sudo systemctl restart ${FPM_SERVICE}"
    echo "#   2) 旧版が archive から消えている場合はロールバック不可（apt-cache policy で確認）"
    echo "#   3) sury PPA を使った場合は PPA の削除も検討:"
    echo "#      sudo rm -f ${SURY_LIST} && sudo apt-get update"
  } > "$ROLLBACK_FILE"
)
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
systemctl is-active --quiet "$FPM_SERVICE" || die "${FPM_SERVICE} が active になりません"

# 孤児 php-fpm の掃除（テスト残骸など。親が init=1 で、systemd の MainPID でない master のみ）
MAIN_PID="$(systemctl show "$FPM_SERVICE" -p MainPID --value 2>/dev/null || true)"
ORPHANS=0
if [ -n "$MAIN_PID" ] && [ "$MAIN_PID" != "0" ]; then
  for pid in $(pgrep -x php-fpm8.3 2>/dev/null || true); do
    [ "$pid" = "$MAIN_PID" ] && continue
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ "$ppid" = "1" ] || continue
    kill "$pid" 2>/dev/null && ORPHANS=$((ORPHANS+1))
  done
  [ "$ORPHANS" -gt 0 ] && echo "  [OK] 孤児の php-fpm を ${ORPHANS} 件停止しました"
fi
echo

# --- 6. 適用後の確認（fail-closed） -------------------------------------
log "6) 適用後の確認"
NEW_INST="$(installed_ver)"
ORIG_CODE="$(http_code "${ORIGIN}/")"
PUB_CODE="$(http_code "${PUBLIC_URL}/")"
echo "  pkg_version : ${INST} → ${NEW_INST}"
echo "  upstream版  : $(pkg_upstream_ver)"
echo "  php -v      : $(php -v 2>/dev/null | head -1)"
echo "  チャンジログ : $(changelog_has_cve && echo '修正CVE記載あり ✓' || echo '修正CVE記載なし ✗')"
echo "  fpm         : $(systemctl is-active "$FPM_SERVICE") / socket=$([ -S "$FPM_SOCK" ] && echo あり || echo なし)"
echo "  origin(1717): HTTP ${ORIG_CODE}"
echo "  public      : HTTP ${PUB_CODE}"
echo

FAILED=0
changelog_has_cve || { warn "changelog に修正CVEの記載がありません（Ubuntu バックポートの反映漏れの可能性）"; FAILED=1; }
# メンテナンスモード中は公開ページが 503 になる（仕様）。
# その場合は 503 も正常応答として扱う（さもないと適用が成功しても exit 1 になる）。
MAINT_ON=0
if grep -q "snippets/maintenance.conf" /etc/nginx/nginx.conf 2>/dev/null; then MAINT_ON=1; fi
if [ "$MAINT_ON" = "1" ]; then
  echo "  メンテナンスモード ON のため、公開ページの 503 は正常として扱います"
  [ "$ORIG_CODE" = "200" ] || [ "$ORIG_CODE" = "503" ] || { warn "本番 vhost が 200/503 ではありません（HTTP ${ORIG_CODE}）"; FAILED=1; }
  [ "$PUB_CODE" = "200" ] || [ "$PUB_CODE" = "503" ] || { warn "公開 URL が 200/503 ではありません（HTTP ${PUB_CODE}）"; FAILED=1; }
else
  [ "$ORIG_CODE" = "200" ] || { warn "本番 vhost が 200 ではありません（HTTP ${ORIG_CODE}）"; FAILED=1; }
  [ "$PUB_CODE" = "200" ] || { warn "公開 URL が 200 ではありません（HTTP ${PUB_CODE}）"; FAILED=1; }
fi

if [ "$FAILED" != "0" ]; then
  die "適用後の検証で問題が見つかりました。ロールバックを検討してください（記録: $ROLLBACK_FILE）"
fi

cat <<TXT

=== 完了 ===
適用記録: $ROLLBACK_FILE
次の検証: bash scripts/php/verify-php-security-patch.sh
監視     : journalctl -u ${FPM_SERVICE} -n 50 --no-pager
TXT
