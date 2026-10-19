#!/bin/bash
# 登録者数の日次更新 + データファイルの自動コミット
#
# cron: 5 0 * * * /var/www/html/koinoyamai.love/scripts/ops/update-subscribers-and-commit.sh
#
# 背景:
#   scripts/ops/update-subscribers.js は webui/data/*.txt を日次で追記する。
#   そのデータファイルは追跡下のまま .gitignore 済み（ignore 規則は追跡済み
#   ファイルに効かない）で、書き込むたびに作業ツリーが dirty になっていた。
#   このラッパーは生成直後にデータファイルだけを commit し、ツリーを清潔に保つ。
#
# 設計方針:
#   - データ生成は update-subscribers.js に任せ、本スクリプトは git 操作のみ行う
#   - update-subscribers.js は冪等（同日同値なら unchanged で書かない）ため、
#     changed が返らない日は commit しない（空コミットを作らない）
#   - 対象は webui/data/ のみ。其他の未コミット変更巻き込まない
#   - データ変更があった日のみ push する（commit した時だけ）。何もない日は push しない。
#   - push 失敗時は commit を残したままログに記録し、次回実行時に再送される
#   - 既存の未コミット変更があれば今回分は commit せず警告だけ出す
#
# 保存先・ログ:
#   ログは logs/subscribers.log に追記（cron のリダイレクト）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

NODE_BIN="/home/yuzuki/.nvm/versions/node/v22.12.0/bin/node"
LOG_PREFIX="[subscribers-commit]"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_PREFIX $*"; }

# --- 1. データ生成（既存スクリプトに委譲） ---
if [ ! -x "$NODE_BIN" ]; then
  log "ERROR: node が見つかりません: $NODE_BIN"
  exit 1
fi
"$NODE_BIN" "$ROOT/scripts/ops/update-subscribers.js"
rc=$?
if [ $rc -ne 0 ]; then
  log "update-subscribers.js が失敗しました (exit=$rc)。commit しません"
  exit $rc
fi

# --- 2. 他に未コミット変更があれば今回分は commit しない ---
#    データ以外の作業が混ざったまま commit すると、追跡外のファイルまで
#    巻き込む・あるいは巻き込まれ損なうので、警告してスキップする
if ! git diff --quiet -- . ':(exclude)webui/data'; then
  log "WARNING: webui/data 以外に未コミット変更があるため、今回分は commit せず残置"
  git status --short -- . ':(exclude)webui/data' | head -20
  exit 0
fi

# --- 3. データファイルの変更を add（-u 必須: webui/data は ignore 済み） ---
git add -u -- webui/data 2>/dev/null
if git diff --cached --quiet -- webui/data; then
  log "データに変更なし（登録者数が変わらない日）。commit せず終了"
  exit 0
fi

# --- 4. commit（空コミットを作らない） ---
DATE="$(TZ=Asia/Tokyo date '+%Y/%m/%d')"
git commit -q -m "chore(data): ${DATE} の登録者数を自動更新

scripts/ops/update-subscribers.js が日次で取得・追記した webui/data/*.txt の差分。
cron: scripts/ops/update-subscribers-and-commit.sh" -- webui/data
log "commit しました: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"

# --- 5. 自動 push ---
#   毎晩の data コミットを origin へ反映し、ローカルを origin と同期させる。
#   データ変更があった日（= commit した場合）のみ push するため、
#   何もない日に余計な push を行わない。
#   push に失敗しても commit は既に済んでいるため、次回実行時に再送される。
if ! git push origin main 2>&1; then
  log "ERROR: git push に失敗しました。origin/main が進んでいる場合は手動で rebase してください"
  exit 1
fi
log "push 完了: origin/main = $(git rev-parse --short origin/main)"
