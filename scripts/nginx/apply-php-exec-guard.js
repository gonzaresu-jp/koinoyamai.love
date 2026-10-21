#!/usr/bin/env node
/**
 * apply-php-exec-guard.js — nginx の「elza vhost」で PHP 実行を 404 にする
 *
 * 対象: /etc/nginx/nginx.conf の `server_name elza.poitou-mora.ts.net` の server ブロック
 *
 * なぜ必要か（2026-10-21 実測）:
 *   - この vhost の root は `/var/www/html` で、**旧 PHP が残っている**:
 *       /var/www/html/henkan/henkan.php  … move_uploaded_file() + exec()
 *       /var/www/html/henkan/con.php     … move_uploaded_file() + exec()
 *       /var/www/html/index.php 等（旧サーバーステータス）
 *     現在は php-fpm の `open_basedir`（docroot 2 つ + /tmp ほか）により
 *     「No input file specified.」で実行できないが、
 *     **basedir が緩んだ瞬間に無認証の公開 RCE になる**。
 *   - `location = /henkan/henkan.php` は `allow all;` 付きで無認証。
 *
 * やること:
 *   - elza vhost 内の `location ~ \.php$`（root /var/www/html のもの）
 *     → `return 404;` に差し替える
 *   - `location = /henkan/henkan.php` → `return 404;` に差し替える
 *   - **触らない**: listen 1717（本番 vhost）/ mai-test.conf（staging vhost）
 *     ※ 本脚本は nginx.conf のみを対象にする（staging は別ファイル）
 *
 * 方針（apply-display-location.js と共通）:
 *   - 冪等（適用済みマーカーがあれば exit 0）
 *   - fail-closed（アンカーが 0 件 or 複数なら **何も書かず** exit 1）
 *   - コメント・引用符・正規表現リテラルをマスクした文字列で brace 深さを数える
 *     （コメント中の `{` `}` で server ブロックの終端を誤認しないため）
 *
 * 使い方:
 *   node apply-php-exec-guard.js <nginx.conf> [outfile]
 */
const fs = require('fs')

const [confPath, outPath] = process.argv.slice(2)
if (!confPath) {
  console.error('usage: node apply-php-exec-guard.js <nginx.conf> [outfile]')
  process.exit(2)
}

const conf = fs.readFileSync(confPath, 'utf8')
const MARK = 'php-exec-guard'

/** コメント・引用符を空白にマスクする（長さ不変） */
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

const masked = maskNoise(conf)

/** `{` の位置から対応する `}` の位置を返す（找不到 -1） */
function matchBrace(m, openIdx) {
  let depth = 0
  for (let i = openIdx; i < m.length; i++) {
    if (m[i] === '{') depth++
    else if (m[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** server ブロック（server_name を含む）を全て列挙 */
function findServerBlocks(m) {
  const res = []
  const re = /server\s*\{/g
  let mt
  while ((mt = re.exec(m)) !== null) {
    const openIdx = mt.index + mt[0].length - 1
    const endIdx = matchBrace(m, openIdx)
    if (endIdx === -1) continue
    res.push({ openIdx, endIdx, body: m.slice(openIdx, endIdx) })
  }
  return res
}

/** server ブロック内の location ブロックを列挙 */
function findLocationBlocks(m, from, to) {
  const res = []
  const re = /location\s+([^\n{]*?)\s*\{/g
  let mt
  re.lastIndex = from
  while ((mt = re.exec(m)) !== null) {
    if (mt.index < from) continue
    if (mt.index >= to) break
    const openIdx = mt.index + mt[0].length - 1
    const endIdx = matchBrace(m, openIdx)
    if (endIdx === -1 || endIdx > to) continue
    res.push({
      spec: mt[0].replace(/\s*\{$/, '').replace(/^location\s+/, '').trim(),
      start: mt.index,
      openIdx,
      endIdx,
    })
  }
  return res
}

const servers = findServerBlocks(masked)
const elza = servers.filter((s) => /server_name\s+[^;]*elza\.poitou-mora\.ts\.net/.test(s.body))
if (elza.length !== 1) {
  console.error(`ABORT: elza vhost が ${elza.length} 件見つかりました（1 件である必要あり）`)
  process.exit(1)
}
const vhost = elza[0]

const locs = findLocationBlocks(masked, vhost.openIdx, vhost.endIdx)

/** spec にマッチする location ブロックを 1 件だけ取り出す（0/複数は null） */
function pickLocation(specMatcher) {
  const hits = locs.filter((l) => specMatcher(l.spec))
  if (hits.length !== 1) return null
  return hits[0]
}

// 対象 1: 汎用 `location ~ \.php$`（root /var/www/html のもの）
const phpLoc = pickLocation((s) => s === '~ \\.php$')
if (!phpLoc) {
  console.error('ABORT: elza vhost 内の `location ~ \\.php$` が 0 件または複数です（何も書き換えません）')
  process.exit(1)
}

// 対象 2: `location = /henkan/henkan.php`
const henkanLoc = pickLocation((s) => s === '= /henkan/henkan.php')
if (!henkanLoc) {
  console.error('ABORT: elza vhost 内の `location = /henkan/henkan.php` が 0 件または複数です（何も書き換えません）')
  process.exit(1)
}

// 既に適用済みか（マーカー判定）
// マーカーコメントは location ブロックの**直前**に付くため、ブロック単独ではなく
// 直前 600 文字を見て判定する（さもないと毎回「未適用」と誤判定して再適用する）。
function isGuarded(loc) {
  const region = conf.slice(Math.max(0, loc.start - 600), loc.endIdx + 1)
  return region.includes(MARK)
}
if (isGuarded(phpLoc) && isGuarded(henkanLoc)) {
  console.log(`SKIP: 適用済み（${MARK} マーカーが存在）`)
  process.exit(0)
}

/** 元ブロックのインデントを検出（location 行の先頭空白）と行頭オフセット */
function indentOf(text, idx) {
  const lineStart = text.lastIndexOf('\n', idx) + 1
  const m = /^[ \t]*/.exec(text.slice(lineStart, idx))
  return { indent: m ? m[0] : '', lineStart }
}

function guardBlock(origText, loc, note) {
  const { indent, lineStart } = indentOf(origText, loc.start)
  const inner = indent + '    '
  const lines = []
  lines.push(`${indent}# PHP実行ガード (2026-10-21, ${MARK}):`)
  for (const l of note.split('\n')) lines.push(`${indent}#   ${l}`)
  lines.push(`${indent}location ${loc.spec} {`)
  lines.push(`${inner}return 404;`)
  lines.push(`${indent}}`)
  // 行頭から置換する（元のインデントを二重に作らないため）
  return { text: lines.join('\n'), start: lineStart, end: loc.endIdx + 1 }
}

const phpNote = [
  'この vhost の root は /var/www/html。旧 PHP（exec / move_uploaded_file を含む',
  'henkan/con.php、index.php など）が残っており、open_basedir が緩んだ瞬間に',
  '無認証の公開 RCE になる。よってこの vhost では PHP を実行しない（404）。',
].join('\n')

const henkanNote = [
  'exec() と move_uploaded_file() を含む旧処理。allow all で無認証のため無効化。',
].join('\n')

// 後ろから置換する（**インデックスのずれを防ぐ**ため start の降順で処理する）
let out = conf
const replacements = [
  guardBlock(conf, henkanLoc, henkanNote),
  guardBlock(conf, phpLoc, phpNote),
].sort((a, b) => b.start - a.start)
for (const r of replacements) {
  out = out.slice(0, r.start) + r.text + out.slice(r.end)
}

const dest = outPath || confPath
fs.writeFileSync(dest, out, 'utf8')
console.log(`OK: elza vhost の PHP 実行を 404 にしました（${MARK}）`)
console.log(`   対象: location ${phpLoc.spec} / location ${henkanLoc.spec}`)
if (dest !== confPath) console.log(`   書き出し先: ${dest}（atomic install は呼び出し側）`)
