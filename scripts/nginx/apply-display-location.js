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
 * 使い方:
 *   node apply-display-location.js <nginx.conf> <block.conf>
 */
const fs = require('fs')

const [confPath, blockPath] = process.argv.slice(2)
if (!confPath || !blockPath) {
  console.error('usage: node apply-display-location.js <nginx.conf> <block.conf>')
  process.exit(2)
}

const conf = fs.readFileSync(confPath, 'utf8')
const rawBlock = fs.readFileSync(blockPath, 'utf8')

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
const serverRe = /server\s*\{/g
let match
let target = null
while ((match = serverRe.exec(conf)) !== null) {
  const openIdx = match.index + match[0].length - 1 // '{' の位置
  // 対応する '}' を探す（brace 深さ）
  let depth = 0
  let endIdx = -1
  for (let i = openIdx; i < conf.length; i++) {
    const ch = conf[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { endIdx = i; break }
    }
  }
  if (endIdx === -1) continue
  const body = conf.slice(openIdx, endIdx)
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

fs.writeFileSync(confPath, out, 'utf8')
console.log(`OK: ${MARK} を server ブロック（listen 1717 / koinoyamai.love）末尾に追加しました`)
console.log(`   挿入位置: ${target.endIdx} 行目付近`)
