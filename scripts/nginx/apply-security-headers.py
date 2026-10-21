#!/usr/bin/env python3
"""
scripts/nginx/apply-security-headers.py - nginx 設定にセキュリティヘッダの include を挿入する

背景（2026-10-21 実測）:
  nginx の `add_header` は、**Location ブロック内に 1 つでも add_header があると
  server レベルの add_header を継承しない**。
  公開 vhost は Cache-Control / Pragma / Expires を Location ごとに書いていたため、
  server レベルに置いていた CSP / X-Frame-Options などが
  **PHP を配信するページ（サイトの本体）からは全く出ていなかった**。
  → 公開ページが クリックジャッキング（frame-ancestors なし）と XSS 緩和の双方で無防備。

やること:
  add_header を自前で持つ Location ブロックに
  `include /etc/nginx/snippets/mai-security-headers.conf;` を挿入する。

対象から除外する Location:
  - Node API へ proxy する Location（API 側は helmet が同じヘッダを返すため。
    二重になるとヘッダが重複して intersection になる）
  - 既に include 済みの Location（冪等）

使い方:
  python3 scripts/nginx/apply-security-headers.py --dry-run /etc/nginx/nginx.conf
  python3 scripts/nginx/apply-security-headers.py /etc/nginx/nginx.conf
"""
import argparse
import re
import sys

SNIPPET = "/etc/nginx/snippets/mai-security-headers.conf"
INCLUDE_LINE = f"    include {SNIPPET};"
# Node API のポートへ proxy する Location は除外（helmet が同じヘッダを返す）
API_PORTS = ("8080", "8081")


def strip_noise(line: str) -> str:
    """コメントとクォート内の文字を除いた、括弧カウント用の文字列"""
    out = []
    in_s = None
    i = 0
    while i < len(line):
        c = line[i]
        if in_s:
            if c == "\\":
                i += 2
                continue
            if c == in_s:
                in_s = None
            i += 1
            continue
        if c in ("'", '"'):
            in_s = c
            i += 1
            continue
        if c == "#":
            break
        out.append(c)
        i += 1
    return "".join(out)


def find_locations(lines):
    """(開始行index, 終了行index, パターン, ブロック行) のリストを返す"""
    locs = []
    n = len(lines)
    i = 0
    while i < n:
        m = re.search(r"location\s+([^{]*?)\s*\{", strip_noise(lines[i]))
        if not m:
            i += 1
            continue
        # ブロックの終端を探す（同じ行で閉じてる 1行 location も 1 個の location として扱う）
        depth = 0
        j = i
        end_line = i
        while j < n:
            s = strip_noise(lines[j])
            depth += s.count("{") - s.count("}")
            if depth <= 0 and j >= i:
                end_line = j
                break
            j += 1
        block = lines[i:end_line + 1]
        locs.append((i, end_line, m.group(1).strip(), block))
        # 1行 location（同じ行で閉じたもの）なら次の行へ、そうでなければブロック終端の次へ
        i = end_line + 1
    return locs


def has_add_header(block):
    """add_header の有無（行頭限定にしない。1行 location でも検出できるようにする）"""
    for b in block:
        if re.search(r"(?:^|[;{])\s*add_header\b", strip_noise(b)):
            return True
    return False


def has_api_proxy(block):
    """Node API へ proxy しているか（ポートは数値で厳密に照合する）"""
    for b in block:
        s = strip_noise(b)
        if "proxy_pass" not in s:
            continue
        if re.search(r":(8080|8081)\b", s):
            return True
    return False


def has_if_with_add_header(block):
    """if ブロック内に add_header があるか（その場合 include を入れても効かない）"""
    for b in block:
        if re.search(r"\bif\s*\(", strip_noise(b)):
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    total_patched = 0
    for path in args.files:
        with open(path, encoding="utf-8") as f:
            lines = f.read().split("\n")

        # 後ろから処理して行番号のずれを避ける
        inserts = []  # (行index, 内容, location パターン)
        skipped = []  # (行index, パターン, 理由)
        for start, end, pattern, block in find_locations(lines):
            body = "\n".join(block)
            if not has_add_header(block):
                continue  # server レベルを継承する（何もしなくてよい）
            if has_api_proxy(block):
                skipped.append((end, pattern, "Node API へ proxy（helmet が同等のヘッダを返す）"))
                continue  # 二重 include は避ける
            if SNIPPET in body:
                skipped.append((end, pattern, "既に include 済み"))
                continue
            if has_if_with_add_header(block):
                # if ブロック内の add_header も継承を切るため、Location レベル include では効かない。
                # 黙って通過させないので、除外として明示する（人手対応）。
                skipped.append((end, pattern, "if ブロック内に add_header あり（include では効かない・要手動対応）"))
                continue
            inserts.append((end, INCLUDE_LINE, pattern))

        if not inserts:
            print(f"[{path}] 変更不要（対象 Location なし / 既に include 済み）")
            continue

        print(f"[{path}] {len(inserts)} 個の Location に include を挿入します:")
        for end, _text, pattern in inserts:
            print(f"  - {end + 1} 行目付近: location {pattern}")
        if skipped:
            print(f"  除外（{len(skipped)} 個）:")
            for end, pattern, reason in skipped:
                print(f"    - location {pattern} … {reason}")

        if args.dry_run:
            total_patched += len(inserts)
            continue

        for end, text, _pattern in sorted(inserts, reverse=True):
            lines.insert(end, text)
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print(f"[{path}] 書き込みました（{len(inserts)} 件）")
        total_patched += len(inserts)

    print()
    print(f"合計: {total_patched} 箇所")
    if total_patched and not args.dry_run:
        print("→ nginx -t で構文確認 → systemctl reload nginx で反映")
    return 0


if __name__ == "__main__":
    sys.exit(main())
