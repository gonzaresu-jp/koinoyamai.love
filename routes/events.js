const sched = require("../services/scheduler");
const ctx = require("../services/context");

function escapeXml(unsafe) {
  if (!unsafe) return "";
  return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const { periodToTime } = require("../src/scrapers/gemma-analyzer");

// http(s) のみ許可（XSS/SSRF 防止）。不正なら null。
function safeHttpUrl(u) {
  if (!u || typeof u !== "string") return null;
  try {
    const parsed = new URL(u.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.href : null;
  } catch { return null; }
}

const VALID_TIME_PERIODS = ["MORNING", "NOON", "EVENING", "NIGHT", "LATE_NIGHT"];
function normalizeTimePeriod(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  return VALID_TIME_PERIODS.includes(v) ? v : null;
}

// start_time を保存用に正規化する。
// 1) 時間帯指定あり → 「日付 + 時間帯の代表時刻」に補完（時刻は非表示の内部値）。
// 2) 時間帯なしで日付のみ "YYYY-MM-DD" → ローカル0:00として扱う（"...T00:00"）。
//    日付のみ文字列はUTC0時と解釈され、JSTで9時間ズレ＝9:00や曜日ズレの原因になるため。
function applyPeriodTime(startTimeValue, timePeriodValue) {
  if (!startTimeValue) return startTimeValue;
  const s = String(startTimeValue);
  const datePart = s.slice(0, 10);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (timePeriodValue) {
    const t = periodToTime(timePeriodValue);
    if (t && /^\d{4}-\d{2}-\d{2}$/.test(datePart)) return `${datePart}T${t}`;
  }
  if (isDateOnly) return `${s}T00:00`;
  return s;
}

function register(app, db) {
  const adminAuth = require("../lib/admin");
  const { syncEventNotifications } = sched;

  app.get("/api/events", (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const from = req.query.from, to = req.query.to, platform = req.query.platform;
    const status = req.query.status || "scheduled";
    let sql = "SELECT * FROM events WHERE 1=1";
    const params = [];
    if (from) { sql += " AND start_time >= ?"; params.push(from); }
    if (to) { sql += " AND start_time <= ?"; params.push(to); }
    if (platform) { sql += " AND platform = ?"; params.push(platform); }
    if (status && status !== "all") { sql += " AND status = ?"; params.push(status); }
    sql += " ORDER BY start_time ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);
    db.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      res.json({ items: rows || [], limit, offset, total: rows ? rows.length : 0 });
    });
  });

  app.get("/api/events/rss", (req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    db.all("SELECT * FROM events WHERE start_time >= datetime('now', '-7 days') AND status != 'cancelled' ORDER BY start_time DESC LIMIT ?", [limit], (err, rows) => {
      if (err) return res.status(500).send("RSS generation failed");
      const baseUrl = req.protocol + "://" + req.get("host");
      const now = new Date().toUTCString();
      let rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>まいちゃん予定表</title>\n    <link>${baseUrl}</link>\n    <description>まいちゃんの配信・動画投稿予定</description>\n    <language>ja</language>\n    <lastBuildDate>${now}</lastBuildDate>\n    <atom:link href="${baseUrl}/api/events/rss" rel="self" type="application/rss+xml" />\n`;
      rows.forEach(event => {
        rss += `    <item>\n      <title>${escapeXml(event.title)}</title>\n      <link>${event.url || `${baseUrl}/events/${event.id}`}</link>\n      <description>${escapeXml(event.description || "")}</description>\n      <pubDate>${new Date(event.start_time).toUTCString()}</pubDate>\n      <guid isPermaLink="false">event-${event.id}</guid>`;
        if (event.platform) rss += `\n      <category>${escapeXml(event.platform)}</category>`;
        if (event.thumbnail_url) rss += `\n      <enclosure url="${escapeXml(event.thumbnail_url)}" type="${event.thumbnail_url?.endsWith(".webp") ? "image/webp" : "image/jpeg"}" />`;
        rss += `\n    </item>`;
      });
      rss += `\n  </channel>\n</rss>`;
      res.set("Content-Type", "application/rss+xml; charset=utf-8");
      res.set("Access-Control-Allow-Origin", "*");
      res.send(rss);
    });
  });

  app.get("/api/events/weekly", (req, res) => {
    const date = req.query.date || sched.toLocalDateString(new Date());
    const { sunday, from, to, weekStart } = sched.getWeekBoundsByDate(date);
    db.all("SELECT * FROM events WHERE start_time >= ? AND start_time < ? AND status != 'cancelled' ORDER BY start_time ASC", [from, to], (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      const weekData = Array(7).fill(null).map((_, i) => {
        const d = new Date(sunday); d.setDate(sunday.getDate() + i);
        return { date: sched.toLocalDateString(d), dayOfWeek: ["日", "月", "火", "水", "木", "金", "土"][i], events: [] };
      });
      rows.forEach(event => { if (event.start_time) weekData[new Date(event.start_time).getDay()].events.push(event); });
      db.get("SELECT week_start, message, updated_at FROM weekly_messages WHERE week_start = ? LIMIT 1", [weekStart], (msgErr, msgRow) => {
        if (msgErr) return res.status(500).json({ error: "DB error", detail: msgErr.message });
        res.json({ week: weekData, from, to, weekMessage: msgRow ? { weekStart: msgRow.week_start, message: msgRow.message, updatedAt: msgRow.updated_at } : null });
      });
    });
  });

  app.get("/api/events/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid event ID" });
    db.get("SELECT * FROM events WHERE id = ?", [id], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      if (!row) return res.status(404).json({ error: "Event not found" });
      res.json(row);
    });
  });

  // --- Admin events ---
  app.post("/api/admin/events", adminAuth.requireAuth, (req, res) => {
    const { title, start_time, end_time, url, thumbnail_url, platform, event_type, description, status, external_id, time_period } = req.body;
    const endTimeValue = end_time?.trim() ? end_time : null;
    const timePeriodValue = normalizeTimePeriod(time_period);
    const startTimeValue = applyPeriodTime(start_time?.trim() ? start_time : null, timePeriodValue);
    let confirmed;
    if (req.body.confirmed !== undefined && req.body.confirmed !== null) confirmed = req.body.confirmed ? 1 : 0;
    else if (status === "ended") confirmed = 1;
    else if (startTimeValue) { const eventDate = new Date(startTimeValue); confirmed = eventDate < new Date() ? 1 : null; }
    else confirmed = null;
    const sql = "INSERT INTO events (title, start_time, end_time, url, thumbnail_url, platform, event_type, description, status, external_id, confirmed, time_period) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    db.run(sql, [title, startTimeValue, endTimeValue, safeHttpUrl(url), safeHttpUrl(thumbnail_url), platform || "other", event_type || "live", description || null, status || "scheduled", external_id || null, confirmed, timePeriodValue], function (err) {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      const newId = this.lastID;
      syncEventNotifications().catch(console.error);
      db.get("SELECT * FROM events WHERE id = ?", [newId], (err2, row) => {
        if (err2) return res.status(500).json({ error: "Event created but failed to fetch", id: newId });
        res.json(row);
      });
    });
  });

  app.get("/api/admin/events", adminAuth.requireAuth, (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    db.all("SELECT * FROM events ORDER BY start_time DESC LIMIT ?", [limit], (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      res.json({ items: rows });
    });
  });

  app.put("/api/admin/events/:id", adminAuth.requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid event ID" });
    const { title, start_time, end_time, url, thumbnail_url, platform, event_type, description, status, external_id, confirmed, time_period } = req.body;
    const updates = []; const params = [];
    // time_period が来ていればそれを、来ていなければ既存値は不明なので start_time はそのまま扱う
    const timePeriodForStart = time_period !== undefined ? normalizeTimePeriod(time_period) : null;
    if (title !== undefined) { updates.push("title = ?"); params.push(title); }
    if (start_time !== undefined) {
      const raw = start_time?.trim() ? start_time : null;
      const v = applyPeriodTime(raw, timePeriodForStart);
      updates.push("start_time = ?"); params.push(v);
      if (confirmed === undefined && v) { const d = new Date(v); updates.push("confirmed = ?"); params.push(d < new Date() ? 1 : null); }
    }
    if (end_time !== undefined) { updates.push("end_time = ?"); params.push(end_time?.trim() ? end_time : null); }
    if (url !== undefined) { updates.push("url = ?"); params.push(safeHttpUrl(url)); }
    if (thumbnail_url !== undefined) { updates.push("thumbnail_url = ?"); params.push(safeHttpUrl(thumbnail_url)); }
    if (platform !== undefined) { updates.push("platform = ?"); params.push(platform); }
    if (event_type !== undefined) { updates.push("event_type = ?"); params.push(event_type); }
    if (description !== undefined) { updates.push("description = ?"); params.push(description); }
    if (status !== undefined) { updates.push("status = ?"); params.push(status); }
    if (external_id !== undefined) { updates.push("external_id = ?"); params.push(external_id); }
    if (confirmed !== undefined) { updates.push("confirmed = ?"); params.push(confirmed); }
    if (time_period !== undefined) { updates.push("time_period = ?"); params.push(normalizeTimePeriod(time_period)); }
    if (!updates.length) return res.status(400).json({ error: "No fields to update" });
    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(id);
    db.run(`UPDATE events SET ${updates.join(", ")} WHERE id = ?`, params, function (err) {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      if (!this.changes) return res.status(404).json({ error: "Event not found" });
      syncEventNotifications().catch(console.error);
      db.get("SELECT * FROM events WHERE id = ?", [id], (err2, row) => {
        if (err2) return res.status(500).json({ error: "Event updated but failed to fetch" });
        res.json(row);
      });
    });
  });

  app.get("/api/admin/events/:id", adminAuth.requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid event ID" });
    db.get("SELECT * FROM events WHERE id = ?", [id], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      if (!row) return res.status(404).json({ error: "Event not found" });
      res.json(row);
    });
  });

  app.delete("/api/admin/events/:id", adminAuth.requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid event ID" });
    db.run("DELETE FROM events WHERE id = ?", [id], function (err) {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      if (!this.changes) return res.status(404).json({ error: "Event not found" });
      syncEventNotifications().catch(console.error);
      res.json({ success: true, message: "Event deleted" });
    });
  });

  // --- Weekly messages ---
  app.get("/api/admin/weekly-message", adminAuth.requireAuth, (req, res) => {
    const date = req.query.date || sched.toLocalDateString(new Date());
    const { weekStart } = sched.getWeekBoundsByDate(date);
    db.get("SELECT week_start, message, created_at, updated_at FROM weekly_messages WHERE week_start = ? LIMIT 1", [weekStart], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      res.json({ weekStart, exists: Boolean(row), message: row?.message || "", createdAt: row?.created_at || null, updatedAt: row?.updated_at || null });
    });
  });

  app.post("/api/admin/weekly-message", adminAuth.requireAuth, (req, res) => {
    const { date, weekStart, message } = req.body || {};
    const normalizedWeekStart = weekStart ? sched.toLocalDateString(new Date(weekStart)) : sched.getWeekBoundsByDate(date || sched.toLocalDateString(new Date())).weekStart;
    if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "message is required" });
    db.run("INSERT INTO weekly_messages (week_start, message, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(week_start) DO UPDATE SET message = excluded.message, updated_at = CURRENT_TIMESTAMP", [normalizedWeekStart, message.trim()], function (err) {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      res.json({ success: true, weekStart: normalizedWeekStart, message: message.trim() });
    });
  });
}

module.exports = { register };
