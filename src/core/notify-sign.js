'use strict';
const crypto = require('crypto');

// /api/notify 送信時に必須の HMAC 署名を生成する。
// v2 (2026-09-24): リプレイ対策として UNIX 秒タイムスタンプを署名に含める。
//   署名対象 = `${timestamp}.${rawBody}`（rawBody は送信する JSON 文字列そのもの）
//   送信側は X-Notify-Hmac + X-Notify-Timestamp の両ヘッダを付与すること。
//   受信側 (routes/notify.js verifyNotifyHmac) は生ボディ (req.rawBody) で検証する。
// 2026-09: 受信側 HMAC 必須化（未設定時 503 / 不一致 401）のため、
// 全送信モジュール（twitter / twitcasting / fanbox / youtube / bilibili / main.js）は
// このヘルパー経由で署名を付与すること。
function signNotifyPayload(secret, body, ts) {
  if (!secret) return null;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(ts != null ? ts : Math.floor(Date.now() / 1000));
  const hmac = crypto.createHmac('sha256', String(secret)).update(timestamp + '.' + payload).digest('hex');
  return { hmac, timestamp };
}

module.exports = { signNotifyPayload };
