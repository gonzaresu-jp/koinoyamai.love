"use strict";
/**
 * scripts/security/discord-chunk.js — Discord embed の文字数上限に収めるための分割・切り詰め
 *
 * なぜ必要か（2026-10-23 実測の事故）:
 *   - Discord の embed description は **4096 文字**が上限で、超えると
 *     **メッセージ全体が HTTP 400 で落ちる**（一部だけ捨てられる、ではない）。
 *   - ハニーポット監視が 37 件の窃取を 1 メッセージに詰めたところ上限を超え、
 *     **窃取の通知が一度も届かない**うえ、失敗ループで偵察の通知が
 *     5 分おきに再送され続けた（ユーザー報告「新規ないのに毎回通知いらない」）。
 *
 * 方針:
 *   - 1 メッセージ本文は **3200 文字**を目安に分割する（ヘッダ・フッター・
 *     「続き n/m」表記の余白を残す）。
 *   - 1 行が長すぎる場合（UA が異常に長い等）は行単位で切り詰める。
 *   - `notify.sendDiscord` 側でも**安全網**として切り詰める（呼び出し側の分割漏れ対策）。
 */

const DISCORD_DESCRIPTION_LIMIT = 4096;
/** 1 メッセージ本文の実用上限（4096 まで余白を残す） */
const BODY_LIMIT = 3200;

/**
 * 行の配列を、上限以内の複数チャンクへ分割する。
 *
 * @param {Array} items 任意の要素
 * @param {(item: any) => string} fmt 要素を 1 行の文字列にする
 * @param {{limit?: number}} [opts]
 * @returns {Array<{items: Array, text: string}>}
 */
function chunkLines(items, fmt, opts) {
  const o = opts || {};
  const limit = o.limit || BODY_LIMIT;
  const chunks = [];
  let cur = { items: [], lines: [], size: 0 };

  const flush = () => {
    if (!cur.items.length) return;
    chunks.push({ items: cur.items, text: cur.lines.join("\n") });
    cur = { items: [], lines: [], size: 0 };
  };

  for (const it of items) {
    let line = String(fmt(it));
    if (line.length > limit) {
      // 1 行だけで上限を超える（UA が異常に長い等）→ 行を切る
      line = line.slice(0, Math.max(0, limit - 1)) + "…";
    }
    const sep = cur.lines.length ? 1 : 0;
    if (cur.lines.length && cur.size + sep + line.length > limit) flush();
    const add = cur.lines.length ? 1 + line.length : line.length;
    cur.items.push(it);
    cur.lines.push(line);
    cur.size += add;
  }
  flush();
  return chunks;
}

/**
 * 文字列を上限以内に切り詰める（超えたら末尾に省略表記を付ける）。
 * @param {string} text
 * @param {number} [limit]
 */
function truncate(text, limit) {
  const s = String(text == null ? "" : text);
  const max = limit || DISCORD_DESCRIPTION_LIMIT - 20;
  if (s.length <= max) return s;
  const suffixLen = 24;
  const body = s.slice(0, Math.max(0, max - suffixLen));
  const removed = s.length - body.length;
  return body + `\n…（以下省略 ${removed} 文字）`;
}

module.exports = { chunkLines, truncate, BODY_LIMIT, DISCORD_DESCRIPTION_LIMIT };
