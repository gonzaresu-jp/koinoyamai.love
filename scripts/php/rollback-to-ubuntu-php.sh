#!/usr/bin/env bash
# rollback-to-ubuntu-php.sh — PPA（upstream 版）から Ubuntu 公式版へ PHP を戻す
#
# なぜ必要か（2026-10-22 実測）:
#   - 2026-10-21 夜、PHP コア RCE（CVE-2026-109618 / 109619）の upstream 修正版
#     （8.3.36）が Canonical のバックポートを待つ前に、緊急運用として sury PPA から入れた。
#   - その後 **Canonical がバックポートをリリースした**:
#     `php8.3-common 8.3.6-0ubuntu0.24.04.13`（noble-security）に
#     "SECURITY UPDATE: Remote RCE via state corruption issue"（＝CVE-2026-109618/109619）が含まれる。
#   - よって **PPA への依存を解除して Ubuntu 公式版へ戻す**のが正解
#     （第3者 APT リポジトリを恒久依存しない／security pocket の自動更新に戻る）。
#
# ⚠️ 失敗しやすい点:
#   - `apt-get install --only-upgrade php8.3-fpm` は **動かない**。
#     8.3.36 > 8.3.6-0ubuntu0.24.04.13 なので「すでに最新」と判定される（ダウングレード）。
#   - したがって **バージョンを明示**し、`--allow-downgrades` を付ける必要がある。
#   - `/etc/php/8.3/fpm/pool.d/www.conf` と `php.ini` は **dpkg の conffile**。
#     ローカル修正（ハードニング設定）があるため、`DEBIAN_FRONTEND=noninteractive` で
#     「ローカル版を保持」させる（ハードニング設定が消えないように）。
#
# 実行:
#   bash scripts/php/rollback-to-ubuntu-php.sh            # dry-run（root 不要）
#   sudo bash scripts/php/rollback-to-ubuntu-php.sh --apply
#
# 検証:
#   bash scripts/php/verify-php-security-patch.sh   # パッチ状態
#   bash scripts/php/verify-php-hardening.sh        # 実行時ハードニング
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

CVE_RE="CVE-2026-10961[89]"
CVE_LIST=("CVE-2026-109618" "CVE-2026-109619")
PKGS=(php8.3-fpm php8.3-cli php8.3-common php8.3-gd php8.3-opcache php8.3-readline)
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

TMPDIR_="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_"' EXIT

echo "=== PHP を Ubuntu 公式版へ戻す（PPA 依存の解除） ==="

# ---- 現在の状態 ----
CUR_PKG="$(dpkg-query -W -f='${Version}' php8.3-fpm 2>/dev/null || echo '(unknown)')"
CUR_PHP="$(php -v 2>/dev/null | head -1 || echo '(unknown)')"
echo "  現在のバージョン : $CUR_PKG"
echo "  php -v           : $CUR_PHP"

PPA_LIST="$(ls /etc/apt/sources.list.d/ 2>/dev/null | grep -iE 'sury|ondrej|php' || true)"
if [ -n "$PPA_LIST" ]; then
  echo "  PPA の設定       : あり（$PPA_LIST）"
else
  echo "  PPA の設定       : なし（sources.list.d に残存なし）"
fi

# ---- ターゲット（Ubuntu 公式 archive の最新）----
TARGET="$(apt-cache madison php8.3-fpm 2>/dev/null | awk '/security\.ubuntu\.com|noble-security/ {print $3; exit}')"
if [ -z "$TARGET" ]; then
  TARGET="$(apt-cache madison php8.3-fpm 2>/dev/null | awk 'NR==1 {print $3}')"
fi
echo "  ターゲット       : ${TARGET:-(判定不能)}"

if [ -z "$TARGET" ]; then
  echo "[ERR] Ubuntu archive の php8.3-fpm のバージョンを判定できません（apt-get update 済みか確認）" >&2
  exit 1
fi
if [ "$TARGET" = "$CUR_PKG" ]; then
  echo "[OK] すでに Ubuntu 公式版（$TARGET）です。 PPA 依存はありません。戻る必要はありません。"
  exit 0
fi

# ---- ターゲットの changelog に修正CVEがあるか（ダウンロードして確認）----
echo
echo "--- ターゲット版に修正CVEが入っているか確認 ---"
cd "$TMPDIR_"
if ! apt-get download "php8.3-common=$TARGET" >/dev/null 2>&1; then
  echo "[ERR] php8.3-common=$TARGET をダウンロードできませんでした（apt-get update が必要の可能性）" >&2
  exit 1
fi
DEB="$(ls php8.3-common_*.deb 2>/dev/null | head -1)"
[ -n "$DEB" ] || { echo "[ERR] deb が見つかりません" >&2; exit 1; }
mkdir -p x && dpkg-deb -x "$DEB" x 2>/dev/null || true
CHANGELOG="$(find x -name 'changelog.Debian.gz' | head -1)"
if [ -z "$CHANGELOG" ]; then
  echo "[ERR] ターゲット版の changelog を展開できませんでした" >&2
  exit 1
fi
FOUND="$(zcat "$CHANGELOG" | grep -oE "$CVE_RE" | sort -u | tr '\n' ' ')"
cd - >/dev/null
if [ -z "$FOUND" ]; then
  echo "[ERR] ターゲット版 $TARGET の changelog に ${CVE_LIST[0]}/${CVE_LIST[1]} の記載がありません。" >&2
  echo "      この版へ戻すと RCE が再導入されます。戻しません。" >&2
  exit 1
fi
echo "  [OK] $TARGET の changelog に ${FOUND} の記載あり（この版へ戻してよい）"

SPEC=""
for p in "${PKGS[@]}"; do SPEC="$SPEC $p=$TARGET"; done

echo
echo "--- 実行する操作（dry-run）---"
cat <<TXT
  1) sudo rm -f /etc/apt/sources.list.d/php.list     # PPA の設定が残っていれば削除
  2) sudo apt-get update
  3) sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades${SPEC}
     ※ バージョンを明示しない（--only-upgrade だけだと「すでに最新」で動かない）
     ※ conffile（php.ini / pool.d/www.conf）はローカル版を保持する（ハードニング設定が消えない）
  4) sudo systemctl restart php8.3-fpm
  5) bash scripts/php/verify-php-security-patch.sh
     bash scripts/php/verify-php-hardening.sh
TXT

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "--- dry-run: 適用後の手順 ---"
  echo "  sudo bash scripts/php/rollback-to-ubuntu-php.sh --apply"
  exit 0
fi

# ---- 適用 ----
[ "$(id -u)" -eq 0 ] || { echo "[ERR] 適用には root が必要です" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
BAK_DIR="/var/lib/mai-push/php-rollback-${STAMP}"
mkdir -p "$BAK_DIR"
for f in /etc/php/8.3/fpm/php.ini /etc/php/8.3/fpm/pool.d/www.conf /etc/php/8.3/fpm/php-fpm.conf; do
  [ -f "$f" ] && cp -a "$f" "$BAK_DIR/$(basename "$f")" || true
done
echo "[OK] 設定バックアップ: $BAK_DIR"

rm -f /etc/apt/sources.list.d/php.list
apt-get update

echo "==> apt-get install --allow-downgrades"
DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades $SPEC

systemctl restart php8.3-fpm
sleep 2
systemctl is-active php8.3-fpm

echo
echo "--- 適用結果 ---"
dpkg-query -W -f='  ${Package} ${Version}\n' "${PKGS[@]}" 2>/dev/null || true
php -v | head -1
echo
echo "検証: bash scripts/php/verify-php-security-patch.sh && bash scripts/php/verify-php-hardening.sh"
echo "ロールバック（PPA 版へ戻す場合）: バックアップは $BAK_DIR"
