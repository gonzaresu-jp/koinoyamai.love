#!/usr/bin/env bash
# コード行数集計スクリプト（updateLogs の "lines" 値の公式計測方法）
#
# 集計対象: git 追跡ファイル
# 除外対象: 生成物・ビルド出力・素材、およびアプリ本体
#   （Web サーバー側のコード量を追うため、デスクトップ/Android アプリは含めない）
#   - webui/dist/ 全体（esbuild による minify 済み出力）
#   - *.min.js / *.min.css（分散している minify 済みファイル）
#   - package-lock.json（npm が自動生成するロックファイル）
#   - *.svg（アイコン素材）
#   - webui/compare.html（比較レポート用の自動生成HTML）
#   - mai_notification/（Android アプリ）
#   - Windows/（デスクトップアプリ）
#
#   ※ アプリ2種は git 追跡の開始時期が違う（Windows 2026-06-14 /
#      Android 2026-09-27）ため、除外しないとグラフが段差になる。
#
# 使い方:
#   scripts/ops/count-lines.sh                 # 現在の作業ツリーで集計
#   scripts/ops/count-lines.sh <rev>           # 過去のコミット時点の内容を集計（例: a033353）
#
# 過去時点は git archive で当時のファイルを一時展開してから集計する。
# ファイル名だけ過去・中身は作業ツリーから読む方式では、後から増えた行まで
# 過去値に混ざってしまうため（実測で 09-19 と 09-10 が同値になる等）使わない。
#
# 出力: cloc の SUM code 行数（最終行の SUM の code 列）

set -euo pipefail

if [ $# -gt 1 ]; then
    echo "usage: $0 [<git-rev>]" >&2
    exit 2
fi

REV="${1:-}"
EXCL='(^webui/dist/|\.min\.(js|css)$|package-lock\.json$|\.svg$|^webui/compare\.html$|^mai_notification/|^Windows/)'

# cloc は「現在の作業ディレクトリ」基準でファイルを開くため、展開先で実行すること。
# パイプで渡すとスクリプト起動時の CWD（作業ツリー）を読んでしまう。
count_tree() {
    local root="$1" list
    list="$(mktemp)"
    find "$root" -type f | sed "s|^$root/||" | grep -vE "$EXCL" > "$list" || true
    (
        cd "$root"
        cloc --list-file="$list" --quiet 2>/dev/null
    ) | awk -F' ' '/^SUM:/ {print $NF}'
    rm -f "$list"
}

if [ -z "$REV" ]; then
    git ls-files | grep -vE "$EXCL" | cloc --list-file=/dev/stdin --quiet 2>/dev/null \
        | awk -F' ' '/^SUM:/ {print $NF}'
    exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git archive --format=tar "$REV" | tar -x -C "$TMP"
count_tree "$TMP"
