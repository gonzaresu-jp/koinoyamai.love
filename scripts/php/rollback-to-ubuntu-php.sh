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
#   - 設定ファイルの保持（実測 2026-10-22）:
#       `/etc/php/8.3/fpm/pool.d/www.conf` = **dpkg の conffile**
#         → `-o Dpkg::Options::="--force-confold"` でローカル版を保持
#       `/etc/php/8.3/fpm/php.ini`        = **ucf 管理**（`/var/lib/ucf/registry`）
#         → `--force-confold` は効かない。**`UCF_FORCE_CONFFOLD=1`** を併せて渡す
#         → さらに降格後に `apply-php-hardening.sh --apply` でハードニングを**再適用**する
#            （ucf が php.ini を置換していた場合の保険）
#
# 実行:
#   bash scripts/php/rollback-to-ubuntu-php.sh            # dry-run（root 不要）
#   sudo bash scripts/php/rollback-to-ubuntu-php.sh --apply
#
# 検証:
#   bash scripts/php/verify-php-security-patch.sh   # パッチ状態
#   bash scripts/php/verify-php-hardening.sh        # 実行時ハードニング
# `-E`（errtrace）: 関数内・管道内でも ERR trap を発火させる。
# なお `cmd || { echo ...; exit 1; }` 形式の exit は**コマンド失敗ではない**ため
# ERR trap は発火しない（設定の復元が走らない）。そのため該当箇所は
# `on_error` を**明示的に呼ぶ**（N-1 対応）。
set -Eeuo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

CVE_RE="CVE-2026-10961[89]"
CVE_LIST=("CVE-2026-109618" "CVE-2026-109619")
# ⚠️ `php8.3`（メタ）と `libapache2-mod-php8.3` も**必ず一緒に**指定する。
#    libapache2-mod-php8.3 は php8.3-common を exact pin しており、
#    これを外すと apt が「削除」で解決してしまう（実測: 削除 2 件）。
#    ただし**未導入の環境**では `=VERSION` 指定で新規導入-pool ”。よって導入済み判定する。
PKGS=(php8.3 php8.3-fpm php8.3-cli php8.3-common php8.3-gd php8.3-opcache php8.3-readline)
if dpkg-query -W -f='${Status}' libapache2-mod-php8.3 2>/dev/null | grep -q "install ok installed"; then
  PKGS+=(libapache2-mod-php8.3)
fi
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# テスト用に差し替え可能にする（既定は実パス）
APT_SOURCES_DIR="${APT_SOURCES_DIR:-/etc/apt/sources.list.d}"

TMPDIR_="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_"' EXIT

echo "=== PHP を Ubuntu 公式版へ戻す（PPA 依存の解除） ==="

# ---- 現在の状態 ----
CUR_PKG="$(dpkg-query -W -f='${Version}' php8.3-fpm 2>/dev/null || echo '(unknown)')"
CUR_PHP="$(php -v 2>/dev/null | head -1 || echo '(unknown)')"
echo "  現在のバージョン : $CUR_PKG"
echo "  php -v           : $CUR_PHP"

# PPA 検出は **ファイル名ではなく内容**で行う（`php-*` 等の無関係な
# third-party/universe リストまで rm しないため）。
find_ppa_files() {
  local f
  for f in "$APT_SOURCES_DIR"/*; do
    [ -f "$f" ] || continue
    if grep -qiE 'packages\.sury\.org|ppa\.launchpadcontent\.net/ondrej' "$f" 2>/dev/null; then
      basename "$f"
    fi
  done
}
PPA_LIST="$(find_ppa_files || true)"
if [ -n "$PPA_LIST" ]; then
  echo "  PPA の設定       : あり（$PPA_LIST）"
else
  echo "  PPA の設定       : なし（sources.list.d に残存なし）"
fi

# ---- ターゲット（Ubuntu 公式 archive の最新）----
# ※ フォールバックで「1 行目」を使わないこと。sury の行が 1 行目にあると
#    **sury 版を Ubuntu 版と誤認して「戻す必要なし」と exit 0** になる（fail-open）。
TARGET="$(apt-cache madison php8.3-fpm 2>/dev/null | awk '/security\.ubuntu\.com|noble-security/ {print $3; exit}')"
echo "  ターゲット       : ${TARGET:-(判定不能)}"

if [ -z "$TARGET" ]; then
  echo "[ERR] noble-security の php8.3-fpm のバージョンを判定できません（apt-get update 済みか確認）" >&2
  echo "      判定できない場合は勝手に進めない（fail-closed）" >&2
  exit 1
fi
# 既に Ubuntu 公式版か？ → **全パッケージ**で確認する（fpm だけだと混在状態を素通りする）
ALREADY_UBUNTU=1
for p in "${PKGS[@]}"; do
  v="$(dpkg-query -W -f='${Version}' "$p" 2>/dev/null || echo '(none)')"
  [ "$v" = "$TARGET" ] || ALREADY_UBUNTU=0
done
if [ "$ALREADY_UBUNTU" = "1" ]; then
  if [ -n "$PPA_LIST" ]; then
    # パッケージは Ubuntu 公式版なのに **PPA の設定だけ残存**している。
    # 残置すると次の `apt-get update` で sury 版へ乗り戻るため、
    # 「PPA 依存はない」とは言えない＝除去してから終わる。
    echo "[要対応] PHP パッケージは Ubuntu 公式版（$TARGET）ですが、**PPA の設定が残存**しています: $PPA_LIST"
    echo "          残置すると次の apt-get update で sury 版へ乗り戻る可能性があります。"
    if [ "$APPLY" = "0" ]; then
      echo
      echo "--- dry-run: 適用後の手順 ---"
      echo "  sudo bash $(basename "$0") --apply   # PPA 設定のみ除去する（パッケージの降格は発生しません）"
      exit 0
    fi
    [ "$(id -u)" -eq 0 ] || { echo "[ERR] 適用には root が必要です" >&2; exit 1; }
    STAMP="$(date +%Y%m%d-%H%M%S)"
    BAK_DIR="/var/lib/mai-push/php-rollback-${STAMP}"
    mkdir -p "$BAK_DIR"
    for l in $PPA_LIST; do
      cp -a "$APT_SOURCES_DIR/$l" "$BAK_DIR/apt-$l" 2>/dev/null || true
    done
    echo "==> PPA 設定の除去（パッケージ降格は不要）"
    for l in $PPA_LIST; do
      rm -f "$APT_SOURCES_DIR/$l"
      echo "  除去: $APT_SOURCES_DIR/$l"
    done
    retire_sury_keyring "$BAK_DIR"
    apt-get update || true
    echo "[OK] PPA 設定を除去しました（PHP パッケージは Ubuntu 公式版のまま）"
    exit 0
  fi
  echo "[OK] 既に全パッケージが Ubuntu 公式版（$TARGET）です。PPA 依存はありません。"
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
# ※ `set -e` + `pipefail` により、判定コマンドが非 0 で終わると
#   **この先の診断メッセージに到達できない**（スクリプトが無言で死ぬ）。
#   そのため「抽出」は必ず `|| true` で守护し、判定は明示的に行う。
DEB=""
for f in php8.3-common_*.deb; do
  if [ -f "$f" ]; then DEB="$f"; break; fi
done
[ -n "$DEB" ] || { echo "[ERR] deb が見つかりません（apt-get download の出力を確認）" >&2; exit 1; }
mkdir -p x && dpkg-deb -x "$DEB" x 2>/dev/null || true
# `find ... | head -1` は SIGPIPE で壊れることがあるため -print -quit を使う
CHANGELOG="$(find x -name 'changelog.Debian.gz' -print -quit 2>/dev/null || true)"
if [ -z "$CHANGELOG" ]; then
  echo "[ERR] ターゲット版の changelog を展開できませんでした" >&2
  exit 1
fi
FOUND="$(zcat "$CHANGELOG" 2>/dev/null | grep -oE "$CVE_RE" | sort -u | tr '\n' ' ' || true)"
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
  1) 検出した PPA 設定を除去（下記「PPA の設定」欄のファイルだけ）
     ※ 固定名ではなく「内容（sury / ondrej の URI）」で検出したものを除去する
  2) sudo apt-get update
  3) sudo DEBIAN_FRONTEND=noninteractive UCF_FORCE_CONFFOLD=1 \
       apt-get install -y -o Dpkg::Options::="--force-confold" --allow-downgrades${SPEC}
     ※ バージョンを明示しない（--only-upgrade だけだと「すでに最新」で動かない）
     ※ pool.d/www.conf は dpkg conffile（--force-confold）／php.ini は ucf 管理（UCF_FORCE_CONFFOLD）
     ※ 降格後に apply-php-hardening.sh --apply でハードニングを再適用する
  4) bash scripts/php/apply-php-hardening.sh --apply   # ハードニングの再適用（php.ini 保険）
  5) sudo systemctl restart php8.3-fpm
  6) sury のキーリング退置（/etc/apt/trusted.gpg.d と keyring パッケージの purge）
  7) bash scripts/php/verify-php-security-patch.sh
     bash scripts/php/verify-php-hardening.sh
TXT

# --- 実際の解決結果のシミュレーション（削除パッケージが出たら止める）---
echo
echo "--- apt の解決結果（シミュレーション）---"
SIM="$(apt-get -s install -y --allow-downgrades $SPEC 2>&1 || true)"
REMOVED="$(echo "$SIM" | grep -c '^Remv' || true)"
echo "$SIM" | grep -E '^(Inst|Remv|Conf)|ダウングレード|削除' | sed 's/^/    /' || true
if [ "${REMOVED:-0}" -gt 0 ]; then
  echo "[ERR] シミュレーションで ${REMOVED} 件の削除が出ました。パッケージ構成を修正するまで適用しません（fail-closed）" >&2
  exit 1
fi
echo "    [OK] 削除 0 件"

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

# --- 失敗時の復旧（trap）---
# apt が php8.3-common を unpack 済み・php8.3-fpm が half-configured の状態で
# 止まると PHP が壊れるため、失敗時は必ず復旧手順を実行して exit 1 する。
PPA_REMOVED_LIST=""
on_error() {
  local rc=$?
  echo >&2
  echo "[ERR] ロールバックが失敗しました（rc=${rc}）。復旧を試します" >&2
  dpkg --configure -a >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet php8.3-fpm; then
    systemctl restart php8.3-fpm >/dev/null 2>&1 || true
  fi
  for f in php.ini www.conf php-fpm.conf; do
    src=""
    case "$f" in
      php.ini)      src="/etc/php/8.3/fpm/php.ini" ;;
      www.conf)     src="/etc/php/8.3/fpm/pool.d/www.conf" ;;
      php-fpm.conf) src="/etc/php/8.3/fpm/php-fpm.conf" ;;
    esac
    [ -f "$BAK_DIR/$f" ] && [ -f "$src" ] && cp -a "$BAK_DIR/$f" "$src"
  done
  systemctl restart php8.3-fpm >/dev/null 2>&1 || true
  # ※ PPA 設定の復元は**しない**（意図的な最終アクション。apt 成功後に除去しており、
  #   失敗時はまだ除去されていない = 復元不要）。
  #   退避済みの PPA 設定は監査用に残す（$BAK_DIR/apt-*）。
  echo "  dpkg --configure -a と設定の復元を実施しました。状態を確認してください。" >&2
  exit 1
}
trap on_error ERR

# --- B6: 検出と削除を同じリストで扱う（ondrej-php.list 等の名前違いも漏れない）---
# ※ 削除は apt 成功後に行う（apt 失敗時に「PPA だけ消えて PHP は sury のまま」になるのを防ぐ）
PPA_FILES="$PPA_LIST"
for l in $PPA_FILES; do
  cp -a "$APT_SOURCES_DIR/$l" "$BAK_DIR/apt-$l" 2>/dev/null || true
done

echo "==> apt-get update"
apt-get update

echo "==> apt-get install --allow-downgrades"
# conffile（pool.d/www.conf）はローカル版を保持する。php.ini は ucf 管理だが、
# Ubuntu 版と sury 版で md5 が一致するため同理的に保持される。
# 非対話で「保持」を保証するため --force-confold を明示する。
# `UCF_FORCE_CONFFOLD=1` は ucf 管理の php.ini を保持するため（--force-confold は
# dpkg の conffile 専用で php.ini には効かない）。ucf は debconf 未導入だと
# 「Need debconf to interact」で exit 2 になり postinst が失敗する。
DEBIAN_FRONTEND=noninteractive UCF_FORCE_CONFFOLD=1 \
  apt-get install -y -o Dpkg::Options::="--force-confold" --allow-downgrades $SPEC

# --- sury のキーリング・keyring パッケージを退置する ---
# ※ `/etc/apt/trusted.gpg.d/` の鍵は apt の**グローバル信頼**なので最優先で退置する。
#   `/usr/share/keyrings/` 側は dpkg パッケージ（debsuryorg-archive-keyring）が
#   管理しているため、ファイル移動ではなく**パッケージを purge** する。
#   退置に失敗したら**警告を出して続行**する（無言で失敗させない）。
retire_sury_keyring() {
  local bak_dir="$1" k
  for k in /etc/apt/trusted.gpg.d/*sury* /etc/apt/trusted.gpg.d/*ondrej*; do
    [ -f "$k" ] || continue
    if mv "$k" "$bak_dir/" 2>/dev/null; then
      echo "  退置: $k → $bak_dir/$(basename "$k")"
    else
      echo "  [WARN] 退置に失敗しました（残存）: $k" >&2
    fi
  done
  if dpkg-query -W -f='${Status}' debsuryorg-archive-keyring 2>/dev/null | grep -q "install ok installed"; then
    if DEBIAN_FRONTEND=noninteractive apt-get remove -y --purge debsuryorg-archive-keyring >/dev/null 2>&1; then
      echo "  削除: debsuryorg-archive-keyring（keyring パッケージを purge）"
    else
      echo "  [WARN] debsuryorg-archive-keyring の purge に失敗しました（残存）" >&2
    fi
  fi
}

# --- B9: Ubuntu 版は /usr/share/doc/php8.3-fpm を symlink にする。
#   sury 版は実ディレクトリが残っており、そのままだと unpack が失敗しうるため先に除く。
if [ -d /usr/share/doc/php8.3-fpm ] && [ ! -L /usr/share/doc/php8.3-fpm ]; then
  rm -rf /usr/share/doc/php8.3-fpm
  echo "  [OK] 旧 /usr/share/doc/php8.3-fpm（実ディレクトリ）を除去しました（Ubuntu 版は symlink）"
fi

echo "==> PPA 設定の除去（apt 成功後）"
for l in $PPA_FILES; do
  rm -f "$APT_SOURCES_DIR/$l"
  echo "  除去: $APT_SOURCES_DIR/$l"
done
PPA_REMOVED_LIST="$PPA_FILES"
apt-get update || true

echo "==> ハードニングの再適用（php.ini が ucf で置換されていた場合の保険）"
HARDENING_RESTARTED=0
if [ -f "$REPO_ROOT/scripts/php/apply-php-hardening.sh" ]; then
  if bash "$REPO_ROOT/scripts/php/apply-php-hardening.sh" --apply; then
    HARDENING_RESTARTED=1   # 既にこのスクリプト内で php-fpm を再起動している
  else
    echo "[ERR] ハードニングの再適用に失敗しました（ロールバックは続ける）" >&2
  fi
else
  echo "  (apply-php-hardening.sh が見つからないためスキップ)"
fi

if [ "$HARDENING_RESTARTED" = "0" ]; then
  echo "==> php-fpm の再起動"
  systemctl restart php8.3-fpm
fi
sleep 2
systemctl is-active php8.3-fpm
# `exit 1` では ERR trap が発火せず設定の復元が走らないため on_error を明示的に呼ぶ
php-fpm8.3 -t || { echo "[ERR] php-fpm の設定チェックに失敗" >&2; on_error $?; }

# ---------- N-4: sury のキーリング・keyring パッケージも退置する ----------
retire_sury_keyring "$BAK_DIR"

echo
echo "--- 適用結果 ---"
dpkg-query -W -f='  ${Package} ${Version}\n' "${PKGS[@]}" 2>/dev/null || true
php -v | head -1
echo
echo "--- 検証（自動）---"
bash "$REPO_ROOT/scripts/php/verify-php-security-patch.sh" || { echo "[ERR] パッチ状態の検証に失敗" >&2; on_error $?; }
bash "$REPO_ROOT/scripts/php/verify-php-hardening.sh" || { echo "[ERR] ハードニングの検証に失敗" >&2; on_error $?; }
echo "検証: bash scripts/php/verify-php-security-patch.sh && bash scripts/php/verify-php-hardening.sh"
echo "ロールバック（PPA 版へ戻す場合）: バックアップは $BAK_DIR"
