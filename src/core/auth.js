const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');

// ---- 設定 ----
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').replace(/"/g, '');
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').replace(/"/g, '');
const GOOGLE_REDIRECT_URI = (process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8080/auth/google/callback').replace(/"/g, '');

const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || '').replace(/"/g, '').trim();
const DISCORD_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET || '').replace(/"/g, '').trim();
const DISCORD_REDIRECT_URI = (process.env.DISCORD_REDIRECT_URI || '').replace(/"/g, '').trim();

// ---- ドメイン移行: リクエストHostからredirect_uriを動的解決 ----
// PUBLIC_HOSTS: 常に https を使う公開ドメイン（デュアルドメイン期間は両方許可）
// DEV_HOSTS: http を使うローカル開発ホスト
const PUBLIC_HOSTS = new Set([
  'mai.honna-yuzuki.com',
  'koinoyamai.love',
]);
const DEV_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * リクエストのHostからOAuth redirect_uriを構築する。
 * 許可リスト外のホストは null を返す（呼び出し側は .env の既定値へフォールバック）。
 */
function resolveRedirectUri(req, callbackPath) {
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim().toLowerCase();
  if (!rawHost) return null;
  const hostname = rawHost.replace(/:\d+$/, '');
  if (PUBLIC_HOSTS.has(hostname)) return `https://${hostname}${callbackPath}`;
  if (DEV_HOSTS.has(hostname)) return `http://${rawHost}${callbackPath}`;
  return null;
}

console.log(`[auth] Discord Config: ID=${DISCORD_CLIENT_ID.slice(0, 4)}...${DISCORD_CLIENT_ID.slice(-4)} (len=${DISCORD_CLIENT_ID.length}), URI=${DISCORD_REDIRECT_URI}`);

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET not set — using random key (sessions will not survive restart)');
  return generated;
})();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'session';
const LEGACY_COOKIE_NAME = 'auth_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
  maxAge: 365 * 24 * 60 * 60 * 1000, // 365日
};

// ---- Google OAuth クライアント ----
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);

// ---- JWT ユーティリティ ----
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ---- ミドルウェア ----

/**
 * 認証必須ミドルウェア
 * Cookieまたは Authorization: Bearer ヘッダーのJWTを検証する
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME]
    || req.cookies?.[LEGACY_COOKIE_NAME]
    || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized', code: 'NO_TOKEN' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });

  req.userId = payload.userId;
  req.userEmail = payload.email;
  next();
}

/**
 * 認証任意ミドルウェア
 * トークンがあれば req.userId / req.userEmail を付与する（なくてもOK）
 */
function optionalAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME]
    || req.cookies?.[LEGACY_COOKIE_NAME]
    || req.headers['authorization']?.replace('Bearer ', '');
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.userId = payload.userId;
      req.userEmail = payload.email;
    }
  }
  next();
}

// ---- Google OAuth ----

/**
 * Googleの認証URLを生成する
 * @param state OAuth state
 * @param redirectUri リクエストHostから解決したredirect_uri（省略時は.env既定）
 */
function getAuthUrl(state, redirectUri) {
  return oauthClient.generateAuthUrl({
    access_type: 'offline',
    scope: ['profile', 'email'],
    prompt: 'select_account',
    state: state || undefined,
    redirect_uri: redirectUri || GOOGLE_REDIRECT_URI,
  });
}

/**
 * Googleのコードをユーザー情報に交換する
 * @param redirectUri 認証URL生成時に使用したredirect_uri（省略時は.env既定）
 */
async function exchangeCodeForUser(code, redirectUri) {
  const { tokens } = await oauthClient.getToken({
    code,
    redirect_uri: redirectUri || GOOGLE_REDIRECT_URI,
  });
  oauthClient.setCredentials(tokens);

  const ticket = await oauthClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  return {
    googleId: payload.sub,
    email: payload.email,
    displayName: payload.name,
    avatarUrl: payload.picture,
  };
}

// ---- Discord OAuth ----

/**
 * Discordの認証URLを生成する
 * @param state OAuth state
 * @param redirectUri リクエストHostから解決したredirect_uri（省略時は.env既定）
 */
function getDiscordAuthUrl(state, redirectUri) {
  const effectiveRedirectUri = redirectUri || DISCORD_REDIRECT_URI;
  const baseUrl = 'https://discord.com/api/oauth2/authorize';
  const query = [
    `client_id=${DISCORD_CLIENT_ID}`,
    `redirect_uri=${encodeURIComponent(effectiveRedirectUri)}`,
    `response_type=code`,
    `scope=${encodeURIComponent('identify email')}`
  ];
  if (state) query.push(`state=${encodeURIComponent(state)}`);

  const finalUrl = `${baseUrl}?${query.join('&')}`;
  console.log('--------------------------------------------------');
  console.log('[DEBUG] DISCORD AUTH URL GENERATED:');
  console.log(finalUrl);
  console.log('--------------------------------------------------');
  return finalUrl;
}

/**
 * Discordのコードをユーザー情報に交換する
 * @param redirectUri 認証URL生成時に使用したredirect_uri（省略時は.env既定）
 */
async function exchangeDiscordCodeForUser(code, redirectUri) {
  // 1. コードをトークンに交換
  const params = new URLSearchParams();
  params.append('client_id', DISCORD_CLIENT_ID);
  params.append('client_secret', DISCORD_CLIENT_SECRET);
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', redirectUri || DISCORD_REDIRECT_URI);

  const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const accessToken = tokenResponse.data.access_token;

  // 2. ユーザー情報を取得
  const userResponse = await axios.get('https://discord.com/api/users/@me', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  const d = userResponse.data;
  const avatarUrl = d.avatar
    ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/${parseInt(d.discriminator || '0') % 5}.png`;

  return {
    discordId: d.id,
    email: d.email,
    displayName: d.global_name || d.username,
    avatarUrl: avatarUrl
  };
}

module.exports = {
  requireAuth,
  optionalAuth,
  getAuthUrl,
  exchangeCodeForUser,
  getDiscordAuthUrl,
  exchangeDiscordCodeForUser,
  resolveRedirectUri,
  signToken,
  verifyToken,
  COOKIE_NAME,
  COOKIE_OPTIONS,
};
