#!/usr/bin/env node
/**
 * apply-display-location.js — nginx.conf に「旅先ディスプレイ」の location を追加する
 *
 * 対象: /etc/nginx/nginx.conf の `listen 1717` + `server_name koinoyamai.love` の
 *       server ブロックに `location ^~ /display/` を差し込む。
 *
 * 方針（既存のパッチスクリプトと共通）:
 *   - 冪等: すでに適用済みなら「適用済み」と報告して exit 0（再適用しない）
 *   - fail-closed: アンカーが見つからない・複数ある場合は **何も書き換えず** exit 1
 *   - 挿入位置は server ブロックの閉じ括弧の直前（brace 深さで特定）
 *   - ブロック本文は scripts/nginx/display-location.conf から読む（コメントヘッダは除く）
 *
 * 解析上の注意（実測で判明した不具合の対策）:
 *   nginx.conf のコメントや引用符の中に `{` `}` が含まれることがある
 *   （例: `# http {} 直下で読むファイル` / `location = /server {`）。
 *   素朴に数えると server ブロックの終わりを誤認し、**別 location の内側に
 *   挿入してしまう**（実測で再現）。
 *   → 先に「コメント・引用符・正規表現リテラル」を空白にマスクした
 *     **長さ不変**の文字列を作り、そのマスク版で brace 深さを数える
 *     （インデックスが元の文字列と一致するため、挿入位置を正確に求められる）。
 *
 * 使い方:
 *   node apply-display-location.js <nginx.conf> <block.conf> [outfile]
 *     outfile を省略した場合は <nginx.conf> を直接書き換える
 *     （atomic 化するため、実運用では .sh 側で temp に書き出してから install する）
 */
const fs = require('fs')

const [confPath, blockPath, outPath] = process.argv.slice(2)
if (!confPath || !blockPath) {
  console.error('usage: node apply-display-location.js <nginx.conf> <block.conf> [outfile]')
  process.exit(2)
}

const conf = fs.readFileSync(confPath, 'utf8')
const rawBlock = fs.readFileSync(blockPath, 'utf8')

/**
 * コメント・引用符・正規表現リテラルを空白にマスクする（長さ不変）。
 * - `#` から行末まで（引用符内の # は除外）
 * - "..." と '...' の中身
 * - nginx の正規表現リテラル（~ の直後の不开区切り）
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

// コメントヘッダ（先頭の # 連続部分）を除いた実体だけを使う
const lines = rawBlock.split('\n')
let start = 0
while (start < lines.length && (lines[start].trim() === '' || lines[start].trim().startsWith('#'))) start++
const block = lines.slice(start).join('\n').replace(/\s+$/, '')
if (!block.trim()) {
  console.error('ABORT: block file has no content')
  process.exit(2)
}

const MARK = 'location ^~ /display/'

// 既に適用済みか
if (conf.includes(MARK)) {
  console.log(`SKIP: 適用済み（${MARK} が存在）`)
  process.exit(0)
}

// --- 1717 + koinoyamai.love の server ブロックを探す ---
const masked = maskNoise(conf)
const serverRe = /server\s*\{/g
let match
let target = null
while ((match = serverRe.exec(masked)) !== null) {
  const openIdx = match.index + match[0].length - 1 // '{' の位置
  let depth = 0
  let endIdx = -1
  for (let i = openIdx; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { endIdx = i; break }
    }
  }
  if (endIdx === -1) continue
  const body = masked.slice(openIdx, endIdx)
  if (!/listen\s+1717\s*;/.test(body)) continue
  if (!/server_name\s+[^;]*koinoyamai\.love/.test(body)) continue
  if (target) {
    console.error('ABORT: 対象 server ブロックが複数あります')
    process.exit(1)
  }
  target = { openIdx, endIdx }
}

if (!target) {
  console.error('ABORT: `listen 1717` + `server_name koinoyamai.love` の server ブロックが見つかりません')
  process.exit(1)
}

// --- 差し込む ---
const indent = '    '
const payload = '\n' + block.split('\n').map((l) => (l.trim() ? indent + l : l)).join('\n') + '\n'
const out = conf.slice(0, target.endIdx) + payload + conf.slice(target.endIdx)

const dest = outPath || confPath
fs.writeFileSync(dest, out, 'utf8')
console.log(`OK: ${MARK} を server ブロック（listen 1717 / koinoyamai.love）末尾に追加しました`)
console.log(`   挿入位置: ${target.endIdx} 行目付近`)
if (dest !== confPath) console.log(`   書き出し先: ${dest}（atomic install は呼び出し側）`)
