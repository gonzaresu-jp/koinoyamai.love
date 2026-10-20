// backup: admin/admin.js @ 2026-09-19
// 変更点:
//  - セッションをメモリMap → data.db (admin_sessions) に永続化。pm2再起動でログアウトしなくなる
//  - 有効期限 1h → 30日スライド式 (DB書込は5分間隔にスロットル)
//  - Cookie の secure を https/平文で動的判定 (LAN http でもセッションが維持される)
require('dotenv').config({ path: require('path').resolve(__dirname, './.env') });

const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3');

// SESSION_SECRETを先に定義
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('[Security] WARNING: SESSION_SECRET is not set. Using a random value (sessions will reset on restart).');
  return crypto.randomBytes(32).toString('hex');
})();

// 環境変数から認証情報を取得
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
// ADMIN_PASSWORD_HASH は bcrypt ハッシュを環境変数に設定すること
// 生成例: node -e "const b=require('bcrypt'); b.hash('yourpassword',12).then(console.log)"
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || null;

// 🔒 ALLOWED_IPS は信頼できるプロキシのIPのみ許可する想定
const ALLOWED_IPS = process.env.ALLOWED_IPS ? process.env.ALLOWED_IPS.split(',').map(s => s.trim()) : [];

// 🔒 tailnet 自動認証: tailscale serve 経由（nginx の remote_addr=127.0.0.1）のときだけ
// nginx が X-Tailnet-Admin に TAILNET_ADMIN_SECRET を付与する。値が一致する場合のみ
// tailnet 端末からのアクセスとみなし、パスワード/パスキー入力を省略する。
// 秘密値は .env と nginx.conf の map（$tailnet_admin）に同じものを持つこと。
function isTailnetAdmin(req) {
  const secret = process.env.TAILNET_ADMIN_SECRET;
  return !!secret && req.get('x-tailnet-admin') === secret;
}

// セッション管理（SQLite 永続化 + メモリキャッシュ）
// 2026-09-19 以前はメモリ Map のみで、pm2 再起動のたびに全管理者がログアウトしていた。
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30日（使用のたびに延長）
const TOUCH_INTERVAL = 5 * 60 * 1000;              // DB の expires_at 更新は5分に1回まで

const DB_PATH = process.env.ADMIN_DB_PATH || path.resolve(__dirname, '..', 'data.db');
const db = new sqlite3.Database(DB_PATH);
db.run('PRAGMA busy_timeout = 5000', (err) => { if (err) console.error('busy_timeout err:', err.message); });
db.run(`CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_touch INTEGER NOT NULL DEFAULT 0,
  ip TEXT, ua TEXT
)`);

// 読み取り回数を減らすための薄めのキャッシュ（正は常にDB）
const cache = new Map(); // token -> { session, cachedAt }
const CACHE_TTL = 30 * 1000;

// 🔒 ブルートフォース対策 - ログイン試行カウンター（これはメモリで正しい: 永続化すると攻撃者に鍵を渡す）
const loginAttempts = new Map(); // key: IP, value: { count, blockedUntil }
const MAX_LOGIN_ATTEMPTS = 10;
const BLOCK_DURATION = 15 * 60 * 1000; // 15分ブロック

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// セッショントークン生成
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 🔒 IPアドレス取得 - 信頼できるプロキシ経由のみX-Forwarded-Forを読む
function getClientIP(req) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] ||
         req.socket?.remoteAddress ||
         req.connection?.remoteAddress ||
         'unknown';
}

// IP制限チェック
function isIPAllowed(req) {
  if (ALLOWED_IPS.length === 0) return true;
  const clientIP = getClientIP(req);
  return ALLOWED_IPS.some(ip => clientIP === ip || clientIP.includes(ip));
}

// 🔒 ログイン試行チェック
function isLoginBlocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) return true;
  if (entry.blockedUntil && Date.now() >= entry.blockedUntil) {
    loginAttempts.delete(ip);
  }
  return false;
}

function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, blockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.blockedUntil = Date.now() + BLOCK_DURATION;
    console.warn(`[Security] IP blocked due to too many failed attempts: ${ip}`);
  }
  loginAttempts.set(ip, entry);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    // trust proxy 設定済み。https で来た時だけ Secure を付ける
    // （以前は production 固定 Secure で LAN http アクセスでは Cookie が保存されなかった）
    secure: req.secure === true || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'strict',
    maxAge: SESSION_DURATION,
  };
}

// --- session CRUD (Promise 化) ---

function createSession(username, req) {
  return new Promise((resolve, reject) => {
    const token = generateSessionToken();
    const now = Date.now();
    db.run(
      'INSERT INTO admin_sessions (token_hash, username, created_at, expires_at, last_touch, ip, ua) VALUES (?,?,?,?,?,?,?)',
      [hashToken(token), username, now, now + SESSION_DURATION, now, getClientIP(req),
        String(req.headers['user-agent'] || '').slice(0, 200)],
      (err) => err ? reject(err) : resolve(token)
    );
  });
}

function getSession(token) {
  const now = Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.cachedAt < CACHE_TTL) {
    return Promise.resolve(hit.session);
  }
  return new Promise((resolve) => {
    db.get(
      'SELECT username, created_at, expires_at, last_touch FROM admin_sessions WHERE token_hash=?',
      [hashToken(token)],
      (err, row) => {
        if (err || !row) {
          cache.delete(token);
          return resolve(null);
        }
        const session = {
          username: row.username,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastTouch: row.last_touch,
        };
        cache.set(token, { session, cachedAt: now });
        resolve(session);
      }
    );
  });
}

function touchSession(token, session) {
  const now = Date.now();
  session.expiresAt = now + SESSION_DURATION;
  const hit = cache.get(token);
  if (hit) hit.cachedAt = now;
  if (now - (session.lastTouch || 0) >= TOUCH_INTERVAL) {
    session.lastTouch = now;
    db.run('UPDATE admin_sessions SET expires_at=?, last_touch=? WHERE token_hash=?',
      [session.expiresAt, now, hashToken(token)]);
  }
}

function destroySession(token) {
  cache.delete(token);
  return new Promise((resolve) => {
    db.run('DELETE FROM admin_sessions WHERE token_hash=?', [hashToken(token)],
      () => resolve());
  });
}

// セッション検証ミドルウェア
async function requireAuth(req, res, next) {
  if (!isIPAllowed(req)) {
    console.warn(`[Security] Blocked access from IP: ${getClientIP(req)}`);
    return res.status(403).json({ error: 'Access denied: IP not allowed' });
  }

  // tailnet (tailscale serve) 経由は秘密値ヘッダで自動認証（個人運用・パスキー不要）
  if (isTailnetAdmin(req)) {
    req.adminUser = ADMIN_USERNAME;
    req.adminToken = 'tailnet-auto';
    return next();
  }

  const token = req.headers['x-admin-token'] || req.cookies?.adminToken;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const session = await getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  if (Date.now() > session.expiresAt) {
    await destroySession(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  touchSession(token, session);
  req.adminUser = session.username;
  req.adminToken = token;
  next();
}

// -------------------------------------------------
// 管理者リクエストか判定するヘルパー（非同期版: DB セッション参照のため）
// -------------------------------------------------
async function isAdminRequest(req) {
  if (req.adminUser) {
    return true;
  }
  if (isTailnetAdmin(req)) {
    req.adminUser = ADMIN_USERNAME;
    return true;
  }
  const token = req.headers['x-admin-token'] || req.cookies?.adminToken;
  if (!token) {
    return false;
  }
  const session = await getSession(token);
  if (session && Date.now() <= session.expiresAt) {
    req.adminUser = session.username;
    return true;
  }
  return false;
}

// ログイン処理
async function login(req, res) {
  const { username, password } = req.body;
  const clientIP = getClientIP(req);

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (!isIPAllowed(req)) {
    console.warn(`[Security] Blocked login attempt from IP: ${clientIP}`);
    return res.status(403).json({ error: 'Access denied: IP not allowed' });
  }

  // 🔒 ブルートフォース - IPブロックチェック
  if (isLoginBlocked(clientIP)) {
    console.warn(`[Security] Blocked login attempt (rate limit) from IP: ${clientIP}`);
    return res.status(429).json({ error: 'Too many failed attempts. Please try again later.' });
  }

  // 🔒 ADMIN_PASSWORD_HASH 未設定はログイン不可
  if (!ADMIN_PASSWORD_HASH) {
    console.error('[Security] ADMIN_PASSWORD_HASH is not set in environment variables.');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // 🔒 bcrypt で比較（タイミング攻撃・ブルートフォースに強い）
    const usernameMatch = username === ADMIN_USERNAME;
    const passwordMatch = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

    if (!usernameMatch || !passwordMatch) {
      recordFailedLogin(clientIP);
      console.warn(`[Security] Failed login attempt: ${username} from ${clientIP}`);
      await new Promise(r => setTimeout(r, 1000));
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('[Security] bcrypt error:', err);
    return res.status(500).json({ error: 'Server error' });
  }

  clearLoginAttempts(clientIP);

  try {
    const token = await createSession(username, req);
    console.log(`[Security] Admin logged in: ${username} from ${clientIP}`);
    // 🔒 HttpOnly Cookie でトークンを返す（XSS対策）
    res.cookie('adminToken', token, cookieOptions(req));
    res.json({ success: true, expiresIn: SESSION_DURATION });
  } catch (err) {
    console.error('[Security] session create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ログアウト処理
async function logout(req, res) {
  const token = req.headers['x-admin-token'] || req.cookies?.adminToken;
  if (token) {
    await destroySession(token);
  }
  res.clearCookie('adminToken');
  res.json({ success: true, message: 'Logged out' });
}

// セッションクリーンアップ
setInterval(() => {
  const now = Date.now();
  const cutoff = now - SESSION_DURATION - 24 * 60 * 60 * 1000;
  db.run('DELETE FROM admin_sessions WHERE expires_at < ?', [now]);
  db.run('DELETE FROM admin_sessions WHERE created_at < ?', [cutoff]); // 万一の残骸掃除
  for (const [token, entry] of cache.entries()) {
    if (!entry.session || now > entry.session.expiresAt) cache.delete(token);
  }
  for (const [ip, entry] of loginAttempts.entries()) {
    if (entry.blockedUntil && now > entry.blockedUntil) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

// 初回パスワード設定ヘルパー
// 使い方: node -e "require('./admin').generatePasswordHash('yourpassword').then(console.log)"
async function generatePasswordHash(password) {
  return bcrypt.hash(password, 12);
}

module.exports = {
  requireAuth,
  login,
  logout,
  generatePasswordHash,
  isAdminRequest,
  // webauthn 側から使う内部API
  createSession,
  getSession,
  destroySession,
  touchSession,
  cookieOptions,
  sessionDuration: () => SESSION_DURATION,
  adminUsername: () => ADMIN_USERNAME,
  db,
};
