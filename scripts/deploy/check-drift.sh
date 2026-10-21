#!/bin/bash
# staging と本番（main）のドリフトを検出する
#
# 使い方:
#   bash scripts/deploy/check-drift.sh            … 乖離の有無を報告して終了（差分表示あり）
#   bash scripts/deploy/check-drift.sh --quiet    … 乖離の有無のみ（cron 用）
#
# なぜ必要か（2026-09-26 の実例）:
#   service-worker.js が prod は v3.72、staging は v3.71 のまま乖離したまま
#   検出されず、staging では v3.72 の挙動（?v= の passthrough /
#   navigationPreload）が検証できない状態が数か月続いていた。
#   つまり **staging が本番の挙動を再現していない**状態でテストوجيهを積んでいた。
#
#   検出対象:
#   1. git の乖離（staging ブランチが origin/main から何コミット離れているか）
#   2. ワークツリーの内容差分（未コミットやブランチ取り違えによる差）
#   3. 両ツリーの Service Worker バージョン  #
#   4. 主要な実行ファイルの mtime 新旧（デプロイの追随漏れ）
#
# 終了コード:
#   0 = 乖離なし
#   1 = 乖離あり
#   2 = 前提不成立（ディレクトリが無い等）
set -uo pipefail

PROD_DIR="${PROD_DIR:-/var/www/html/koinoyamai.love}"

# staging ツリーの解決（2026-10-20 修正）:
#   以前はパスを固定していたため、staging の git worktree が別の場所へ移ると
#   別ツリー（または存在しないパス）を見て誤検知した。優先順位は次のとおり:
#     1. 環境変数 STG_DIR
#     2. 本番リポジトリの worktree 一覧から branch refs/heads/staging のもの
#     3. 従来既定 /home/yuzuki/koinoyamai.love-test
resolve_stg_dir() {
  if [ -n "${STG_DIR:-}" ]; then echo "$STG_DIR"; return; fi
  local d
  d=$(git -C "$PROD_DIR" worktree list --porcelain 2>/dev/null \
      | awk '/^worktree /{wt=substr($0,10)} /^branch refs\/heads\/staging$/{print wt; exit}')
  if [ -n "$d" ]; then echo "$d"; return; fi
  echo "/home/yuzuki/koinoyamai.love-test"
}
STG_DIR="$(resolve_stg_dir)"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

say() { [ $QUIET -eq 1 ] || echo "$@"; }
drift=0

[ -d "$PROD_DIR/.git" ] || [ -f "$PROD_DIR/.git" ] || { echo "ERROR: 本番ツリーが見つかりません: $PROD_DIR" >&2; exit 2; }
[ -d "$STG_DIR/.git" ] || [ -f "$STG_DIR/.git" ] || { echo "ERROR: staging ツリーが見つかりません: $STG_DIR" >&2; exit 2; }

say "=== staging / 本番 ドリフト検査 ==="
say "  本番  : $PROD_DIR"
say "  staging: $STG_DIR"

# --- 1. git ブランチの乖離 ---
PROD_HEAD=$(git -C "$PROD_DIR" rev-parse --short HEAD 2>/dev/null)
STG_HEAD=$(git -C "$STG_DIR" rev-parse --short HEAD 2>/dev/null)
STG_AHEAD=$(git -C "$STG_DIR" rev-list --count origin/main..HEAD 2>/dev/null || echo '?')
STG_BEHIND=$(git -C "$STG_DIR" rev-list --count HEAD..origin/main 2>/dev/null || echo '?')

say ""
say "[1] git ブランチ"
say "  本番 HEAD  : $PROD_HEAD"
say "  staging HEAD: $STG_HEAD (origin/main  ahead $STG_AHEAD / behind $STG_BEHIND)"

# origin/main が先行している commit が「webui/data のみの変更」なら、
# update-subscribers-and-commit.sh が毎晩 00:05 に作る自動コミットであり、
# staging が遅れるのは正常（データは生成物なので staging への追従は不要）。
# その場合は「コード乖離ではない」と判定し、誤報を排除する。
CODE_ONLY=""
if [ "$STG_BEHIND" != "0" ] && [ "$STG_AHEAD" = "0" ]; then
  CODE_ONLY=$(git -C "$STG_DIR" diff --name-only HEAD..origin/main 2>/dev/null \
    | grep -v '^webui/data/' || true)
fi

if [ "$STG_AHEAD" != "0" ]; then
  echo "  ⚠ 乖離あり: staging に独自コミット（ahead $STG_AHEAD）があります" >&2
  drift=1
elif [ "$STG_BEHIND" != "0" ] && [ -n "$CODE_ONLY" ]; then
  say "  ⚠ コード乖離あり: staging が behind $STG_BEHIND。webui/data 以外の差分:"
  printf '%s\n' "$CODE_ONLY" | head -15 | sed 's/^/       /'
  drift=1
elif [ "$STG_BEHIND" != "0" ]; then
  say "  ✓ staging は behind $STG_BEHIND だが webui/data のみ（毎晩の自動コミットのため正常）"
else
  say "  ✓ staging は origin/main に追従"
fi

# --- 2. Service Worker のバージョン ---
say ""
say "[2] Service Worker バージョン"
sw_ver() { grep -oP "const VERSION = '\K[^']+" "$1" 2>/dev/null || echo "(なし)"; }
PROD_SW=$(sw_ver "$PROD_DIR/webui/service-worker.js")
STG_SW=$(sw_ver "$STG_DIR/webui/service-worker.js")
say "  本番  : $PROD_SW"
say "  staging: $STG_SW"
if [ "$PROD_SW" != "$STG_SW" ]; then
  echo "  ⚠ 乖離あり: Service Worker のバージョンが異なります（staging が本番の挙動を再現していない）" >&2
  drift=1
else
  say "  ✓ バージョン一致"
fi

# --- 3. 実行中のコードと作業ツリーの追随 ---
say ""
say "[3] ファイル内容の一致（主要ファイル）"
# .byte比較で改行コード差も検出する（SHA で厳密に）
MISMATCH=0
for f in server.js main.js package-lock.json webui/service-worker.js webui/index.php webui/header.php; do
  pa="$PROD_DIR/$f"; sa="$STG_DIR/$f"
  [ -f "$pa" ] && [ -f "$sa" ] || continue
  ph=$(md5sum "$pa" | cut -d' ' -f1); sh=$(md5sum "$sa" | cut -d' ' -f1)
  if [ "$ph" = "$sh" ]; then
    say "  ✓ $f"
  else
    say "  ✗ $f （内容が異なります）"
    MISMATCH=1
  fi
done
[ $MISMATCH -eq 1 ] && drift=1

# --- 3.5 node_modules が package-lock.json に追随しているか ---
# git pull は lockfile しか更新しないため、node_modules が旧版のままでは
# 「lockfile では安全 / 実際のコードは脆弱」という食い違いが起きる。
# npm audit も lockfile 基準なので、この乖離を検出しないと監視が嘘を言う。
say ""
say "[3.5] node_modules と package-lock.json の乖離"
NM_DRIFT=0
for d in "$PROD_DIR" "$STG_DIR"; do
  who=$(basename "$d")
  out=$(cd "$d" && node -e '
const lock = require("./package-lock.json");
const pkgs = ["proxy-addr","sharp","esbuild","undici","follow-redirects","firebase-admin","puppeteer","sqlite3","bcrypt"];
const out = [];
for (const name of pkgs) {
  const locked = lock.packages && lock.packages["node_modules/"+name] && lock.packages["node_modules/"+name].version;
  let installed = null;
  try { installed = require("./node_modules/"+name+"/package.json").version; } catch (e) {}
  if (locked && installed && locked !== installed) out.push(`${name} lock=${locked} installed=${installed}`);
  else if (locked && !installed) out.push(`${name} lock=${locked} installed=(未インストール)`);
}
console.log(out.join("\n"));
' 2>/dev/null || echo "")
  if [ -n "$out" ]; then
    say "  ⚠ $who : node_modules が lockfile に追随していません"
    echo "$out" | sed 's/^/       /' | while IFS= read -r line; do say "$line"; done
    NM_DRIFT=1
  else
    say "  ✓ $who : 乖離なし"
  fi
done
[ $NM_DRIFT -eq 1 ] && drift=1

# --- 4. 未コミット変更 ---
say ""
say "[4] 未コミット変更"
for d in "$PROD_DIR" "$STG_DIR"; do
  n=$(git -C "$d" status --porcelain 2>/dev/null | grep -c '^ M' || true)
  who=$(basename "$d")
  if [ "$n" -gt 0 ]; then
    say "  ⚠ $who : 追跡済みファイルに $n 件の未コミット変更"
    git -C "$d" status --short 2>/dev/null | grep '^ M' | head -10 | sed 's/^/       /'
    drift=1
  else
    say "  ✓ $who : クリーン"
  fi
done

# --- 判定 ---
say ""
if [ $drift -eq 0 ]; then
  say "=== 結論: 乖離なし ==="
else
  say "=== 結論: 乖離あり（是正コマンド） ==="
  say "  staging を本番に追従させる:"
  say "    cd $STG_DIR && git fetch origin && git reset --hard origin/main"
  say "  追跡済みファイルの未コミット変更は commit か stash で解消"
fi
exit $drift
