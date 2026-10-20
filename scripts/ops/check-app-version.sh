#!/usr/bin/env bash
# check-app-version.sh - Windows アプリのバージョン3箇所の整合を検査する
#
# なぜ必要か（AGENTS.md §10.1）:
#   バージョンは3箇所に分散している。
#     1) Windows/mai-push-winui/MaiPushWinUI.csproj  <Version>
#     2) Windows/mai-push-winui/installer.iss       #define MyAppVersion
#     3) Windows/mai-push-winui/UpdateChecker.cs    CurrentVersion
#   1箇所だけ更新すると「最新版なのに更新通知が出る/出ない」事故になる
#   （UpdateChecker.cs を忘れると、更新通知が一切出なくなる）。
#   公開リポジトリにビルド成果物は載せないため、CI 検査で守る。
#
# 使い方:
#   bash scripts/ops/check-app-version.sh          # 検査（不一致なら exit 1）
#   bash scripts/ops/check-app-version.sh --show   # 取得されたバージョンだけ表示
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

CSPROJ="Windows/mai-push-winui/MaiPushWinUI.csproj"
ISS="Windows/mai-push-winui/installer.iss"
UPDATER="Windows/mai-push-winui/UpdateChecker.cs"

for f in "$CSPROJ" "$ISS" "$UPDATER"; do
    [ -f "$f" ] || { echo "error: $f が見つかりません" >&2; exit 2; }
done

# 1) csproj: <Version>x.y.z</Version>
V_CSPROJ=$(sed -n 's:.*<Version>\([0-9][0-9.]*\)</Version>.*:\1:p' "$CSPROJ" | head -1)
# 2) installer.iss: #define MyAppVersion "x.y.z"
V_ISS=$(sed -n 's:^#define MyAppVersion "\([0-9][0-9.]*\)".*:\1:p' "$ISS" | head -1)
# 3) UpdateChecker.cs: new(1, 8, 5) → 1.8.5
V_UPDATER=$(sed -n 's/.*CurrentVersion = new(\([0-9]\+\), *\([0-9]\+\), *\([0-9]\+\)).*/\1.\2.\3/p' "$UPDATER" | head -1)

if [ "${1:-}" = "--show" ]; then
    echo "csproj=$V_CSPROJ installer.iss=$V_ISS UpdateChecker.cs=$V_UPDATER"
    exit 0
fi

echo "=== アプリバージョン整合チェック ==="
printf '  %-46s %s\n' "$CSPROJ" "${V_CSPROJ:-（取得失敗）}"
printf '  %-46s %s\n' "$ISS" "${V_ISS:-（取得失敗）}"
printf '  %-46s %s\n' "$UPDATER" "${V_UPDATER:-（取得失敗）}"

missing=""
[ -z "$V_CSPROJ" ] && missing="$missing $CSPROJ"
[ -z "$V_ISS" ] && missing="$missing $ISS"
[ -z "$V_UPDATER" ] && missing="$missing $UPDATER"
if [ -n "$missing" ]; then
    echo "✗ バージョンを取得できないファイル:$missing" >&2
    exit 1
fi

if [ "$V_CSPROJ" = "$V_ISS" ] && [ "$V_CSPROJ" = "$V_UPDATER" ]; then
    echo "✓ 3箇所すべて $V_CSPROJ で一致"
else
    echo "✗ バージョンが不一致です（csproj=$V_CSPROJ / installer.iss=$V_ISS / UpdateChecker.cs=$V_UPDATER）" >&2
    echo "  3箇所を同じバージョンにしてください（AGENTS.md §10.1）" >&2
    exit 1
fi

# 参考: 配布済み feed（desktop.json）のバージョン。release 時に更新される想定なので
# 不一致でも失敗にはしない（表示のみ）。
FEED="webui/dl/desktop.json"
if [ -f "$FEED" ]; then
    V_FEED=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$FEED" | head -1)
    echo "  参考: $FEED = ${V_FEED:-（取得失敗）}"
    if [ -n "$V_FEED" ] && [ "$V_FEED" != "$V_CSPROJ" ]; then
        echo "  参考: アプリ版と配布 feed のバージョンが異なります（release 時は揃えること）"
    fi
fi
