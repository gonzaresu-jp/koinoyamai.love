#!/usr/bin/env node
/**
 * apply-mai-chat-elza.js — nginx.conf の elza vhost に「まいAI チャット」の location を追加する
 *
 * 対象: /etc/nginx/nginx.conf の `server_name elza.poitou-mora.ts.net` の
 *       server ブロックに、`location = /chat.html` 等を差し込む。
 *
 * 方針（apply-display-location.js と共通）:
 *   - 冪等: すでに elza vhost に適用済みなら「適用済み」と報告して exit 0
 *     （outPath が指定された場合は nginx.conf の内容をそのまま書き出す。
 *       呼び出し側の cmp で「差分なし＝適用済み」と判定できるようにする）
 *   - fail-closed: アンカーが見つからない・複数ある場合は **何も書き換えず** exit 1
 *   - 挿入位置は `location = /admin.html { ... }` ブロックの直後
 *     （admin 静的リソースの並びに合わせる）
 *   - 適用済み判定は **elza server ブロックの中だけ**を見る
 *     （他 vhost に将来 `location = /chat.html` が増えても誤判定しない）
 *   - ブロック本文は scripts/nginx/mai-chat-elza.conf から読む（コメントヘッダは除く）
 *
 * 挿入位置の決め方（apply-display-location.js と同じ解析上の注意）:
 *   nginx.conf のコメントや引用符の中に `{` `}` が含まれることがあるため、
 *   先に「コメント・引用符」を空白にマスクした **長さ不変**の文字列を作り、
 *   そのマスク版で brace 深さを数える（インデックスが元の文字列と一致する）。
 *
 * 使い方:
 *   node apply-mai-chat-elza.js <nginx.conf> <block.conf> [outfile]
 *     outfile を省略した場合は <nginx.conf> を直接書き換える
 *     （atomic 化するため、実運用では .sh 側で temp に書き出してから install する）
 */
const fs = require('fs')

const [confPath, blockPath, outPath] = process.argv.slice(2)
if (!confPath || !blockPath) {
  console.error('usage: node apply-mai-chat-elza.js <nginx.conf> <block.conf> [outfile]')
  process.exit(2)
}

const conf = fs.readFileSync(confPath, 'utf8')
const rawBlock = fs.readFileSync(blockPath, 'utf8')

/**
 * コメント・引用符を空白にマスクする（長さ不変）。
 */
function maskNoise(text) {
  const out = text.split('')
  const n = text.length
  let i = 0
  let inQuote = null
  while (i < n) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i += 2; continue }
      if (ch === inQuote) { inQuote = null; out[i] = ' '; i++; continue }
      out[i] = ' '
      i++
      continue
    }
    if (ch === '"' || ch === "'") { inQuote = ch; out[i] = ' '; i++; continue }
    if (ch === '#') {
      while (i < n && text[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    i++
  }
  return out.join('')
}

/** depth 一致で `openIdx`（'{' の位置）に対応する '}' の位置を返す */
function matchBrace(masked, openIdx) {
  let depth = 0
  for (let i = openIdx; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// コメントヘッダ（先頭の # 連続部分）を除いた実体だけを使う
const lines = rawBlock.split('\n')
let start = 0
while (start < lines.length && (lines[start].trim() === '' || lines[start].trim().startsWith('#'))) start++
const block = lines.slice(start).join('\n').replace(/\s+$/, '')
if (!block.trim()) {
  console.error('ABORT: block file has no content')
  process.exit(2)
}

const MARK = 'location = /chat.html'

const masked = maskNoise(conf)

// --- server_name elza.poitou-mora.ts.net の server ブロックを探す ---
// 行頭の `server {` だけを候補にする（`location = /server {` を誤検出しない）
const serverRe = /^[ \t]*server\s*\{/gm
let match
let target = null
while ((match = serverRe.exec(masked)) !== null) {
  const openIdx = match.index + match[0].length - 1 // '{' の位置
  const endIdx = matchBrace(masked, openIdx)
  if (endIdx === -1) continue
  const body = masked.slice(openIdx, endIdx)
  if (!/server_name\s+[^;]*elza\.poitou-mora\.ts\.net/.test(body)) continue
  if (target) {
    console.error('ABORT: elza.poitou-mora.ts.net の server ブロックが複数あります')
    process.exit(1)
  }
  target = { openIdx, endIdx }
}

if (!target) {
  console.error('ABORT: `server_name elza.poitou-mora.ts.net` の server ブロックが見つかりません')
  process.exit(1)
}

const span = masked.slice(target.openIdx, target.endIdx)

// --- 既に適用済みか（elza vhost の中だけを見る） ---
if (span.includes(MARK)) {
  if (outPath) fs.writeFileSync(outPath, conf, 'utf8')
  console.log(`SKIP: 適用済み（${MARK} が elza vhost に存在）`)
  process.exit(0)
}

// --- その中の `location = /admin.html {` を探す（一意であること） ---
const anchorRe = /location\s*=\s*\/admin\.html\s*\{/g
const anchors = []
while ((match = anchorRe.exec(span)) !== null) anchors.push(match)
if (anchors.length !== 1) {
  console.error(`ABORT: \`location = /admin.html\` が ${anchors.length} 件あります（1 件である必要があります）`)
  process.exit(1)
}
const anchorOpenAbs = target.openIdx + anchors[0].index + anchors[0][0].length - 1 // '{' の絶対位置
const anchorCloseAbs = matchBrace(masked, anchorOpenAbs)
if (anchorCloseAbs === -1) {
  console.error('ABORT: `location = /admin.html` の閉じ括弧を特定できません')
  process.exit(1)
}

// --- 挿入位置: admin.html location ブロックの直後（行末の改行まで含めた位置） ---
let insertPos = anchorCloseAbs + 1
if (conf[insertPos] === '\n') insertPos++

const payload = block + '\n'
const out = conf.slice(0, insertPos) + payload + conf.slice(insertPos)

const dest = outPath || confPath
fs.writeFileSync(dest, out, 'utf8')
console.log(`OK: ${MARK} 群を elza vhost（server_name elza.poitou-mora.ts.net）へ追加しました`)
console.log(`   挿入位置: ` + out.slice(0, insertPos).split('\n').length + ' 行目付近')
if (dest !== confPath) console.log(`   書き出し先: ${dest}（atomic install は呼び出し側）`)
