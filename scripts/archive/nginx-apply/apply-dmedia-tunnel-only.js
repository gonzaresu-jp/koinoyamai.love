#!/usr/bin/env node
/**
 * apply-dmedia-tunnel-only.js — Discord 専用メディア（/dmedia/）を tunnel 経由のみに限定する
 *
 * 対象: /etc/nginx/discord.conf の `location ^~ /dmedia/` ブロック
 *
 * なぜ必要か（2026-10-22 実測に基づく）:
 *   - `discord.honna-yuzuki.com` の DNS は **既に cloudflared tunnel（mai トンネル）を
 *     指している**（CNAME → <tunnel-uuid>.cfargotunnel.com / proxied=true）。
 *     tunnel のリモート設定にも `discord.honna-yuzuki.com → http://localhost:80` がある。
 *   - origin の :80 はインターネットから到達できない
 *     （access.log の全 rotation で peer は 127.0.0.1 / LAN / Tailscale のみ）。
 *   - つまり「外から直接叩けない」ことは*tunnel 経由の副作用*に依存しているだけで、
 *     nginx 側では **どこから来たリクエストでも受け付けている**。
 *   - 残りの穴は UA 判定 1 枚だけ。UA はクライアントが自由に設定できるので
 *     `curl -A Discordbot` で取得できる（実測済み: 200 / 実ファイル）。
 *
 * やること:
 *   - `location ^~ /dmedia/` に以下を挿入する（cloudflared は 127.0.0.1 から接続する）:
 *       allow 127.0.0.1;
 *       allow ::1;
 *       deny  all;
 *   - UA 判定（`if ($http_user_agent !~* "Discordbot") { return 403; }`）はそのまま残す。
 *     rewrite フェーズ（if）が access フェーズ（allow/deny）より先に走るため、
 *     Discordbot 以外の UA は従来どおり 403、Discordbot でも tunnel 以外からは 403。
 *
 * 方針（apply-php-exec-guard.js と共通）:
 *   - 冪等（適用済みマーカー **かつ** 規則（deny all）がブロック内にあれば exit 0）
 *     ※ マーカーだけ残して規則が欠落している場合は「自己修復」する（再挿入）。
 *   - fail-closed（アンカーが 0 件 or 複数なら **何も書かず** exit 1）
 *   - **outfile は必須**（in-place 書き込みは禁止。バックアップも `nginx -t` 検証も
 *     無い状態で実 conf を壊すため）
 *
 * 使い方:
 *   node apply-dmedia-tunnel-only.js <discord.conf> <outfile>
 */
const fs = require('fs')

const [confPath, outPath] = process.argv.slice(2)
if (!confPath || !outPath) {
  console.error('usage: node apply-dmedia-tunnel-only.js <discord.conf> <outfile>')
  console.error('  ※ outfile は必須（in-place 書き込みは禁止）')
  process.exit(2)
}

const conf = fs.readFileSync(confPath, 'utf8')
const MARK = 'dmedia-tunnel-only'

// 改行コードは元の conf に合わせる（CRLF の conf に LF を混ぜない）
const EOL = conf.includes('\r\n') ? '\r\n' : '\n'

/** アンカー: 行頭の `location ^~ /dmedia/ {`（コメント行は拾わない） */
const anchorRe = /^[ \t]*location[ \t]+\^~[ \t]*\/dmedia\/[ \t]*\{/gm
const anchors = []
let mt
while ((mt = anchorRe.exec(conf)) !== null) {
  anchors.push({ index: mt.index, text: mt[0] })
}
if (anchors.length !== 1) {
  console.error(`ABORT: \`location ^~ /dmedia/ {\` が ${anchors.length} 件見つかりました（1 件である必要あり）`)
  process.exit(1)
}
const anchor = anchors[0]

const anchorLineStart = conf.lastIndexOf('\n', anchor.index) + 1
const anchorLineEnd = conf.indexOf('\n', anchor.index + anchor.text.length)
const anchorLine = conf.slice(anchorLineStart, anchorLineEnd === -1 ? conf.length : anchorLineEnd)

/** アンカー行のインデント */
const anchorIndent = (/^[ \t]*/.exec(anchorLine) || [''])[0]

/** location ブロックの終端行を探す（`{` / `}` の行数カウント。コメントは対象外） */
function findBlockEnd(lines, startIdx) {
  let depth = 0
  for (let i = startIdx; i < lines.length; i++) {
    const code = lines[i].replace(/#.*$/, '')
    for (const ch of code) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return i
      }
    }
  }
  return -1
}

/** 規則として扱う行（コメント行 + allow/deny 3 行） */
const RULE_LINES = new Set(['allow 127.0.0.1;', 'allow ::1;', 'deny  all;'])

const lines = conf.split(EOL)
// アンカー行の行番号を特定する
let anchorIdx = -1
{
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    if (pos === anchorLineStart) { anchorIdx = i; break }
    pos += lines[i].length + EOL.length
  }
  if (anchorIdx === -1) {
    console.error('ABORT: アンカー行の特定に失敗しました')
    process.exit(1)
  }
}

const blockEndIdx = findBlockEnd(lines, anchorIdx)
if (blockEndIdx === -1) {
  console.error('ABORT: `location ^~ /dmedia/ {` のブロック終端が見つかりません')
  process.exit(1)
}

/** ブロック内で「前回の挿入分」に該当する行（マーカー or 規則行）を特定 */
const staleIdx = []
for (let i = anchorIdx + 1; i < blockEndIdx; i++) {
  const t = lines[i].trim()
  if (lines[i].includes(MARK) || RULE_LINES.has(t)) staleIdx.push(i)
}

const hasRule = staleIdx.some((i) => RULE_LINES.has(lines[i].trim()))

if (staleIdx.length > 0 && hasRule) {
  // 適用済み（マーカーも規則もある）→ 出力は元の conf のまま
  console.log(`SKIP: 適用済み（${MARK} マーカーと規則が存在）`)
  fs.writeFileSync(outPath, conf)
  process.exit(0)
}

// 挿入ブロック（アンカーの直後）
// インデントは「アンカー直後の最初の非空行」を使う（空行ならアンカー+4）
let inner = anchorIndent + '    '
for (let i = anchorIdx + 1; i < blockEndIdx; i++) {
  if (lines[i].trim() === '') continue
  inner = (/^[ \t]*/.exec(lines[i]) || [''])[0]
  break
}

const insertLines = [
  '',
  `${inner}# ★ ${MARK}（2026-10-22）: tunnel 経由のみで許可する。`,
  `${inner}#   cloudflared は 127.0.0.1（/::1）から接続するので、この許可リストで`,
  `${inner}#   「origin へ直接叩かれた場合」を全て 403 にできる。`,
  `${inner}#   UA 判定（User-Agent=Discordbot のみ許可）は UA を偽装できるため`,
  `${inner}#   保護としては不十分。URL 側は 128bit ランダム ID で推測不能にしてある。`,
  `${inner}allow 127.0.0.1;`,
  `${inner}allow ::1;`,
  `${inner}deny  all;`,
]

// 前回の挿入分（マーカーだけ残って規則が欠落していた場合）を取り除いてから入れ直す
const keep = lines.filter((_, i) => !staleIdx.includes(i))
const anchorIdxAfter = keep.findIndex((l) => /^[\t ]*location[\t ]+\^~[\t ]*\/dmedia\/[\t ]*\{/.test(l))
if (anchorIdxAfter === -1) {
  console.error('ABORT: 除去後にアンカーを特定できませんでした')
  process.exit(1)
}
keep.splice(anchorIdxAfter + 1, 0, ...insertLines)

const out = keep.join(EOL)
fs.writeFileSync(outPath, out, 'utf8')
console.log(`OK: /dmedia/ に tunnel 限定（allow 127.0.0.1 / ::1, deny all）を追加しました（${MARK}）`)
if (staleIdx.length > 0) {
  console.log(`   既存の不完全な挿入分（${staleIdx.length} 行）を除去して正規のブロックに差し替えました`)
}
console.log(`   書き出し先: ${outPath}（差し替えは呼び出し側）`)
