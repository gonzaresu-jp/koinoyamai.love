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
 *     （access.log の全rotation = 30 万行で peer は 127.0.0.1 / LAN / Tailscale のみ）。
 *   - つまり「外から直接叩けない」ことは*tunnel 経由の副作用*に依存しているだけで、
 *     nginx 側では **どこから来たリクエストでも受け付けている**。
 *   - 残igramの穴は UA 判定 1 枚だけ。UA はクライアントが自由に設定できるので
 *     `curl -A Discordbot` で取得できる（実測済み: 200 / 943KB）。
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
 *   - 冪等（適用済みマーカーがあれば exit 0）
 *   - fail-closed（アンカーが 0 件 or 複数なら **何も書かず** exit 1）
 *
 * 使い方:
 *   node apply-dmedia-tunnel-only.js <discord.conf> [outfile]
 */
const fs = require('fs')

const [confPath, outPath] = process.argv.slice(2)
if (!confPath) {
  console.error('usage: node apply-dmedia-tunnel-only.js <discord.conf> [outfile]')
  process.exit(2)
}

const conf = fs.readFileSync(confPath, 'utf8')
const MARK = 'dmedia-tunnel-only'

// 既に適用済みか
if (conf.includes(MARK)) {
  console.log(`SKIP: 適用済み（${MARK} マーカーが存在）`)
  // ★ 出力ファイルへ**元の conf をコピーして**から exit する。
  //   0 byte のファイルで conf を上書きすると nginx.conf が空になる（Critical）。
  if (outPath) fs.writeFileSync(outPath, conf)
  process.exit(0)
}

// アンカー: `location ^~ /dmedia/ {` がちょうど 1 件か
const anchorRe = /location\s+\^~\s*\/dmedia\/\s*\{/g
const anchors = []
let mt
while ((mt = anchorRe.exec(conf)) !== null) anchors.push(mt)
if (anchors.length !== 1) {
  console.error(`ABORT: \`location ^~ /dmedia/ {}\` が ${anchors.length} 件見つかりました（1 件である必要あり）`)
  process.exit(1)
}

const anchor = anchors[0]
// 挿入位置: アンカーの行末（その直後の行から）
const lineEnd = conf.indexOf('\n', anchor.index + anchor[0].length)
if (lineEnd === -1) {
  console.error('ABORT: アンカー行の終端が見つかりません')
  process.exit(1)
}

// 次の行のインデントを偵察する（location の内側）
const nextLineStart = lineEnd + 1
const nextLineEnd = conf.indexOf('\n', nextLineStart)
const nextLine = conf.slice(nextLineStart, nextLineEnd === -1 ? conf.length : nextLineEnd)
const indentMatch = /^[ \t]*/.exec(nextLine)
const inner = indentMatch ? indentMatch[0] : '        '

const insert = [
  '',
  `${inner}# ★ ${MARK}（2026-10-22）: tunnel 経由のみで許可する。`,
  `${inner}#   cloudflared は 127.0.0.1（/::1）から接続するので、この許可リストで`,
  `${inner}#   「origin へ直接叩かれた場合」を全て 403 にできる。`,
  `${inner}#   UA 判定（User-Agent=Discordbot のみ許可）は UA を偽装できるため`,
  `${inner}#   保護としては不十分。URL 側は 128bit ランダム ID で推測不能にしてある。`,
  `${inner}allow 127.0.0.1;`,
  `${inner}allow ::1;`,
  `${inner}deny  all;`,
].join('\n')

const out = conf.slice(0, lineEnd) + insert + conf.slice(lineEnd)
const dest = outPath || confPath
fs.writeFileSync(dest, out, 'utf8')
console.log(`OK: /dmedia/ に tunnel 限定（allow 127.0.0.1 / ::1, deny all）を追加しました（${MARK}）`)
if (dest !== confPath) console.log(`   書き出し先: ${dest}（atomic install は呼び出し側）`)
