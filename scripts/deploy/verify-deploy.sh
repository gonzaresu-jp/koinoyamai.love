#!/bin/bash
# デプロイした静的ファイルの完全性を検証する
#
# 使い方:
#   bash scripts/deploy/verify-deploy.sh webui/wave.php
#   bash scripts/deploy/verify-deploy.sh webui/index.php https://mai.honna-yuzuki.com/ [マーカー]
#
# なぜ必要か（2026-09-26 の実事故）:
#   nginx の open_file_cache は、置換直後の静的ファイルについて古い size を
#   保持したまま Content-Length を出すため、応答が途中で切れて
#   <script> ごと欠落することがある。**HTTP 200 を返しても肉眼では気づけない**。
#   実際に本番ログインページが 120 秒間、ログイン不能な状態で配信されていた。
#
#   本スクリプトは「配信バイト数 == ディスク上のバイト数」を機械的に判定し、
#   切詰めを検出したら待って再試行する（open_file_cache の TTL を待つ）。
#
# 判定:
#   - 配信バイト数 < ディスク上のバイト数 → 切詰め（要待って再試行）
#   - 配信バイト数 > ディスク上のバイト数 → 不明な余分（要調査）
#   - 完全一致 → OK
#
# 環境変数で上書き可:
#   ORIGIN_BASE  (既定 http://127.0.0.1:1700)  … Cloudflare を経由しない配信元
#   PUBLIC_BASE  (既定 https://koinoyamai.love — 2026-10-11 フェーズ2反映)
#   RETRIES      (既定 3)  … 切詰め検出時の再試行回数
#   RETRY_WAIT   (既定 12) … 再試行までの秒数（nginx open_file_cache_valid の 10s + 余裕）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ORIGIN_BASE="${ORIGIN_BASE:-http://127.0.0.1:1700}"
PUBLIC_BASE="${PUBLIC_BASE:-https://koinoyamai.love}"
RETRIES="${RETRIES:-3}"
RETRY_WAIT="${RETRY_WAIT:-12}"

die() { echo "ERROR: $*" >&2; exit 2; }

[ $# -ge 1 ] || die "使い方: $0 <リポジトリ相対パス> [公開URL] [マーカー]"
LOCAL="$1"
PUBLIC_URL="${2:-}"
MARKER="${3:-}"

[ -f "$LOCAL" ] || die "ローカルファイルが見つかりません: $LOCAL"
LOCAL_SIZE=$(wc -c < "$LOCAL" | tr -d ' ')
echo "[verify-deploy] ローカル: $LOCAL (${LOCAL_SIZE} bytes)"

# 公開URLが未指定ならリポジトリ相対パスから推測する
#   webui/wave.php → /wave.php   (nginx 1700 の docroot が webui/ のため)
if [ -z "$PUBLIC_URL" ]; then
  case "$LOCAL" in
    webui/*) PUBLIC_URL="$PUBLIC_BASE/${LOCAL#webui/}" ;;
    *)       PUBLIC_URL="$PUBLIC_BASE/$LOCAL" ;;
  esac
fi

# --- 配信元（Cloudflare 経由しない）から取得しバイト数を厳密比較 ---
fetch_origin_size() {
  curl -s --max-time 20 -o /tmp/verify-deploy.body "$1" 2>/dev/null \
    && wc -c < /tmp/verify-deploy.body | tr -d ' ' \
    || echo "-1"
}

# 静的文件（拡張子で PHP 実行を判別）だけがバイト比較の対象。
# .php は php-fpm が実行して出力を返すため、ディスク上のバイト数とは一致しない
# （ヘッダ/フッタの include が展開される分むしろ大きくなる）。
# このファイルは公開 HTML 側の完全性・目印のみを検証する。
case "$LOCAL" in
  *.php) BYTE_COMPARE=0 ;;
  *)     BYTE_COMPARE=1 ;;
esac

if [ "$BYTE_COMPARE" = "1" ]; then
  ORIGIN_URL="$ORIGIN_BASE/${LOCAL#webui/}"
  echo "[verify-deploy] 配信元: $ORIGIN_URL"

  attempt=0
  while :; do
    attempt=$((attempt + 1))
    GOT=$(fetch_origin_size "$ORIGIN_URL")
    if [ "$GOT" = "-1" ]; then
      echo "[verify-deploy] attempt $attempt: 配信元に接続できません"
    elif [ "$GOT" = "$LOCAL_SIZE" ]; then
      echo "[verify-deploy] attempt $attempt: 配信元 $GOT bytes = ローカル一致 ✓"
      break
    elif [ "$GOT" -lt "$LOCAL_SIZE" ]; then
      echo "[verify-deploy] attempt $attempt: *** 切詰め検出 *** 配信 $GOT < ローカル $LOCAL_SIZE"
      if [ "$attempt" -ge "$RETRIES" ]; then
        echo "[verify-deploy] 再試行しても回復せず。nginx reload が必要かを確認してください:"
        echo "              sudo nginx -t && sudo nginx -s reload"
        exit 1
      fi
      echo "[verify-deploy] ${RETRY_WAIT}s 待機して再試行（open_file_cache の TTL 待ち）"
      sleep "$RETRY_WAIT"
      continue
    else
      echo "[verify-deploy] attempt $attempt: 配信 $GOT > ローカル $LOCAL_SIZE（余分あり・要調査）"
      if [ "$attempt" -ge "$RETRIES" ]; then exit 1; fi
      sleep "$RETRY_WAIT"
      continue
    fi
  done
else
  echo "[verify-deploy] 配信元: バイト比較はスキップ（.php は実行されるため不可）"
  ORIGIN_URL=""
fi

# --- 公開 URL 経由（Cloudflare 実経路）でも確認 ---
echo "[verify-deploy] 公開URL: $PUBLIC_URL"
PUB_CODE=$(curl -s -o /tmp/verify-deploy.pub --max-time 25 -w '%{http_code}' "$PUBLIC_URL")
PUB_SIZE=$(wc -c < /tmp/verify-deploy.pub | tr -d ' ')
echo "[verify-deploy] 公開: HTTP $PUB_CODE, ${PUB_SIZE} bytes（Cloudflare の注入分を含むためローカルと一致しなくてよい）"

rc=0
[ "$PUB_CODE" = "200" ] || { echo "[verify-deploy] ✗ 公開URL が 200 ではありません"; rc=1; }

# HTML の完全性（閉タグの欠落＝脚本が途中で切れた徵候）
if grep -qi '</html>' "$LOCAL"; then
  if grep -q '</html>' /tmp/verify-deploy.pub; then
    echo "[verify-deploy] ✓ 公開HTML に </html> が存在（完全性OK）"
  else
    echo "[verify-deploy] ✗ 公開HTML に </html> が無い＝途中で切れている可能性"
    rc=1
  fi
fi

# PHP のにじみ出し検出（静的配信された PHP がそのまま出ている）
if grep -q '<?php' /tmp/verify-deploy.pub 2>/dev/null; then
  echo "[verify-deploy] ✗ 公開HTML に <?php がにじんでいる（PHP 未実行・拡張子や routing を要確認）"
  rc=1
fi

# 任意の追加マーカー
if [ -n "$MARKER" ]; then
  if grep -qF "$MARKER" /tmp/verify-deploy.pub; then
    echo "[verify-deploy] ✓ マーカー '$MARKER' を検出"
  else
    echo "[verify-deploy] ✗ マーカー '$MARKER' が見つかりません"
    rc=1
  fi
fi

[ $rc -eq 0 ] && echo "[verify-deploy] 完了: 問題なし" || echo "[verify-deploy] 完了: 問題あり"
exit $rc
