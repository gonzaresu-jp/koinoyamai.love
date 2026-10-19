// admin/webauthn.js - パスキー(WebAuthn)による管理者ログイン
//
// 2026-09-19 追加。パスワード入力なしで Windows Hello / TouchID 等を
// 認証子として管理画面にログインできるようにする。
// 登録は「ログイン状態」からのみ（乗っ取り防止）。
//
// 設定 (.env / admin/.env):
//   WEBAUTHN_RP_ID   例: koinoyamai.love   (既定)
//   WEBAUTHN_ORIGIN  例: https://koinoyamai.love  カンマ区切りで複数可 (既定)
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://koinoyamai.love';
const RP_ID = process.env.WEBAUTHN_RP_ID || new URL(PUBLIC_URL).hostname;
const ORIGINS = (process.env.WEBAUTHN_ORIGIN || PUBLIC_URL)
  .split(',').map((s) => s.trim()).filter(Boolean);
// HOST ベースで rpID/origin を差し替えられるように（staging は WEBAUTHN_RP_ID_TEST を優先）
const RP_ID_TEST = process.env.WEBAUTHN_RP_ID_TEST || null;
const ORIGINS_TEST = (process.env.WEBAUTHN_ORIGIN_TEST || null)
  ? process.env.WEBAUTHN_ORIGIN_TEST.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
// ドメイン移行用: 新ドメイン (WEBAUTHN_RP_ID_NEW) のHostのときそちらを RP_ID/Origin に解決する。
// パスキーは RP_ID 単位のため、新ドメイン側では新規登録が必要（仕様）。
const RP_ID_NEW = process.env.WEBAUTHN_RP_ID_NEW || null;
const ORIGINS_NEW = (process.env.WEBAUTHN_ORIGIN_NEW || null)
  ? process.env.WEBAUTHN_ORIGIN_NEW.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
// Tailnet 専用経路用 (tailscale serve): WEBAUTHN_RP_ID_EXTRA のHostのときそちらを RP/Origin にする。
// 例: https://elza.poitou-mora.ts.net （RP単位が異なるため新規登録が必要）
const RP_ID_EXTRA = process.env.WEBAUTHN_RP_ID_EXTRA || null;
const ORIGINS_EXTRA = (process.env.WEBAUTHN_ORIGIN_EXTRA || null)
  ? process.env.WEBAUTHN_ORIGIN_EXTRA.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

// リクエストHostから staging/本番/新ドメイン を判定して rpID/origin を解決する。
// staging (mai-test.*) 用に WEBAUTHN_RP_ID_TEST / WEBAUTHN_ORIGIN_TEST が設定されていればそちらを使う。
function resolveRp(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  if (RP_ID_TEST && host === RP_ID_TEST) return RP_ID_TEST;
  if (RP_ID_NEW && host === RP_ID_NEW) return RP_ID_NEW;
  if (RP_ID_EXTRA && host === RP_ID_EXTRA) return RP_ID_EXTRA;
  return RP_ID;
}
function resolveOrigins(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  if (ORIGINS_TEST && host === RP_ID_TEST) return ORIGINS_TEST;
  if (ORIGINS_NEW && host === RP_ID_NEW) return ORIGINS_NEW;
  if (ORIGINS_EXTRA && host === RP_ID_EXTRA) return ORIGINS_EXTRA;
  return ORIGINS;
}
const RP_NAME = 'mai-push 管理';

const CHALLENGE_TTL = 5 * 60 * 1000;

function register(app) {
  const auth = require('./admin');
  const db = auth.db;

  db.run(`CREATE TABLE IF NOT EXISTS admin_passkeys (
    credential_id TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    public_key    BLOB NOT NULL,
    counter       INTEGER NOT NULL DEFAULT 0,
    label         TEXT,
    created_at    INTEGER NOT NULL,
    last_used     INTEGER
  )`);

  // 進行中のチャレンジ: fid -> { challenge, username, purpose, expiresAt }
  const flows = new Map();

  function newFlow(challenge, username, purpose) {
    const fid = require('crypto').randomBytes(12).toString('hex');
    flows.set(fid, { challenge, username, purpose, expiresAt: Date.now() + CHALLENGE_TTL });
    return fid;
  }
  function takeFlow(fid) {
    const f = flows.get(fid);
    if (!f) return null;
    flows.delete(fid);
    if (Date.now() > f.expiresAt) return null;
    return f;
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of flows.entries()) if (now > v.expiresAt) flows.delete(k);
  }, 60 * 1000);

  const dbAll = (sql, params) => new Promise((res, rej) =>
    db.all(sql, params, (e, r) => (e ? rej(e) : res(r || []))));
  const dbGet = (sql, params) => new Promise((res, rej) =>
    db.get(sql, params, (e, r) => (e ? rej(e) : res(r))));
  const dbRun = (sql, params) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { return e ? rej(e) : res(this); }));

  // --- 登録 ---

  app.post('/api/admin/passkey/register/begin', auth.requireAuth, async (req, res) => {
    try {
      const username = req.adminUser;
      const existing = await dbAll('SELECT credential_id FROM admin_passkeys WHERE username=?', [username]);
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: resolveRp(req),
        userID: new TextEncoder().encode(username),
        userName: username,
        userDisplayName: `管理者 (${username})`,
        attestationType: 'none',
        excludeCredentials: existing.map((r) => ({ id: r.credential_id, type: 'public-key' })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
      });
      const fid = newFlow(options.challenge, username, 'register');
      res.json({ ...options, _fid: fid });
    } catch (e) {
      console.error('[passkey] register begin:', e.message);
      res.status(500).json({ error: '登録を開始できません' });
    }
  });

  app.post('/api/admin/passkey/register/finish', auth.requireAuth, async (req, res) => {
    const fid = req.body && req.body._fid;
    const response = req.body && req.body.response;
    if (!fid || !response) return res.status(400).json({ error: 'bad request' });
    const flow = takeFlow(fid);
    if (!flow || flow.purpose !== 'register') {
      return res.status(400).json({ error: 'タイムアウトしました。やり直してください' });
    }
    try {
      const { verified, registrationInfo } = await verifyRegistrationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin: resolveOrigins(req),
        expectedRPID: resolveRp(req),
      });
      if (!verified || !registrationInfo) return res.status(400).json({ error: '検証に失敗しました' });
      // @simplewebauthn/server v10: registrationInfo はフラット
      // { credentialID (base64url), credentialPublicKey (Uint8Array), counter, ... }
      const { credentialID, credentialPublicKey, counter } = registrationInfo;
      if (!credentialID || !credentialPublicKey) return res.status(400).json({ error: '検証に失敗しました' });
      await dbRun(
        `INSERT OR REPLACE INTO admin_passkeys
         (credential_id, username, public_key, counter, label, created_at)
         VALUES (?,?,?,?,?,?)`,
        [credentialID, flow.username, Buffer.from(credentialPublicKey),
          counter || 0, req.body.label || null, Date.now()]
      );
      console.log(`[Security] Passkey registered: ${flow.username} (${String(credentialID).slice(0, 12)}…)`);
      res.json({ success: true, credentialId: credentialID });
    } catch (e) {
      console.error('[passkey] register finish:', e.message);
      res.status(400).json({ error: '登録に失敗しました: ' + e.message });
    }
  });

  // --- ログイン ---

  app.post('/api/admin/passkey/login/begin', async (req, res) => {
    try {
      const username = auth.adminUsername();
      const keys = await dbAll('SELECT credential_id FROM admin_passkeys WHERE username=?', [username]);
      if (!keys.length) return res.status(404).json({ error: 'パスキーが登録されていません' });
      const options = await generateAuthenticationOptions({
        rpID: resolveRp(req),
        userVerification: 'preferred',
        allowCredentials: keys.map((k) => ({ id: k.credential_id, type: 'public-key' })),
      });
      const fid = newFlow(options.challenge, username, 'login');
      res.json({ ...options, _fid: fid });
    } catch (e) {
      console.error('[passkey] login begin:', e.message);
      res.status(500).json({ error: 'ログインを開始できません' });
    }
  });

  app.post('/api/admin/passkey/login/finish', async (req, res) => {
    const fid = req.body && req.body._fid;
    const response = req.body && req.body.response;
    if (!fid || !response) return res.status(400).json({ error: 'bad request' });
    const flow = takeFlow(fid);
    if (!flow || flow.purpose !== 'login') {
      return res.status(400).json({ error: 'タイムアウトしました。やり直してください' });
    }
    try {
      const stored = await dbGet(
        'SELECT * FROM admin_passkeys WHERE credential_id=? AND username=?',
        [response.id, flow.username]
      );
      if (!stored) return res.status(400).json({ error: 'このデバイスは登録されていません' });

      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin: resolveOrigins(req),
        expectedRPID: resolveRp(req),
        authenticator: {
          credentialID: stored.credential_id,
          credentialPublicKey: new Uint8Array(stored.public_key),
          counter: stored.counter,
        },
      });
      if (!verified) return res.status(401).json({ error: '認証に失敗しました' });

      await dbRun('UPDATE admin_passkeys SET counter=?, last_used=? WHERE credential_id=?',
        [authenticationInfo.newCounter || stored.counter, Date.now(), stored.credential_id]);

      const token = await auth.createSession(flow.username, req);
      res.cookie('adminToken', token, auth.cookieOptions(req));
      console.log(`[Security] Passkey login: ${flow.username} (${stored.credential_id.slice(0, 12)}…)`);
      res.json({ success: true });
    } catch (e) {
      console.error('[passkey] login finish:', e.message);
      res.status(401).json({ error: '認証に失敗しました: ' + e.message });
    }
  });

  // --- 照会 / 取消 ---

  app.get('/api/admin/passkey/exists', async (req, res) => {
    try {
      const username = auth.adminUsername();
      const n = await dbGet('SELECT COUNT(*) AS n FROM admin_passkeys WHERE username=?', [username]);
      res.json({ count: (n && n.n) || 0 });
    } catch (e) {
      res.json({ count: 0 });
    }
  });

  app.get('/api/admin/passkey/list', auth.requireAuth, async (req, res) => {
    try {
      const rows = await dbAll(
        'SELECT credential_id, label, created_at, last_used FROM admin_passkeys WHERE username=? ORDER BY created_at',
        [req.adminUser]
      );
      res.json({ passkeys: rows.map((r) => ({ ...r, credential_id: r.credential_id.slice(0, 16) + '…', _id: r.credential_id })) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/passkey/revoke', auth.requireAuth, async (req, res) => {
    const id = req.body && req.body.credential_id;
    if (!id) return res.status(400).json({ error: 'credential_id が必要です' });
    await dbRun('DELETE FROM admin_passkeys WHERE credential_id=? AND username=?', [id, req.adminUser]);
    res.json({ success: true });
  });
}

module.exports = { register };
