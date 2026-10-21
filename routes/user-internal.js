'use strict';

const crypto = require('crypto');

const { dbGet, dbRun, dbAll, normalizeRequiredTitle, normalizeOptionalText, normalizeOptionalHttpUrl, normalizeReminderMinutes, MAX_SCHEDULE_TITLE_LEN, MAX_SCHEDULE_TEXT_LEN, MAX_SCHEDULE_URL_LEN } = require('./user-helpers');

const VALID_TIME_PERIODS = ['MORNING', 'NOON', 'EVENING', 'NIGHT', 'LATE_NIGHT'];
function normalizeTimePeriod(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  return VALID_TIME_PERIODS.includes(v) ? v : null;
}

function toNaiveJst(d) {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth()+1)}-${p(jst.getUTCDate())}T${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}`;
}

function register(app, db) {
  function getInternalToken(req) {
    const token = process.env.INTERNAL_API_TOKEN || null;
    const authToken = req.headers['x-notify-token'] || req.query.token || '';
    if (!token) return { authorized: false, error: 'Internal API not configured' };
    // タイミング差で盗られないように定数時間比較にする（AGENTS.md §3 と同じ方針）。
    const a = Buffer.from(String(authToken));
    const b = Buffer.from(String(token));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { authorized: false, error: 'Unauthorized' };
    }
    return { authorized: true, token };
  }

  app.post('/api/internal/events/create', async (req, res) => {
    const auth = getInternalToken(req);
    if (!auth.authorized) return res.status(auth.error === 'Unauthorized' ? 401 : 503).json({ error: auth.error });

    try {
      const { title, scheduled_at, note, url, thumbnail_url, platform, external_id, time_period } = req.body;
      const normalizedTitle = normalizeRequiredTitle(title);
      if (!normalizedTitle) return res.status(400).json({ error: 'title required' });
      if (!scheduled_at || isNaN(new Date(scheduled_at).getTime())) return res.status(400).json({ error: 'valid scheduled_at required' });

      const normalizedText = normalizeOptionalText(note, MAX_SCHEDULE_TEXT_LEN);
      const normalizedUrl = normalizeOptionalHttpUrl(url);
      const normalizedThumbUrl = normalizeOptionalHttpUrl(thumbnail_url);
      const normalizedPeriod = normalizeTimePeriod(time_period);
      // 具体時刻ありの自動追加は「確定」、時間帯のみの推定は「未定」にする。
      // （従来は常に NULL = 未定 になっていた）
      const confirmedValue = normalizedPeriod ? null : 1;

      // --- 重複チェック ---
      // 1) external_id 完全一致  2) URL一致  3) 同日時±4時間以内
      const targetDate = new Date(scheduled_at);
      let dupRows = [];

      if (external_id) {
        dupRows = await dbAll(db,
          "SELECT id, title, platform, event_type, start_time FROM events WHERE external_id = ? AND status != 'cancelled' LIMIT 5",
          [external_id]);
      }
      if (dupRows.length === 0 && normalizedUrl) {
        dupRows = await dbAll(db,
          "SELECT id, title, platform, event_type, start_time FROM events WHERE url = ? AND url IS NOT NULL AND url != '' AND status IN ('scheduled','live') LIMIT 5",
          [normalizedUrl]);
      }
      if (dupRows.length === 0) {
        const minTime = new Date(targetDate.getTime() - 4 * 60 * 60 * 1000);
        const maxTime = new Date(targetDate.getTime() + 4 * 60 * 60 * 1000);
        // 時刻幅での重複判定は同プラットフォーム内だけで行う。
        // YouTube 配信とツイキャス FC限定は同時刻でも完全に別の配信で、platform を
        // 見ずに判定すると先に登録された側が後から来る配信を 409 で弾き、
        // その配信がスケジュールから丸ごと消える事故が起きていた。
        dupRows = await dbAll(db,
          "SELECT id, title, platform, event_type, start_time FROM events WHERE start_time BETWEEN ? AND ? AND platform = ? AND status IN ('scheduled','live') ORDER BY start_time DESC LIMIT 5",
          [toNaiveJst(minTime), toNaiveJst(maxTime), platform || 'twitter']);
      }

      // 4) time_period 付きの推定イベントとの同日重複チェック。
      // Gemma の推定時刻（例: 22:00 仮置き）と YouTube の確定時刻（例: 21:00）が
      // ±4時間を超える場合でも、同日に time_period 付きの配信予定があれば重複扱いにする。
      if (dupRows.length === 0) {
        const dayStart = toNaiveJst(new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()));
        const dayEnd = toNaiveJst(new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() + 1));
        dupRows = await dbAll(db,
          "SELECT id, title, platform, event_type, start_time FROM events WHERE start_time BETWEEN ? AND ? AND event_type = 'live' AND status IN ('scheduled','live') AND time_period IS NOT NULL LIMIT 5",
          [dayStart, dayEnd]);
      }

      if (dupRows.length > 0) {
        return res.status(409).json({ error: 'duplicate', duplicates: dupRows });
      }

      const result = await dbRun(db,
        `INSERT INTO events (title, start_time, description, url, thumbnail_url, platform, event_type, status, external_id, confirmed, time_period)
         VALUES (?, ?, ?, ?, ?, ?, 'live', 'scheduled', ?, ?, ?)`,
        [normalizedTitle, scheduled_at, normalizedText ?? null, normalizedUrl ?? null, normalizedThumbUrl ?? null, platform || 'twitter', external_id ?? null, confirmedValue, normalizedPeriod]
      );

      res.status(201).json({ success: true, id: result.lastID, platform: platform || 'twitter' });
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg === 'URL_INVALID' || msg === 'URL_SCHEME_INVALID') return res.status(400).json({ error: 'URL must be http/https' });
      if (msg === 'URL_TOO_LONG') return res.status(400).json({ error: `URL too long (max ${MAX_SCHEDULE_URL_LEN})` });
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/internal/events/find-duplicate', async (req, res) => {
    const auth = getInternalToken(req);
    if (!auth.authorized) return res.status(auth.error === 'Unauthorized' ? 401 : 503).json({ error: auth.error });

    try {
      const { external_id, scheduled_at, title, url } = req.query;
      if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });

      const isLiveRelated = str => /配信|ライブ|生放送|stream|live|🔴|asmr|ASMR|雑談|ごごまい|ホラゲー|游戏|歌枠/i.test(str);

      let rows = [];

      // 1) external_id 完全一致（最優先）
      if (external_id) {
        rows = await dbAll(db,
          "SELECT * FROM events WHERE external_id = ? AND status != 'cancelled' LIMIT 5",
          [external_id]);
      }

      // 2) URL一致（URLがある場合、同じ配信の別ツイートを検出）
      if (rows.length === 0 && url) {
        rows = await dbAll(db,
          "SELECT * FROM events WHERE url = ? AND url IS NOT NULL AND url != '' AND status IN ('scheduled','live') LIMIT 5",
          [url]);
      }

      // 3) 時間範囲マッチ（±4時間）
      if (rows.length === 0) {
        const targetDate = new Date(scheduled_at);
        const minTime = new Date(targetDate.getTime() - 4 * 60 * 60 * 1000);
        const maxTime = new Date(targetDate.getTime() + 4 * 60 * 60 * 1000);

        const timeRows = await dbAll(db,
          "SELECT * FROM events WHERE start_time BETWEEN ? AND ? AND status IN ('scheduled','live') ORDER BY start_time DESC",
          [toNaiveJst(minTime), toNaiveJst(maxTime)]
        );

        // 既存イベントが event_type = 'live'（配信予定として登録済み）なら、
        // 新規側のキーワード不一致でも重複扱いにする。
        // 既存が ended は SQL で除外済み。
        rows = timeRows.filter(r => r.event_type === 'live' || isLiveRelated(r.title));
      }

      // 4) タイトル一致 + 同日マッチ（Gemma推定時刻とYouTube確定時刻が大きく異なる場合のフォールバック）。
      // time_period 付きの「未定」イベントが同日に同一タイトルで存在する場合、重複扱いにする。
      if (rows.length === 0 && normalizedTitle) {
        const targetDate = new Date(scheduled_at);
        const dayStart = toNaiveJst(new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()));
        const dayEnd = toNaiveJst(new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() + 1));

        const titleRows = await dbAll(db,
          "SELECT * FROM events WHERE title = ? AND start_time BETWEEN ? AND ? AND event_type = 'live' AND status IN ('scheduled','live') AND time_period IS NOT NULL",
          [normalizedTitle, dayStart, dayEnd]
        );
        rows = titleRows;
      }

      res.json({ found: rows.length > 0, duplicates: rows || [], near: rows.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/internal/events/update', async (req, res) => {
    const auth = getInternalToken(req);
    if (!auth.authorized) return res.status(auth.error === 'Unauthorized' ? 401 : 503).json({ error: auth.error });

    try {
      const { schedule_id, title, scheduled_at, note, url, platform, thumbnail_url } = req.body;
      if (!schedule_id) return res.status(400).json({ error: 'schedule_id required' });

      const normalizedTitle = normalizeOptionalText(title, MAX_SCHEDULE_TITLE_LEN);
      const normalizedText = normalizeOptionalText(note, MAX_SCHEDULE_TEXT_LEN);
      const normalizedUrl = normalizeOptionalHttpUrl(url);
      const normalizedThumbUrl = normalizeOptionalHttpUrl(thumbnail_url);

      // time_period は明示更新（null を渡すとラベルをクリア＝実時刻表示へ切替）。
      // body に time_period が含まれるときだけ更新対象にする。
      // あわせて confirmed も連動：具体時刻に確定（period=null）→ 確定(1)、時間帯のみ→ 未定(null)。
      let periodSet = '';
      const extraParams = [];
      if (Object.prototype.hasOwnProperty.call(req.body, 'time_period')) {
        const np = normalizeTimePeriod(req.body.time_period);
        periodSet = ', time_period = ?, confirmed = ?';
        extraParams.push(np, np ? null : 1);
      }

      const result = await dbRun(db,
        `UPDATE events SET title = COALESCE(?, title), start_time = COALESCE(?, start_time), description = COALESCE(?, description), url = COALESCE(?, url), thumbnail_url = COALESCE(?, thumbnail_url), platform = COALESCE(?, platform)${periodSet}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [normalizedTitle ?? null, scheduled_at ?? null, normalizedText ?? null, normalizedUrl ?? null, normalizedThumbUrl ?? null, platform ?? null, ...extraParams, schedule_id]
      );

      if (result.changes === 0) return res.status(404).json({ error: 'Event not found' });
      res.json({ success: true, updated: true });
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg === 'URL_INVALID' || msg === 'URL_SCHEME_INVALID') return res.status(400).json({ error: 'URL must be http/https' });
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { register };
