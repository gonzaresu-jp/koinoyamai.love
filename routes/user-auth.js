'use strict';

const crypto = require('crypto');
const auth = require('../src/core/auth');
const { upsertUser, upsertDiscordUser, migrateSubscription, unlinkUserDevices, safeRedirect } = require('./user-helpers');

const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const DESKTOP_CODE_TTL_MS = 60 * 1000;
const oauthStates = new Map();
const desktopCodes = new Map();

function randomValue() { return crypto.randomBytes(32).toString('base64url'); }
function createOAuthState(data) {
  const state = randomValue();
  oauthStates.set(state, { ...data, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
  return state;
}
function consume(map, key) {
  key = String(key || '');
  const entry = map.get(key);
  map.delete(key);
  return entry && entry.expiresAt > Date.now() ? entry : null;
}
function createDesktopCode(token) {
  const code = randomValue();
  desktopCodes.set(code, { token, expiresAt: Date.now() + DESKTOP_CODE_TTL_MS });
  return code;
}
function isAllowedDesktopCallback(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      && /^\/callback\/?$/.test(url.pathname) && !url.username && !url.password && /^\d{1,5}$/.test(url.port);
  } catch { return false; }
}
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of oauthStates) if (value.expiresAt <= now) oauthStates.delete(key);
  for (const [key, value] of desktopCodes) if (value.expiresAt <= now) desktopCodes.delete(key);
}, 60 * 1000);
cleanupTimer.unref?.();

function register(app, db, authLimiter) {
  const limiter = authLimiter || ((req, res, next) => next());

  app.get('/auth/google', limiter, (req, res) => {
    const returnTo = req.query.returnTo || '/';
    const clientId = req.query.client_id || '';
    const redirectUri = auth.resolveRedirectUri(req, '/auth/google/callback');
    const state = createOAuthState({ returnTo, clientId, redirectUri });
    res.redirect(auth.getAuthUrl(state, redirectUri));
  });

  app.get('/auth/google/callback', limiter, async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');
    const stateData = consume(oauthStates, state);
    if (!stateData) return res.status(400).send('Invalid or expired OAuth state');
    try {
      const googleUser = await auth.exchangeCodeForUser(code, stateData.redirectUri);
      const user = await upsertUser(db, googleUser);
      if (stateData.clientId) await migrateSubscription(db, stateData.clientId, user.id);
      const token = auth.signToken({ userId: user.id, email: user.email || user.google_id || user.discord_id });
      console.log(`[auth] Google login: user_id=${user.id} email=${user.email}`);
      if (isAllowedDesktopCallback(stateData.returnTo)) {
        const url = new URL(stateData.returnTo);
        url.searchParams.set('code', createDesktopCode(token));
        res.redirect(url.toString());
      } else {
        res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
        safeRedirect(res, stateData.returnTo);
      }
    } catch (e) {
      console.error('[auth/google/callback]', e.message || e);
      res.status(500).send('Authentication failed.');
    }
  });

  app.get('/auth/discord', limiter, (req, res) => {
    const returnTo = req.query.returnTo || '/';
    const clientId = req.query.client_id || '';
    const redirectUri = auth.resolveRedirectUri(req, '/auth/discord/callback');
    const state = createOAuthState({ returnTo, clientId, redirectUri });
    const authUrl = auth.getDiscordAuthUrl(state, redirectUri);
    console.log('[auth/discord] Full Redirect URL:', authUrl);
    res.redirect(authUrl);
  });

  app.get('/auth/discord/callback', limiter, async (req, res) => {
    const { code, state, error, error_description } = req.query;
    if (error) { console.warn('[auth/discord/callback] Discord returned error:', error, error_description); return res.status(400).send(`Authentication failed: ${error_description || error}`); }
    if (!code) { console.warn('[auth/discord/callback] Missing code. Query:', req.query); return res.status(400).send('Missing authorization code'); }
    const stateData = consume(oauthStates, state);
    if (!stateData) return res.status(400).send('Invalid or expired OAuth state');
    try {
      const discordUser = await auth.exchangeDiscordCodeForUser(code, stateData.redirectUri);
      const user = await upsertDiscordUser(db, discordUser);
      if (stateData.clientId) await migrateSubscription(db, stateData.clientId, user.id);
      const token = auth.signToken({ userId: user.id, email: user.email || user.discord_id || user.google_id });
      console.log(`[auth] Discord login: user_id=${user.id} email=${user.email}`);
      if (isAllowedDesktopCallback(stateData.returnTo)) {
        const url = new URL(stateData.returnTo);
        url.searchParams.set('code', createDesktopCode(token));
        res.redirect(url.toString());
      } else {
        res.cookie(auth.COOKIE_NAME, token, auth.COOKIE_OPTIONS);
        safeRedirect(res, stateData.returnTo);
      }
    } catch (e) {
      console.error('[auth/discord/callback] Exchange error:', e.message || (e.response ? JSON.stringify(e.response.data) : e));
      res.status(500).send('Authentication failed during token exchange.');
    }
  });

  app.post('/auth/logout', auth.optionalAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const clientId = body.clientId || body.client_id || req.query?.clientId || req.query?.client_id || '';
      const fcmToken = body.fcmToken || req.query?.fcmToken || '';
      if (req.userId && (clientId || fcmToken)) await unlinkUserDevices(db, req.userId, { clientId, fcmToken });
    } catch (e) { console.warn('[auth/logout] unlink failed:', e && e.message ? e.message : e); }
    res.clearCookie(auth.COOKIE_NAME);
    res.json({ success: true });
  });

  app.post('/auth/token-exchange', limiter, (req, res) => {
    const entry = consume(desktopCodes, req.body?.code);
    if (!entry) return res.status(400).json({ error: 'Invalid or expired authorization code' });
    res.set('Cache-Control', 'no-store');
    res.json({ token: entry.token });
  });

  app.get('/auth/logout', limiter, auth.optionalAuth, async (req, res) => {
    try {
      const clientId = req.query?.clientId || req.query?.client_id || '';
      const fcmToken = req.query?.fcmToken || '';
      if (req.userId && (clientId || fcmToken)) await unlinkUserDevices(db, req.userId, { clientId, fcmToken });
    } catch (e) { console.warn('[auth/logout] unlink failed:', e && e.message ? e.message : e); }
    res.clearCookie(auth.COOKIE_NAME);
    safeRedirect(res, req.query.returnTo);
  });
}

module.exports = { register };
