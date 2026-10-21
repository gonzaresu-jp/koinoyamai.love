#!/usr/bin/env bash
# setup-staging-nginx.sh - サブドメイン test.koinoyamai.love 用 nginx 設定をインストール
# 実行: sudo bash scripts/nginx/setup-staging-nginx.sh
# （sudo で本物の /etc/nginx への書き込みが必要なためインタラクティブに実行してください）
set -euo pipefail
cd "$(dirname "$0")"   # scripts/nginx

SNIPPET_SRC="mai-security-headers.conf"
SNIPPET_DST="/etc/nginx/snippets/mai-security-headers.conf"

# --- 先にスニペットを配置する ---
# mai-test.conf は `include /etc/nginx/snippets/mai-security-headers.conf;` を含むため、
# スニペットが無い状態で設定を差替えると `nginx -t` が失敗して
# **サイト全体が止まる**（2026-10-21 独立レビューで指摘）。
# → 配置 → 差替 → nginx -t → リロード の順で、差替前に必ず check する。
if ! grep -q "mai-security-headers.conf" mai-test.conf; then
  echo "note: mai-test.conf にセキュリティヘッダの include がありません（snippet 不要）"
else
  echo "==> セキュリティヘッダのスニペットを配置します: $SNIPPET_DST"
  sudo mkdir -p /etc/nginx/snippets
  sudo install -m 644 -o root -g root "$SNIPPET_SRC" "$SNIPPET_DST"
  sudo test -r "$SNIPPET_DST" || { echo "ERROR: スニペットが配置できません" >&2; exit 1; }
  echo "    OK: $SNIPPET_DST"
fi

echo "==> mai-test.conf を配置します"
sudo cp mai-test.conf /etc/nginx/sites-available/mai-test.conf
sudo ln -sf /etc/nginx/sites-available/mai-test.conf /etc/nginx/sites-enabled/mai-test

echo "==> nginx -t"
if ! sudo nginx -t; then
  echo "[NG] 構文エラーです。/sites-available/mai-test.conf を退避から戻してください" >&2
  exit 1
fi
sudo systemctl reload nginx
echo "OK: mai-test vhost enabled."
echo "次に Cloudflare DNS で test.koinoyamai.love を koinoyamai.love と同じターゲットに向けてください。"
