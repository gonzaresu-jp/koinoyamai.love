'use strict';

const auth = require('../src/core/auth');
const { dbGet, dbRun, dbAll, mergeSettings, DEFAULT_PLATFORM_SETTINGS, migrateSubscription } = require('./user-helpers');

function register(app, db) {
  app.get('/api/user/me', auth.requireAuth, async (req, res) => {
    try {
      const user = await dbGet(db, 'SELECT id, email, display_name, avatar_url, oshi_since, created_at FROM users WHERE id = ?', [req.userId]);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const oshiDays = user.oshi_since ? Math.floor((Date.now() - new Date(user.oshi_since).getTime()) / 86400000) : null;
      res.json({ ...user, oshi_days: oshiDays });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/user/oshi', auth.requireAuth, async (req, res) => {
    try {
      const user = await dbGet(db, 'SELECT oshi_since FROM users WHERE id = ?', [req.userId]);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const days = user.oshi_since ? Math.floor((Date.now() - new Date(user.oshi_since).getTime()) / 86400000) : null;
      res.json({ oshi_since: user.oshi_since, days });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/user/oshi', auth.requireAuth, async (req, res) => {
    const { oshi_since } = req.body;
    if (!oshi_since || isNaN(new Date(oshi_since).getTime())) return res.status(400).json({ error: 'Valid date required (YYYY-MM-DD)' });
    if (new Date(oshi_since) > new Date()) return res.status(400).json({ error: 'Date cannot be in the future' });
    try {
      await dbRun(db, 'UPDATE users SET oshi_since = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [oshi_since, req.userId]);
      res.json({ success: true, oshi_since, days: Math.floor((Date.now() - new Date(oshi_since).getTime()) / 86400000) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/user/notification-settings', auth.requireAuth, async (req, res) => {
    try {
      const row = await dbGet(db, 'SELECT settings_json FROM user_subscriptions WHERE user_id = ? LIMIT 1', [req.userId]);
      if (row) return res.json(mergeSettings(row.settings_json));
      const clientId = req.query.clientId;
      if (clientId) {
        const anonRow = await dbGet(db, 'SELECT settings_json FROM subscriptions WHERE client_id = ?', [clientId]);
        if (anonRow) return res.json(mergeSettings(anonRow.settings_json));
      }
      res.json({ ...DEFAULT_PLATFORM_SETTINGS });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/user/notification-settings', auth.requireAuth, async (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return res.status(400).json({ error: 'Request body must be a plain object' });
    const allowedKeys = Object.keys(DEFAULT_PLATFORM_SETTINGS);
    const filtered = {};
    for (const key of allowedKeys) { if (key in updates) filtered[key] = Boolean(updates[key]); }
    if (Object.keys(filtered).length === 0) return res.status(400).json({ error: 'No valid settings keys provided' });
    try {
      const rows = await dbAll(db, 'SELECT id, client_id, settings_json FROM user_subscriptions WHERE user_id = ?', [req.userId]);
      if (rows.length > 0) {
        for (const row of rows) {
          const current = mergeSettings(row.settings_json);
          const merged = JSON.stringify({ ...current, ...filtered });
          await dbRun(db, 'UPDATE user_subscriptions SET settings_json = ? WHERE id = ?', [merged, row.id]);
          await dbRun(db, 'UPDATE subscriptions SET settings_json = ? WHERE client_id = ?', [merged, row.client_id]).catch(() => {});
        }
        const finalSettings = mergeSettings(rows[0].settings_json);
        return res.json({ success: true, settings: { ...finalSettings, ...filtered }, updated_devices: rows.length });
      } else {
        const clientId = req.query.clientId || req.body.clientId;
        const json = JSON.stringify({ ...DEFAULT_PLATFORM_SETTINGS, ...filtered });
        if (clientId) await dbRun(db, 'UPDATE subscriptions SET settings_json = ? WHERE client_id = ?', [json, clientId]).catch(() => {});
        return res.json({ success: true, settings: { ...DEFAULT_PLATFORM_SETTINGS, ...filtered }, updated_devices: 0, note: 'Saved to anonymous subscription. Will sync on next migration.' });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/user/devices', auth.requireAuth, async (req, res) => {
    try {
      const rows = await dbAll(db, 'SELECT id, client_id, device_name, settings_json, created_at FROM user_subscriptions WHERE user_id = ? ORDER BY created_at DESC', [req.userId]);
      res.json(rows.map(r => ({ ...r, settings: mergeSettings(r.settings_json) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/user/devices/:id', auth.requireAuth, async (req, res) => {
    const { device_name } = req.body;
    if (!device_name || typeof device_name !== 'string') return res.status(400).json({ error: 'device_name required' });
    try {
      const result = await dbRun(db, 'UPDATE user_subscriptions SET device_name = ? WHERE id = ? AND user_id = ?', [device_name.slice(0, 100), req.params.id, req.userId]);
      if (result.changes === 0) return res.status(404).json({ error: 'Device not found' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/user/devices/:id', auth.requireAuth, async (req, res) => {
    try {
      const device = await dbGet(db, 'SELECT client_id FROM user_subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      await dbRun(db, 'DELETE FROM user_subscriptions WHERE id = ?', [req.params.id]);
      await dbRun(db, 'DELETE FROM subscriptions WHERE client_id = ?', [device.client_id]).catch(() => {});
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/user/link-subscription', auth.requireAuth, async (req, res) => {
    const { client_id, device_name } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });
    try {
      await migrateSubscription(db, client_id, req.userId);
      if (device_name) await dbRun(db, 'UPDATE user_subscriptions SET device_name = ? WHERE client_id = ? AND user_id = ?', [device_name.slice(0, 100), client_id, req.userId]).catch(() => {});
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/android/link-user', auth.requireAuth, async (req, res) => {
    try {
      const { clientId, fcmToken } = req.body || {};
      if (!clientId && !fcmToken) return res.status(400).json({ error: 'clientId or fcmToken required' });
      const sql = fcmToken
        ? 'UPDATE android_devices SET user_id = ?, updated_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP WHERE fcm_token = ?'
        : 'UPDATE android_devices SET user_id = ?, updated_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP WHERE client_id = ?';
      const param = fcmToken ? String(fcmToken).trim() : String(clientId).trim();
      const result = await dbRun(db, sql, [req.userId, param]);
      res.json(result.changes === 0 ? { success: true, updated: false, message: 'No android device found' } : { success: true, updated: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { register };
