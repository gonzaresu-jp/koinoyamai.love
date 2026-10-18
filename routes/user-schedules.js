'use strict';

const auth = require('../src/core/auth');
const admin = require('../lib/admin');
const { dbGet, dbRun, dbAll, normalizeOptionalText, normalizeRequiredTitle, normalizeOptionalHttpUrl, normalizeReminderMinutes, MAX_SCHEDULE_TITLE_LEN, MAX_SCHEDULE_TEXT_LEN, MAX_SCHEDULE_URL_LEN } = require('./user-helpers');

function register(app, db) {
  app.get('/api/user/schedules', auth.requireAuth, async (req, res) => {
    try {
      const rows = await dbAll(db,
        `SELECT us.id, us.event_id, COALESCE(us.source, 'user') AS source, us.title, us.note, us.url, us.thumbnail_url, us.scheduled_at, us.reminder_minutes, us.created_at, us.updated_at, e.title AS event_title, e.start_time, e.platform, e.url AS event_url, e.status AS event_status
         FROM user_schedules us LEFT JOIN events e ON e.id = us.event_id
         WHERE us.user_id = ? ORDER BY COALESCE(us.scheduled_at, e.start_time) ASC`,
        [req.userId]
      );
      const isAdmin = await admin.isAdminRequest(req);
      res.json(rows.map(row => ({ ...row, editable: isAdmin || (!row.event_id && row.source !== 'admin') })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/user/schedules', auth.requireAuth, async (req, res) => {
    const { event_id, title, note, text, url, thumbnail_url, scheduled_at, reminder_minutes } = req.body;
    try {
      const normalizedText = normalizeOptionalText(note ?? text, MAX_SCHEDULE_TEXT_LEN);
      const normalizedUrl = normalizeOptionalHttpUrl(url);
      const normalizedThumbUrl = normalizeOptionalHttpUrl(thumbnail_url);
      const normalizedReminder = normalizeReminderMinutes(reminder_minutes, 30);

      if (event_id !== undefined && event_id !== null) {
        const event = await dbGet(db, 'SELECT id FROM events WHERE id = ?', [event_id]);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const result = await dbRun(db,
          `INSERT INTO user_schedules (user_id, event_id, source, note, url, thumbnail_url, reminder_minutes) VALUES (?, ?, 'admin', ?, ?, ?, ?)`,
          [req.userId, event_id, normalizedText ?? null, normalizedUrl ?? null, normalizedThumbUrl ?? null, normalizedReminder]
        );
        return res.status(201).json({ success: true, id: result.lastID, source: 'admin' });
      }

      const normalizedTitle = normalizeRequiredTitle(title);
      if (!normalizedTitle) return res.status(400).json({ error: 'title required' });
      if (!scheduled_at || isNaN(new Date(scheduled_at).getTime())) return res.status(400).json({ error: 'valid scheduled_at required' });

      const result = await dbRun(db,
        `INSERT INTO user_schedules (user_id, event_id, source, title, note, url, thumbnail_url, scheduled_at, reminder_minutes) VALUES (?, NULL, 'user', ?, ?, ?, ?, ?, ?)`,
        [req.userId, normalizedTitle, normalizedText ?? null, normalizedUrl ?? null, normalizedThumbUrl ?? null, scheduled_at, normalizedReminder]
      );
      res.status(201).json({ success: true, id: result.lastID, source: 'user' });
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg === 'URL_INVALID' || msg === 'URL_SCHEME_INVALID') return res.status(400).json({ error: 'URL must be http/https' });
      if (msg === 'URL_TOO_LONG') return res.status(400).json({ error: `URL too long (max ${MAX_SCHEDULE_URL_LEN})` });
      if (msg === 'REMINDER_INVALID') return res.status(400).json({ error: 'reminder_minutes must be one of: 60,30,10,5,3,0' });
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/user/schedules/:id', auth.requireAuth, async (req, res) => {
    const { title, note, text, url, thumbnail_url, scheduled_at, reminder_minutes } = req.body;
    try {
      const normalizedTitle = normalizeOptionalText(title, MAX_SCHEDULE_TITLE_LEN);
      const normalizedText = normalizeOptionalText(note ?? text, MAX_SCHEDULE_TEXT_LEN);
      const normalizedUrl = normalizeOptionalHttpUrl(url);
      const normalizedThumbUrl = normalizeOptionalHttpUrl(thumbnail_url);
      const normalizedReminder = (reminder_minutes === undefined) ? undefined : normalizeReminderMinutes(reminder_minutes, 30);

      if (title !== undefined && !normalizedTitle) return res.status(400).json({ error: 'title required' });
      if (scheduled_at !== undefined && scheduled_at !== null && scheduled_at !== '' && isNaN(new Date(scheduled_at).getTime())) return res.status(400).json({ error: 'valid scheduled_at required' });

      const target = await dbGet(db, 'SELECT source FROM user_schedules WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
      if (!target) return res.status(404).json({ error: 'Schedule not found' });
      if (target.source === 'admin' && !(await admin.isAdminRequest(req))) return res.status(403).json({ error: 'Permission denied' });

      const result = await dbRun(db,
        `UPDATE user_schedules SET title = COALESCE(?, title), note = COALESCE(?, note), url = COALESCE(?, url), thumbnail_url = COALESCE(?, thumbnail_url), scheduled_at = COALESCE(?, scheduled_at), reminder_minutes = COALESCE(?, reminder_minutes), reminder_sent_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND event_id IS NULL`,
        [normalizedTitle ?? null, normalizedText ?? null, normalizedUrl ?? null, normalizedThumbUrl ?? null, scheduled_at ?? null, normalizedReminder ?? null, req.params.id, req.userId]
      );
      if (result.changes === 0) return res.status(403).json({ error: 'Permission denied' });
      res.json({ success: true });
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg === 'URL_INVALID' || msg === 'URL_SCHEME_INVALID') return res.status(400).json({ error: 'URL must be http/https' });
      if (msg === 'URL_TOO_LONG') return res.status(400).json({ error: `URL too long (max ${MAX_SCHEDULE_URL_LEN})` });
      if (msg === 'REMINDER_INVALID') return res.status(400).json({ error: 'reminder_minutes must be one of: 60,30,10,5,3,0' });
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/user/schedules/:id', auth.requireAuth, async (req, res) => {
    try {
      const schedule = await dbGet(db, 'SELECT id, source, reminder_sent_at FROM user_schedules WHERE id = ? AND user_id = ? AND event_id IS NULL', [req.params.id, req.userId]);
      if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
      if (schedule.source === 'admin' && !(await admin.isAdminRequest(req))) return res.status(403).json({ error: 'Permission denied' });

      await dbRun(db, "UPDATE user_schedules SET reminder_sent_at = 'deleted' WHERE id = ? AND reminder_sent_at IS NULL", [req.params.id]);
      await dbRun(db, 'DELETE FROM user_schedules WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { register };
