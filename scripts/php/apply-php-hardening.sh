#!/usr/bin/env bash
# apply-php-hardening.sh — PHP 8.3-FPM の実行時ハードニングを適用する
#
# なぜ必要か（2026-10-21 実測）:
#   - PHP コア RCE（CVE-2026-109618 / CVE-2026-109619, CVSS 9.2）の修正版
#     （upstream 8.3.36 相当）が未リリース。Canonical のバックポートも未リリース
#     （apt-cache policy: candidate == installed）。
#   - 詳細は未公開だが、PHP コアの RCE の典型は**リクエスト解析（multipart 等）**の層。
#     PHP は `enable_post_data_reading=On`（既定）のため、リクエスト開始時に
#     **常に POST ボディをパースする**。アプリは $_POST を読まなくても解析は走る。
#     → `enable_post_data_reading=Off` にすると、**パーサ層そのものが動かなくなる**。
#   - このアプリは POST を一切使わない（webui/*.php に $_POST / $_FILES / $_REQUEST は 0 件、
#     <form method="post"> も 0 件）ので、Off にして壊れることはない。
#
# 適用する設定:
#   [php.ini]（FPM 全体で有効）
#     disable_functions = exec,system,shell_exec,passthru,popen,proc_open,pcntl_exec,dl
#       → 任意コマンド実行を止める
#     open_basedir = <本番docroot>:<staging docroot>:/tmp:/var/lib/php/sessions:/var/lib/mai-push
#       → 任意ファイル読み書きを止める
#   [pool.d/www.conf]（php_admin_value = スクリプト側の php_value で上書きできない）
#     php_admin_value[enable_post_data_reading] = Off
#       → multipart / POST ボディのパースを止める（コア RCE の最有力の入口を潰す）
#     php_admin_value[post_max_size] = 16M
#     php_admin_value[upload_max_filesize] = 8M
#     php_admin_value[max_file_uploads] = 0
#       → 4G だった上限を sane な値に（DoS 耐性。アップロードは本слиートに不要）
#     php_admin_value[ffi.enable] = preload
#       → FFI::cdef を実行時ブロックし、disable_functions の迂回を防ぐ
#         （既定値も preload だが、ini を触ったときに緩まないよう明示する）
#
# 実行:
#   bash scripts/php/apply-php-hardening.sh            # dry-run（root 不要）
#   sudo bash scripts/php/apply-php-hardening.sh --apply
#
# ロールバック:
#   sudo cp /etc/php/8.3/fpm/php.ini.bak-hardening-<時刻> /etc/php/8.3/fpm/php.ini
#   sudo cp /etc/php/8.3/fpm/pool.d/www.conf.bak-hardening-<時刻> /etc/php/8.3/fpm/pool.d/www.conf
#   sudo systemctl restart php8.3-fpm
set -euo pipefail

INI="/etc/php/8.3/fpm/php.ini"
POOL="/etc/php/8.3/fpm/pool.d/www.conf"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

DISABLE_FUNCS="exec,system,shell_exec,passthru,popen,proc_open,pcntl_exec,dl"
OPEN_BASEDIR="/var/www/html/koinoyamai.love/webui:/home/yuzuki/koinoyamai.love-test/webui:/tmp:/var/lib/php/sessions:/var/lib/mai-push"

echo "=== PHP 実行時ハードニングの適用 ==="
[ -f "$INI" ] || { echo "[ERR] $INI が見つかりません" >&2; exit 1; }
[ -f "$POOL" ] || { echo "[ERR] $POOL が見つかりません" >&2; exit 1; }

# ---- 事前チェック（fail-closed）----
# enable_post_data_reading=Off を適用する前に、
# 「POST を読むページが 1 つでも無いこと」を機械確認する。
echo "--- 事前チェック ---"
POST_HITS="$(grep -rlE '\$_(POST|FILES|REQUEST)\b' "$REPO_ROOT"/webui/*.php 2>/dev/null || true)"
if [ -n "$POST_HITS" ]; then
  echo "[ERR] POST を読む PHP があります。先に修正してください:" >&2
  echo "$POST_HITS" | sed 's/^/       /' >&2
  echo "       enable_post_data_reading=Off は適用しません" >&2
  exit 1
fi
echo "  [OK] webui/*.php に \$_POST / \$_FILES / \$_REQUEST はない"

FORM_HITS="$(grep -rlE '<form[^>]*method=["'"'"']?post' "$REPO_ROOT"/webui/*.php 2>/dev/null || true)"
if [ -n "$FORM_HITS" ]; then
  echo "[ERR] POST するフォームがあります。先に修正してください:" >&2
  echo "$FORM_HITS" | sed 's/^/       /' >&2
  exit 1
fi
echo "  [OK] webui/*.php に method=post のフォームはない"

MB_HITS="$(php -r '
$dir = $argv[1];
foreach (glob($dir . "/*.php") as $f) {
  $tokens = token_get_all(file_get_contents($f));
  foreach ($tokens as $i => $t) {
    if (!is_array($t) || $t[0] !== T_STRING) continue;
    if (strncmp($t[1], "mb_", 3) !== 0) continue;
    $next = $tokens[$i + 1] ?? null;
    if ($next === "(") { echo $f, ":", $t[2], " ", $t[1], "()", PHP_EOL; }
  }
}
' "$REPO_ROOT/webui" 2>/dev/null || true)"
if [ -n "$MB_HITS" ]; then
  echo "[ERR] mbstring 関数を使う PHP があります（mbstring は未導入です）:" >&2
  echo "$MB_HITS" | sed 's/^/       /' >&2
  exit 1
fi
echo "  [OK] webui/*.php に mb_* 呼び出しはない（mbstring 未導入と整合）"

echo
echo "--- 現在の設定 ---"
grep -nE "^\s*;?\s*(disable_functions|open_basedir)\s*=" "$INI" | sed 's/^/  ini: /' || echo "  ini: (該当なし)"
grep -nE "^\s*;?\s*php_admin_value\[(enable_post_data_reading|post_max_size|upload_max_filesize|max_file_uploads|ffi\.enable)\]" "$POOL" | sed 's/^/  pool: /' || echo "  pool: (該当なし)"

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "--- dry-run: 適用後の内容 ---"
  echo "  ini:"
  echo "    disable_functions = ${DISABLE_FUNCS}"
  echo "    open_basedir = ${OPEN_BASEDIR}"
  echo "  pool:"
  echo "    php_admin_value[enable_post_data_reading] = Off"
  echo "    php_admin_value[post_max_size] = 16M"
  echo "    php_admin_value[upload_max_filesize] = 8M"
  echo "    php_admin_value[max_file_uploads] = 0"
  echo "    php_admin_value[ffi.enable] = preload"
  echo
  echo "--- 適用後の手順 ---"
  echo "  sudo bash scripts/php/apply-php-hardening.sh --apply"
  echo "  bash scripts/php/verify-php-hardening.sh   # 適用結果の検証"
  echo "  ※ php-fpm の再起動が要る（php.ini / pool の変更は反映に再起動が必要）"
  echo "  ※ nginx のレート制限は適用しない（real_ip 未設定のため全ユーザーが 127.0.0.1 扱いになる）"
  exit 0
fi

[ "$(id -u)" = "0" ] || { echo "[ERR] 適用には root が必要です（sudo bash ... --apply で実行）" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
BAK_INI="${INI}.bak-hardening-${STAMP}"
BAK_POOL="${POOL}.bak-hardening-${STAMP}"
cp -a "$INI" "$BAK_INI"
cp -a "$POOL" "$BAK_POOL"
echo "[OK] backup: $BAK_INI"
echo "[OK] backup: $BAK_POOL"

# --- php.ini: disable_functions / open_basedir ---
set_ini() {
  local key="$1" val="$2"
  if grep -qE "^\s*${key}\s*=" "$INI"; then
    sed -i -E "s|^(\s*${key}\s*=).*|\1 ${val}|" "$INI"
  else
    printf "\n; %s (security hardening %s)\n%s = %s\n" "$key" "$STAMP" "$key" "$val" >> "$INI"
  fi
}
set_ini "disable_functions" "$DISABLE_FUNCS"
set_ini "open_basedir" "$OPEN_BASEDIR"
echo "[OK] php.ini を更新"

# --- pool.d/www.conf: php_admin_value ---
# 既存行があれば置換、なければ追記（php_admin_value は重複しても最後のものが効くが、
# 意図しない重複を残さないよう置換する）
set_pool() {
  local key="$1" val="$2"
  if grep -qE "^\s*php_admin_value\[${key}\]" "$POOL"; then
    sed -i -E "s|^\s*php_admin_value\[${key}\].*|php_admin_value[${key}] = ${val}|" "$POOL"
  else
    printf "\n; security hardening %s\nphp_admin_value[%s] = %s\n" "$STAMP" "$key" "$val" >> "$POOL"
  fi
}
set_pool "enable_post_data_reading" "Off"
set_pool "post_max_size" "16M"
set_pool "upload_max_filesize" "8M"
set_pool "max_file_uploads" "0"
set_pool "ffi.enable" "preload"
echo "[OK] pool.d/www.conf を更新"

# --- 構文確認 ---
if ! php-fpm8.3 -t >/dev/null 2>&1; then
  echo "[ERR] php-fpm の設定にエラーがあるためバックアップから戻します" >&2
  php-fpm8.3 -t 2>&1 | tail -3 >&2 || true
  cp -a "$BAK_INI" "$INI"
  cp -a "$BAK_POOL" "$POOL"
  exit 1
fi
echo "[OK] php-fpm8.3 -t"

systemctl restart php8.3-fpm
sleep 2
systemctl is-active php8.3-fpm

echo
echo "--- 適用結果 ---"
grep -nE "^\s*(disable_functions|open_basedir)\s*=" "$INI" | sed 's/^/  ini:  /'
grep -nE "^\s*php_admin_value\[(enable_post_data_reading|post_max_size|upload_max_filesize|max_file_uploads|ffi\.enable)\]" "$POOL" | sed 's/^/  pool: /'
echo
echo "=== 完了 ==="
echo "ロールバック: sudo cp $BAK_INI $INI && sudo cp $BAK_POOL $POOL && sudo systemctl restart php8.3-fpm"
echo "検証: bash scripts/php/verify-php-hardening.sh"
