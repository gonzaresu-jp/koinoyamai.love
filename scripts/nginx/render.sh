#!/usr/bin/env bash
# render.sh — nginx 設定をテンプレートから生成する（フェーズ1: 生成のみ。本番へは書かない）
#
# 使い方:
#   bash scripts/nginx/render.sh [出力先ディレクトリ]
#     出力先を省略すると mktemp -d で一時ディレクトリを作り、パスを表示する。
#     /etc/nginx へは一切書かない（配置はフェーズ2の deploy.sh の役割）。
#
# プレースホルダ（templates/ 内で使えるのはこの2つだけ）:
#   ${TAILNET_ADMIN_SECRET} … .env の同名キーから読む。未設定・空なら失敗して止まる（fail-closed）。
#                             値を標準出力・ログへは出さない。
#   ${TAILNET_HOSTNAME}     … tailnet 上のホスト名。環境変数で上書き可（既定: elza.poitou-mora.ts.net）。
#
# .env の場所: 環境変数 ENV_FILE で指定可。既定はリポジトリ直下の .env。
#   .env は source せず、対象キーの行だけを抽出する（任意コードを実行しないため）。
#
# envsubst には置換対象を上記2変数だけに限定して渡す。
# nginx 自身の変数（$host / $request_uri 等）を巻き込んで置換しないため。
set -euo pipefail
# 生成した nginx.conf は秘密値を含むため、生成物のパーミッションを絞る
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/templates"

OUT_DIR="${1:-}"
if [ -z "$OUT_DIR" ]; then
  OUT_DIR="$(mktemp -d /tmp/nginx-render.XXXXXX)"
fi
# フェーズ1では本番へ書かない。出力先が /etc/nginx 配下なら明示的に拒否する。
# 判定は mkdir より前に、シンボリックリンクを解決した実パスで行う
# （論理パス判定だと /etc/nginx へのリンク経由で回避できてしまうため）。
OUT_DIR_ABS="$(realpath -m "$OUT_DIR")"
# /etc/nginx 自体がシンボリックリンクの環境でも拒否できるよう、比較先も実パスで持つ
NGINX_REAL="$(realpath -m /etc/nginx)"
case "$OUT_DIR_ABS" in
  /etc/nginx|/etc/nginx/*|"$NGINX_REAL"|"$NGINX_REAL"/*)
    echo "[render] ERROR: 出力先に /etc/nginx は指定できません（フェーズ1は生成のみ）" >&2
    exit 1
    ;;
esac
mkdir -p "$OUT_DIR"

ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "[render] ERROR: .env が見つかりません: $ENV_FILE (ENV_FILE で指定可)" >&2
  exit 1
fi

# TAILNET_ADMIN_SECRET を .env から抽出（先頭の一致行のみ。引用符と CR を除去）
TAILNET_ADMIN_SECRET="$(grep -m1 '^TAILNET_ADMIN_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
if [ -z "${TAILNET_ADMIN_SECRET:-}" ]; then
  echo "[render] ERROR: TAILNET_ADMIN_SECRET が .env に未設定または空です。fail-closed のため生成を中止します" >&2
  exit 1
fi
export TAILNET_ADMIN_SECRET

TAILNET_HOSTNAME="${TAILNET_HOSTNAME:-elza.poitou-mora.ts.net}"
case "$TAILNET_HOSTNAME" in
  *[!A-Za-z0-9.-]*|'')
    echo "[render] ERROR: TAILNET_HOSTNAME が不正です: $TAILNET_HOSTNAME" >&2
    exit 1
    ;;
esac
export TAILNET_HOSTNAME

if ! command -v envsubst >/dev/null 2>&1; then
  echo "[render] ERROR: envsubst が見つかりません (gettext-base)" >&2
  exit 1
fi

if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "[render] ERROR: テンプレートが見つかりません: $TEMPLATE_DIR" >&2
  exit 1
fi

count=0
while IFS= read -r tmpl; do
  rel="${tmpl#"$TEMPLATE_DIR"/}"
  dest="$OUT_DIR/${rel%.tmpl}"
  mkdir -p "$(dirname "$dest")"
  envsubst '${TAILNET_ADMIN_SECRET} ${TAILNET_HOSTNAME}' < "$tmpl" > "$dest"
  echo "[render] 生成: ${rel%.tmpl}"
  count=$((count + 1))
done < <(find "$TEMPLATE_DIR" -type f -name '*.tmpl' | sort)

if [ "$count" -eq 0 ]; then
  echo "[render] ERROR: テンプレートが1つもありません" >&2
  exit 1
fi

# 未置換のプレースホルダが残っていたら失敗（fail-closed）
if grep -rq '${TAILNET_' "$OUT_DIR"; then
  echo "[render] ERROR: 未置換のプレースホルダが生成結果に残っています" >&2
  exit 1
fi

# 秘密値が生成された nginx.conf に実際に差し込まれていることだけを確認する（値は表示しない）。
# grep の引数に渡すと ps で他ユーザーから見えるため、組み込みの printf からパターンとして渡す。
if ! grep -Fqf <(printf '%s\n' "$TAILNET_ADMIN_SECRET") "$OUT_DIR/nginx.conf"; then
  echo "[render] ERROR: 生成した nginx.conf に TAILNET_ADMIN_SECRET が差し込まれていません" >&2
  exit 1
fi

echo "[render] OK: ${count} ファイルを生成しました"
echo "[render] 出力先: $OUT_DIR"
