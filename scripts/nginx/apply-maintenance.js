#!/usr/bin/env node
/**
 * apply-maintenance.js — nginx にメンテナンスモードの include を差し込む／外す
 *
 * 対象:
 *   - /etc/nginx/nginx.conf の `listen 1717` + `server_name koinoyamai.love` の server ブロック
 *   - /etc/nginx/mai-test.conf の `server_name test.koinoyamai.love` の server ブロック
 *
 * 差し込み位置: server ブロックの **開き括弧の直後**（＝既存の `location ~ \.php$` より前）
 *   → nginx の regex location は定義順で最初にマッチしたものが使われるため、
 *     新しい `location ~ \.php$` が先にマッチして PHP へ到達しなくなる。
 *
 * 方針:
 *   - 冪等: 既に include 済みなら exit 0（--off なら remove して exit 0）
 *   - fail-closed: 対象が見つからない場合は **何も書き換えず** exit 1
 *   - コメント・引用符を含む長さ不変マスクで brace 深さを数える
 *     （コメント内の {} を数えると server ブロック終端を誤認する実測例あり）
 *
 * 使い方:
 *   node apply-maintenance.js <mode:on|off> <file> [<file> ...]
 */
const fs = require('fs')

const [mode, ...files] = process.argv.slice(2)
if (!mode || !['on', 'off'].includes(mode) || files.length === 0) {
  console.error('usage: node apply-maintenance.js <on|off> <file> [...]')
  process.exit(2)
}

const INCLUDE_LINE = 'include /etc/nginx/snippets/maintenance.conf;'

/** コメント・引用符を空白にマスク（長さ不変） */
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
    if (ch === '#') { while (i < n && text[i] !== '\n') { out[i] = ' '; i++ } continue }
    i++
  }
  return out.join('')
}

/**
 * 対象 server ブロックの開き括弧位置を返す
 * @param {string} conf 設定ファイル全文
 * @param {object} cond 判定条件 {listen?: string, serverName?: string}
 */
function findServerBlock(conf, cond) {
  const masked = maskNoise(conf)
  const re = /server\s*\{/g
  let m
  while ((m = re.exec(masked)) !== null) {
    const openIdx = m.index + m[0].length - 1
    let depth = 0
    let endIdx = -1
    for (let i = openIdx; i < masked.length; i++) {
      const ch = masked[i]
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break } }
    }
    if (endIdx === -1) continue
    const body = masked.slice(openIdx, endIdx)
    if (cond.listen && !new RegExp(`listen\\s+${cond.listen.replace(/[^\d]/g, '')}\\s*;`).test(body)) continue
    if (cond.serverName && !new RegExp(`server_name\\s+[^;]*${cond.serverName.replace(/\./g, '\\.')}`).test(body)) continue
    return { openIdx, endIdx }
  }
  return null
}

let rc = 0
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`ABORT: ${file} がありません`)
    rc = 1
    continue
  }
  const conf = fs.readFileSync(file, 'utf8')
  // 対象は server_name で判定する（ファイル名依存にしない）
  const cond = /server_name[^;]*test\.koinoyamai\.love/.test(conf)
    ? { serverName: 'test.koinoyamai.love' }
    : { listen: '1717', serverName: 'koinoyamai.love' }

  const target = findServerBlock(conf, cond)
  if (!target) {
    console.error(`ABORT: ${file} に対象 server ブロックが見つかりません（${JSON.stringify(cond)}）`)
    rc = 1
    continue
  }

  const lines = conf.split('\n')
  const includeIdx = lines.findIndex((l) => l.trim() === INCLUDE_LINE)

  if (mode === 'on') {
    if (includeIdx !== -1) {
      console.log(`SKIP: ${file} は適用済み（include 済み）`)
      continue
    }
    // 開き括弧の直後の行に include を挿入
    const openLine = conf.slice(0, target.openIdx).split('\n').length // 1-indexed の行番号
    lines.splice(openLine, 0, `    ${INCLUDE_LINE}`)
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    console.log(`OK: ${file} の ${openLine + 1} 行目に include を追加しました`)
  } else {
    if (includeIdx === -1) {
      console.log(`SKIP: ${file} は include なし（解除不要）`)
      continue
    }
    lines.splice(includeIdx, 1)
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    console.log(`OK: ${file} から include を削除しました`)
  }
}

process.exit(rc)
