const ctx = require("../services/context");
const notif = require("../services/notification");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

// /api/send-test は認証なしで clientId だけで呼べるため、通知スパム防止に
// **クライアント単位**の制限を入れる（IP 単位の apiLimiter 300/分では多すぎる）。
// clientId は UUIDv4 なので攻撃者は他人の clientId を推測できないが、
// 推測できた／漏れた場合に 1 クライアントから大量送信できるのを防ぐ。
const sendTestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const cid = req.body && req.body.clientId;
    return cid ? String(cid) : ipKeyGenerator(req);
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many test notifications, please try again later." },
});

function register(app, db, authLimiter) {
  const { parseAndMergePlatformSettings, sendPushNotification } = notif;

  app.post("/api/save-platform-settings", (req, res) => {
    const { clientId, subscription, settings } = req.body || {};
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    if (!subscription || typeof subscription !== "object" || !subscription.endpoint) return res.status(400).json({ error: "subscription and endpoint required" });
    let subscriptionJson;
    try { subscriptionJson = JSON.stringify(subscription); } catch (e) { return res.status(400).json({ error: "invalid subscription object" }); }
    const mergedSettings = settings ? parseAndMergePlatformSettings(settings) : { ...ctx.DEFAULT_PLATFORM_SETTINGS };
    const settingsJson = JSON.stringify(mergedSettings);
    const endpoint = subscription.endpoint;
    const upsertSql = "INSERT INTO subscriptions (client_id, endpoint, subscription_json, settings_json) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET client_id = excluded.client_id, subscription_json = excluded.subscription_json, settings_json = excluded.settings_json";
    db.run(upsertSql, [clientId, endpoint, subscriptionJson, settingsJson], function (upsertErr) {
      if (!upsertErr) return res.json({ success: true, message: "Subscription saved" });
      fallbackUpsert(clientId, endpoint, subscriptionJson, settingsJson, (fallbackErr) => {
        if (fallbackErr) return res.status(500).json({ error: "DB error", detail: fallbackErr.message });
        res.json({ success: true, message: "Subscription saved" });
      });
    });
    function fallbackUpsert(clientId, endpoint, subscriptionJson, settingsJson, callback) {
      db.run("UPDATE subscriptions SET subscription_json = ?, settings_json = ?, endpoint = ? WHERE client_id = ?", [subscriptionJson, settingsJson, endpoint, clientId], function (updateErr) {
        if (updateErr?.message?.includes("UNIQUE")) {
          db.run("DELETE FROM subscriptions WHERE endpoint = ? AND client_id != ?", [endpoint, clientId], function (delErr) {
            if (delErr) return callback(delErr);
            db.run("INSERT INTO subscriptions (client_id, endpoint, subscription_json, settings_json) VALUES (?, ?, ?, ?)", [clientId, endpoint, subscriptionJson, settingsJson], function (insertErr) { callback(insertErr); });
          });
        } else if (updateErr) { callback(updateErr); }
        else if (this?.changes > 0) { callback(null); }
        else {
          db.run("INSERT INTO subscriptions (client_id, endpoint, subscription_json, settings_json) VALUES (?, ?, ?, ?)", [clientId, endpoint, subscriptionJson, settingsJson], function (insertErr) { callback(insertErr); });
        }
      });
    }
  });

  app.delete("/api/save-platform-settings", (req, res) => {
    const clientId = req.body?.clientId || req.query.clientId;
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    db.run("DELETE FROM subscriptions WHERE client_id = ?", [clientId], function (err) {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      res.json({ success: true, message: "Subscription deleted", deleted: this.changes });
    });
  });

  app.get("/api/get-platform-settings", (req, res) => {
    let clientId = req.query.clientId;
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    clientId = String(clientId).trim();
    if (!clientId || clientId.length > 256) return res.status(400).json({ error: "invalid clientId" });
    db.get("SELECT settings_json FROM subscriptions WHERE client_id = ?", [clientId], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      if (!row?.settings_json) return res.json({ settings: ctx.DEFAULT_PLATFORM_SETTINGS, exists: !!row });
      const raw = row.settings_json;
      if (typeof raw !== "string" || raw.length > 10 * 1024) return res.json({ settings: ctx.DEFAULT_PLATFORM_SETTINGS });
      try { const parsed = JSON.parse(raw); return res.json({ settings: { ...ctx.DEFAULT_PLATFORM_SETTINGS, ...parsed }, exists: true }); }
      catch (e) { return res.json({ settings: ctx.DEFAULT_PLATFORM_SETTINGS, exists: true }); }
    });
  });

  app.patch("/api/update-settings", (req, res) => {
    const { clientId, settings } = req.body || {};
    if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId required" });
    if (!settings || typeof settings !== "object") return res.status(400).json({ error: "settings required" });
    const merged = parseAndMergePlatformSettings(settings);
    db.run("UPDATE subscriptions SET settings_json = ? WHERE client_id = ?", [JSON.stringify(merged), clientId], function (err) {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      res.json({ success: true, updated: this.changes > 0 });
    });
  });

  app.get("/api/get-name", (req, res) => {
    const clientId = (req.query.clientId || "").trim();
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    db.get("SELECT name FROM subscriptions WHERE client_id = ?", [clientId], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ name: row.name || null });
    });
  });

  app.get("/api/get-user-data", (req, res) => {
    let clientId = req.query.clientId;
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    clientId = String(clientId).trim();
    if (!clientId || clientId.length > 256) return res.status(400).json({ error: "invalid clientId" });
    db.get("SELECT name, settings_json FROM subscriptions WHERE client_id = ?", [clientId], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      if (!row) return res.json({ name: null, settings: ctx.DEFAULT_PLATFORM_SETTINGS, exists: false });
      let settings = ctx.DEFAULT_PLATFORM_SETTINGS;
      if (row.settings_json && typeof row.settings_json === "string" && row.settings_json.length <= 10 * 1024) {
        try { settings = { ...ctx.DEFAULT_PLATFORM_SETTINGS, ...JSON.parse(row.settings_json) }; } catch {}
      }
      res.json({ name: row.name || null, settings, exists: true });
    });
  });

  app.post("/api/save-name", (req, res) => {
    let { clientId, name } = req.body || {};
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    clientId = String(clientId).trim();
    if (typeof name !== "string") return res.status(400).json({ error: "name required" });
    name = name.trim().slice(0, 255);
    db.get("SELECT 1 FROM subscriptions WHERE client_id = ?", [clientId], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      if (!row) return res.status(404).json({ error: "Subscription not found" });
      db.run("UPDATE subscriptions SET name = ? WHERE client_id = ?", [name || null, clientId], function (updateErr) {
        if (updateErr) return res.status(500).json({ error: "DB error", detail: updateErr.message });
        res.json({ success: true, clientId, name: name || null, changes: this.changes });
      });
    });
  });

  app.post("/api/save-platform-setting", (req, res) => {
    let { clientId, key, value } = req.body || {};
    if (!clientId || !key || typeof value === "undefined") return res.status(400).json({ error: "clientId, key, value required" });
    clientId = String(clientId).trim();
    key = String(key).trim();
    if (!clientId || clientId.length > 256) return res.status(400).json({ error: "invalid clientId" });
    if (!/^[A-Za-z0-9_]+$/.test(key) || key.length > 64) return res.status(400).json({ error: "invalid key" });
    const finalValue = typeof value === "string" ? value.toLowerCase() === "true" : !!value;
    db.run("BEGIN IMMEDIATE TRANSACTION", (beginErr) => {
      if (beginErr) return res.status(500).json({ error: "DB transaction error" });
      db.get("SELECT settings_json FROM subscriptions WHERE client_id = ?", [clientId], (selectErr, row) => {
        if (selectErr) return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));
        if (!row) return db.run("ROLLBACK", () => res.status(404).json({ error: "Subscription not found" }));
        let current = {};
        try { current = row.settings_json ? JSON.parse(row.settings_json) : {}; } catch { current = {}; }
        if (!current || typeof current !== "object") current = {};
        current[key] = finalValue;
        const updated = JSON.stringify(current);
        if (updated.length > 10 * 1024) return db.run("ROLLBACK", () => res.status(400).json({ error: "settings_json too large" }));
        db.run("UPDATE subscriptions SET settings_json = ? WHERE client_id = ?", [updated, clientId], function (updateErr) {
          if (updateErr) return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));
          db.run("COMMIT", (commitErr) => {
            if (commitErr) return db.run("ROLLBACK", () => res.status(500).json({ error: "DB commit error" }));
            res.json({ success: true, message: "Setting updated", settings: current });
          });
        });
      });
    });
  });

  app.get("/api/subscriptions", require("../lib/admin").requireAuth, (req, res) => {
    let limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    let offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    db.all("SELECT id, client_id, endpoint, created_at FROM subscriptions ORDER BY created_at DESC LIMIT ? OFFSET ?", [limit, offset], (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      res.json({ items: rows || [], limit, offset });
    });
  });

  app.get("/api/vapidPublicKey", (req, res) => {
    res.send(ctx.vapidConfig.vapidPublicKey || "");
  });

  app.post("/api/send-test", sendTestLimiter, (req, res) => {
    const { clientId } = req.body || {};
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    db.get("SELECT subscription_json FROM subscriptions WHERE client_id = ?", [clientId], async (err, row) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      if (!row || !row.subscription_json) return res.status(404).json({ error: "No subscription found" });
      let subscription;
      try { subscription = JSON.parse(row.subscription_json); } catch (e) { return res.status(500).json({ error: "Invalid subscription" }); }
      try {
        const result = await notif.sendPushNotification(subscription, {
          title: "テスト通知",
          body: "ここをクリックしてURL飛べるか確認！",
          url: "/test/",
          icon: "/icon.webp",
          image: "/testnotify.webp"
        });
        res.json({ success: true, sent: !!result });
      } catch (e) {
        res.status(500).json({ error: "Push send failed", detail: e.message });
      }
    });
  });
}

module.exports = { register };
