const fs = require("fs");
const ctx = require("./context");

let historyJsonDebounceTimer = null;

async function updateHistoryJson() {
  const db = ctx.db;
  try {
    const query = (limit) => new Promise((resolve, reject) => {
      db.all(`SELECT n.id, n.title, n.body, n.url, n.icon, n.image, n.platform, n.status, strftime('%s', n.created_at) AS timestamp, (SELECT tm.id FROM twitter_media tm WHERE tm.tweet_id = n.tweet_id ORDER BY tm.id LIMIT 1) AS media_id, (SELECT tm.media_type FROM twitter_media tm WHERE tm.tweet_id = n.tweet_id ORDER BY tm.id LIMIT 1) AS media_type FROM notifications n ORDER BY n.id DESC LIMIT ?`, [limit], (err, rows) => err ? reject(err) : resolve(rows || []));
    });
    const countQuery = () => new Promise((resolve, reject) => db.get("SELECT COUNT(*) as count FROM notifications", [], (err, row) => err ? reject(err) : resolve(row?.count || 0)));
    const [rows, dbTotal] = await Promise.all([query(ctx.HISTORY_JSON_LIMIT), countQuery()]);
    const jsonLogs = rows.map(r => ({ id: r.id, title: r.title, body: r.body, url: r.url, icon: r.icon, image: r.image || null, platform: r.platform || "不明", status: r.status || "success", timestamp: r.timestamp ? Number(r.timestamp) : 0, media_url: (r.media_id && r.platform !== 'twitterSub') ? `/api/twitter-media/file/${r.media_id}` : null, media_type: (r.platform !== 'twitterSub') ? r.media_type : null }));
    await fs.promises.writeFile(ctx.HISTORY_JSON_PATH, JSON.stringify({ logs: jsonLogs, total: dbTotal, limit: ctx.HISTORY_JSON_LIMIT, lastUpdated: Math.floor(Date.now() / 1000) }), "utf8");
    console.log(`[updateHistoryJson] JSON(${ctx.HISTORY_JSON_LIMIT}) updated`);
  } catch (e) { console.error("[updateHistoryJson] error:", e); }
}

function scheduleHistoryJsonUpdate() {
  if (historyJsonDebounceTimer) clearTimeout(historyJsonDebounceTimer);
  historyJsonDebounceTimer = setTimeout(() => {
    historyJsonDebounceTimer = null;
    updateHistoryJson().catch(console.error);
  }, ctx.HISTORY_JSON_DEBOUNCE_MS);
}

setTimeout(() => { updateHistoryJson().catch(console.error); }, 1000);

module.exports = { updateHistoryJson, scheduleHistoryJsonUpdate };
