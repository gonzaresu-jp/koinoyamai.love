'use strict';
// @ts-check
// このファイルは TypeScript を入れずに型検査している（`// @ts-check` + JSDoc）。
// 2026-10-23 追加。ビルドステップを増やさずに、編集時とエージェントに型を伝えるため。
// 検証は `npx -p typescript tsc --noEmit --allowJs --checkJs`（開発時のみ・依存は追加しない）。
const crypto = require('crypto');

// /api/notify 送信時に必須の HMAC 署名を生成する。
// v2 (2026-09-24): リプレイ対策として UNIX 秒タイムスタンプを署名に含める。
//   署名対象 = `${timestamp}.${rawBody}`（rawBody は送信する JSON 文字列そのもの）
//   送信側は X-Notify-Hmac + X-Notify-Timestamp の両ヘッダを付与すること。
//   受信側 (routes/notify.js verifyNotifyHmac) は生ボディ (req.rawBody) で検証する。
// 2026-09: 受信側 HMAC 必須化（未設定時 503 / 不一致 401）のため、
// 全送信モジュール（twitter / twitcasting / fanbox / youtube / bilibili / main.js）は
// このヘルパー経由で署名を付与すること。

/**
 * @typedef {object} SignedNotifyPayload
 * @property {string} hmac      SHA256 hex（64 文字）
 * @property {string} timestamp UNIX 秒（署名対象の先頭に連結した値。ヘッダにも同じ値を載せる）
 */

/**
 * 送信する JSON 文字列そのものに HMAC 署名を付ける。
 *
 * ⚠️ **JSON を作り直してはいけない**（キー順・空白でバイト列が変わり、受信側は 401 になる）。
 * 送信する文字列をそのまま渡すこと。
 *
 * @param {string|null|undefined} secret `NOTIFY_HMAC_SECRET`。未設定なら null（fail-closed）
 * @param {string|object} body 送信する JSON **文字列**（オブジェクトなら JSON.stringify する）
 * @param {number|string} [ts] 省略時は現在時刻（UNIX 秒）
 * @returns {SignedNotifyPayload|null} secret 未設定は null
 */
function signNotifyPayload(secret, body, ts) {
  if (!secret) return null;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(ts != null ? ts : Math.floor(Date.now() / 1000));
  const hmac = crypto.createHmac('sha256', String(secret)).update(timestamp + '.' + payload).digest('hex');
  return { hmac, timestamp };
}

module.exports = { signNotifyPayload };
