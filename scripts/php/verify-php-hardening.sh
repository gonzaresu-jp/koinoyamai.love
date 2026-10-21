#!/usr/bin/env bash
# verify-php-hardening.sh — PHP 8.3-FPM のハードニング適用状況を検証する
#
# 実行（root 不要）:
#   bash scripts/php/verify-php-hardening.sh
#
# 検証内容:
#   1. 設定ファイル（php.ini / pool.d/www.conf）の値
#   2. 実際に FPM ワーカーがどう解釈しているか（docroot に一時プローブを置いて
#      HTTP 経由で phpinfo 相当の値を取得する。→ 最後に必ず削除する）
#   3. アプリの前提（POST を使わない / mb_* を使わない）が崩れていないか
#
# 終了コード: 0 = すべて OK / 1 = 違反あり
set -uo pipefail

INI="/etc/php/8.3/fpm/php.ini"
POOL="/etc/php/8.3/fpm/pool.d/www.conf"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_DIR="${PROBE_DIR:-/var/www/html/koinoyamai.love/webui}"
# ランダム名（同時に走ったプローブと衝突しない／痕跡を残しにくい）
PROBE_NAME="_php_hardening_probe_$(date +%s)_$$_$RANDOM.php"
PROBE="$PROBE_DIR/$PROBE_NAME"
ORIGIN="${ORIGIN:-http://127.0.0.1:1717}"

fail=0
ok()   { echo "  [OK]   $1"; }
ng()   { echo "  [NG]   $1"; fail=1; }

echo "=== PHP ハードニングの検証 ==="
echo "  ini   : $INI"
echo "  pool  : $POOL"
echo "  origin: $ORIGIN"
echo

echo "--- 1. 設定ファイル ---"
val() { grep -E "^\s*${2}\s*=" "$1" 2>/dev/null | head -1 | sed -E "s|^\s*${2}\s*=\s*||" | sed -E 's/;.*$//' | xargs || true; }
poolval() { grep -E "^\s*php_admin_value\[${1}\]\s*=" "$POOL" 2>/dev/null | head -1 | sed -E "s|^\s*php_admin_value\[${1}\]\s*=\s*||" | xargs || true; }

DF="$(val "$INI" disable_functions)"
if echo "$DF" | grep -qE '(^|,)exec(,|$)'; then ok "disable_functions: exec 系が含まれる"; else ng "disable_functions: exec が無効になっていない（現在: $DF）"; fi
if echo "$DF" | grep -qE '(^|,)shell_exec(,|$)'; then ok "disable_functions: shell_exec が含まれる"; else ng "disable_functions: shell_exec が無効になっていない"; fi

OB="$(val "$INI" open_basedir)"
if [ -n "$OB" ]; then ok "open_basedir: $OB"; else ng "open_basedir が未設定"; fi

EPRD="$(poolval enable_post_data_reading)"
if [ "$EPRD" = "Off" ]; then ok "enable_post_data_reading = Off（multipart パーサ無効）"; else ng "enable_post_data_reading が Off でない（現在: ${EPRD:-未設定}）"; fi

PMS="$(poolval post_max_size)"
if [ -n "$PMS" ] && [ "$PMS" != "4G" ]; then ok "post_max_size = $PMS"; else ng "post_max_size が 4G のまま（現在: ${PMS:-未設定}）"; fi

MFI="$(poolval max_file_uploads)"
if [ "$MFI" = "0" ]; then ok "max_file_uploads = 0"; else echo "  [INFO] max_file_uploads = ${MFI:-未設定}（0 でなければアップロードを許す）"; fi

FFI="$(poolval ffi.enable)"
if [ "$FFI" = "preload" ]; then ok "ffi.enable = preload（FFI::cdef は実行時ブロック）"; else echo "  [INFO] ffi.enable = ${FFI:-未設定（既定は preload）}"; fi

echo
echo "--- 2. ランタイムの実測（FPM ワーカーの解釈） ---"
if [ ! -w "$PROBE_DIR" ]; then
  echo "  [SKIP] $PROBE_DIR に書き込めない（プローブをskip）"
else
  trap 'rm -f "$PROBE"' EXIT

cat > "$PROBE" <<'PHP'
<?php
header('Content-Type: text/plain');
echo "sapi=", php_sapi_name(), PHP_EOL;
echo "enable_post_data_reading=", ini_get('enable_post_data_reading'), PHP_EOL;
echo "post_max_size=", ini_get('post_max_size'), PHP_EOL;
echo "upload_max_filesize=", ini_get('upload_max_filesize'), PHP_EOL;
echo "max_file_uploads=", ini_get('max_file_uploads'), PHP_EOL;
echo "ffi.enable=", ini_get('ffi.enable'), PHP_EOL;
echo "disable_functions=", ini_get('disable_functions'), PHP_EOL;
echo "open_basedir=", ini_get('open_basedir'), PHP_EOL;
echo "exec_defined=", function_exists('exec') ? 'yes' : 'no', PHP_EOL;
try { FFI::cdef("int system(const char *c);", "libc.so.6"); echo "ffi_cdef=allowed", PHP_EOL; }
catch (Throwable $e) { echo "ffi_cdef=blocked", PHP_EOL; }
echo "post_count=", count($_POST), PHP_EOL;
PHP
  chmod 664 "$PROBE"
  sleep 1
  # GET と POST（ボディあり）の両方で見る。
  # POST で post_count=0 なら enable_post_data_reading=Off が効いている
  # （Off の場合、PHP は POST ボディを読まず $_POST も $_FILES も空になる）。
  RESP_GET="$(curl -s -m 15 "$ORIGIN/$PROBE_NAME" || true)"
  RESP_POST="$(curl -s -m 15 -X POST -d 'mai_probe=1&x=2' "$ORIGIN/$PROBE_NAME" || true)"
  rm -f "$PROBE"
  if echo "$RESP_GET" | grep -q "^sapi=fpm-fcgi"; then
    echo "    --- GET ---"
    echo "$RESP_GET" | sed 's/^/    /'
    echo "    --- POST (application/x-www-form-urlencoded) ---"
    echo "$RESP_POST" | sed 's/^/    /'
    # PHP の boolean ini は Off のとき ini_get() が空文字（""）を返す（On なら "1"）。
    # そのため "Off" だけを探すと Off のときに偽の失敗になる（2026-10-21 実測）。
    grep -qE "^enable_post_data_reading=(Off)?$" <<<"$RESP_GET" && ok "実行時 enable_post_data_reading = Off（ini_get は空文字）" || ng "実行時 enable_post_data_reading が Off でない"
    grep -q "^exec_defined=no$"       <<<"$RESP_GET" && ok "実行時 exec は undefined"            || ng "実行時 exec が有効"
    grep -q "^ffi_cdef=blocked$"      <<<"$RESP_GET" && ok "実行時 FFI::cdef は blocked"          || ng "実行時 FFI::cdef が許可されている"
    grep -q "^post_count=0$"          <<<"$RESP_POST" && ok "実行時 \$_POST は常に空（POST ボディも読まれない）" || ng "実行時 \$_POST が読み取られる（multipart パーサが有効）"
  else
    echo "  [SKIP] プローブを取得できませんでした（応答: ${RESP_GET:0:120}）"
  fi
fi

echo
echo "--- 3. アプリの前提 ---"
if grep -rqE '\$_(POST|FILES|REQUEST)\b' "$REPO_ROOT"/webui/*.php 2>/dev/null; then
  ng "webui/*.php が POST/FILE を読んでいる（enable_post_data_reading=Off と非整合）"
else
  ok "webui/*.php は POST/FILE を読まない"
fi
MB_CALLS="$(php -r '
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
if [ -n "$MB_CALLS" ]; then
  ng "webui/*.php が mb_* を呼んでいる（mbstring は未導入 → 500 になる）"
  echo "$MB_CALLS" | sed 's/^/         /'
else
  ok "webui/*.php は mb_* を呼ばない"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "=== すべて OK ==="
  exit 0
fi
echo "=== 違反があります ===" >&2
exit 1
