#!/usr/bin/env bash
# apply-mai-chat-elza.sh — nginx に「まいAI チャット」の location を追加する（elza vhost 用）
#
# 用途:
#   elza.poitou-mora.ts.net（tailnet 専用 vhost）で
#   /chat.html・/chat.js・/icon.webp・/icon-192.webp を tailnet/LAN から配信する。
#   これが無いと admin.html の「まいAI チャットを開く」が 404 になる（2026-11-06 実測）。
#
# 実行（要 sudo）:
#   sudo bash scripts/nginx/apply-mai-chat-elza.sh          # dry-run（変更しない）
#   sudo bash scripts/nginx/apply-mai-chat-elza.sh --apply  # 適用
#
# 安全:
#   - 冪等（適用済みなら何もせず exit 0。diff も出さない）
#   - アンカーが曖昧なら fail-closed（何も書き換えない）
#   - **atomic**: 一時ファイルを nginx.conf と同じディレクトリに作り、`mv` で rename する
#     （途中で kill されても nginx.conf が半分だけ書き換わることはない）
#   - バックアップ → nginx -t 失敗時は即座に復元（他プロセスが設定を変更していた場合は
#     復元せず中断して、他方の変更を潰さない）
set -euo pipefail

case "${1:-}" in
  "" | --apply) ;;
  *) echo "[ERR] 不明な引数: $1（--apply を付けてください）" >&2; exit 2 ;;
esac

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

CONF="/etc/nginx/nginx.conf"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BLOCK_FILE="$REPO_ROOT/scripts/nginx/mai-chat-elza.conf"
PATCH_JS="$REPO_ROOT/scripts/nginx/apply-mai-chat-elza.js"
# node は明示指定する（sudo 実行では nvm の PATH が読めず /usr/bin/node = v18 EOL を掴むため。AGENTS.md §5）
NODE_BIN="${NODE_BIN:-/home/yuzuki/.nvm/versions/node/v24.22.1/bin/node}"

[ -f "$CONF" ] || { echo "[ERR] $CONF が見つかりません"; exit 1; }
[ -f "$BLOCK_FILE" ] || { echo "[ERR] $BLOCK_FILE が見つかりません"; exit 1; }
[ -f "$PATCH_JS" ] || { echo "[ERR] $PATCH_JS が見つかりません"; exit 1; }
[ -x "$NODE_BIN" ] || { echo "[ERR] node が見つかりません: $NODE_BIN（NODE_BIN 環境変数で指定可）"; exit 1; }

echo "=== まいAI チャットの nginx location 適用（elza vhost）==="
echo "  対象     : $CONF"
echo "  ブロック : $BLOCK_FILE"
echo "  リポジトリ: $REPO_ROOT"
echo "  node     : $NODE_BIN ($("$NODE_BIN" -v))"

if [ "$APPLY" = "0" ]; then
  # dry-run は変更しないので root 不要。適用結果を temp に出力して差分だけを表示する
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  if ! "$NODE_BIN" "$PATCH_JS" "$CONF" "$BLOCK_FILE" "$TMP"; then
    echo "[ERR] dry-run のパッチ作成に失敗しました（何も変更していません）" >&2
    exit 1
  fi
  [ ! -s "$TMP" ] && { echo "[ERR] パッチが空です（何も変更していません）" >&2; exit 1; }
  if cmp -s "$CONF" "$TMP"; then
    echo "[OK] 差分なし（適用済み）"
    exit 0
  fi
  echo "--- dry-run: 挿入される差分 ---"
  diff -u "$CONF" "$TMP" || true
  echo
  echo "適用するには: sudo bash scripts/nginx/apply-mai-chat-elza.sh --apply"
  exit 0
fi

# 以降は nginx.conf を書き換えるので root が必要
[ "$(id -u)" -eq 0 ] || { echo "[ERR] 適用には root が必要です（sudo bash ... --apply で実行）"; exit 1; }

BAK="$CONF.bak-mai-chat-elza-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BAK"
echo "[OK] backup: $BAK"

# 一時ファイルは nginx.conf と同じディレクトリに作る（mv の rename が atomic になるように）
TMP="$(mktemp "${CONF}.apply-mai-chat-elza.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# パッチは temp に書き出す（本体にはまだ触れない）
"$NODE_BIN" "$PATCH_JS" "$CONF" "$BLOCK_FILE" "$TMP"
[ ! -s "$TMP" ] && { echo "[ERR] パッチが空です（中断・何も変更していません）" >&2; rm -f "$TMP"; exit 1; }

if cmp -s "$CONF" "$TMP"; then
  rm -f "$TMP"
  echo "[OK] 差分なし（適用済み）。nginx -t / reload はスキップします"
  exit 0
fi

# 適用後に nginx -t が失敗した場合に「自分が書いた内容が残っているか」を判定するためのハッシュ
PATCHED_HASH="$(sha256sum "$TMP" | cut -d' ' -f1)"

# install 前に「backup 取得後に他プロセスが config を変更していないか」を確認する。
# 変更されている場合（並行した適用など）は **mv せず中断**（他方の変更を潰さない）。
if ! cmp -s "$CONF" "$BAK"; then
  rm -f "$TMP"
  echo "[ERR] $CONF は backup 取得後に変更されています（並行した変更が疑われます）。" >&2
  echo "     mv せず中断します（他方の変更を潰さないため）。手動で確認してください: $BAK" >&2
  exit 1
fi

mv -f "$TMP" "$CONF"   # 同一ディレクトリ内の rename＝atomic
chmod 0644 "$CONF"

# nginx -t が失敗したらバックアップへ戻す（壊れた config を残さない）。
if ! nginx -t; then
  if [ "$(sha256sum "$CONF" | cut -d' ' -f1)" = "$PATCHED_HASH" ]; then
    echo "[ERR] nginx -t が失敗したためバックアップへ戻します" >&2
    cp -a "$BAK" "$CONF"
    echo "復元: $BAK" >&2
    if nginx -t; then
      echo "[OK] 復元後の nginx -t は通りました" >&2
    else
      echo "[ERR] 復元後も nginx -t が失敗します。手動で $BAK を確認してください" >&2
    fi
  else
    echo "[ERR] nginx -t が失敗しましたが $CONF は mv 後に変更されています。" >&2
    echo "     復元せず中断します（他方の変更を潰さないため）。手動で確認してください: $BAK" >&2
  fi
  exit 1
fi

if ! nginx -s reload; then
  echo "[WARN] nginx -s reload に失敗しました。設定は配置済みです。" >&2
  echo "     'sudo nginx -s reload' を手動で実行してください（backup: $BAK）" >&2
  exit 1
fi
echo "=== 完了 ==="

cat <<'TXT'
確認:
  curl -s -o /dev/null -w '%{http_code}\n' https://elza.poitou-mora.ts.net/chat.html   # 200 を期待
  curl -s -o /dev/null -w '%{http_code}\n' https://elza.poitou-mora.ts.net/chat.js      # 200 を期待
TXT
