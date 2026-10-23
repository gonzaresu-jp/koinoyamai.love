const rateLimit = require("express-rate-limit");
const ctx = require("../services/context");
const notif = require("../services/notification");
const auth = require("../src/core/auth");
const { str, ValidationError } = require("../lib/validate");

// 🔒 無認証の FCM リレー化を防ぐ（/api/send-test と同じ 5 回/分）。
//  攻撃者の token を登録してテスト送信させると、サーバーが任意の宛先へ FCM を送る形になる。
const androidSendTestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many test notifications, please try again later." },
});

function register(app, db) {
  const { parseAndMergePlatformSettings } = notif;

  app.post("/api/android/register", auth.optionalAuth, (req, res) => {
    const { clientId, fcmToken, deviceName, settings } = req.body || {};
    if (!clientId || typeof clientId !== "string") return res.status(400).json({ error: "clientId required" });
    if (!fcmToken || typeof fcmToken !== "string") return res.status(400).json({ error: "fcmToken required" });
    // 🔒 deviceName は型と上限のみ検証する（DB にそのまま入り、画面にも表示される）。
    //  fcmToken は 20〜4096 の長さ検証が既にある（文字種は実トークンの仕様が不定のため検証しない）。
    let trimmedDeviceName = null;
    if (deviceName != null) {
      try {
        trimmedDeviceName = str(deviceName, { field: "deviceName", max: 100, trim: true });
      } catch (e) {
        if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    const trimmedClientId = clientId.trim();
    const trimmedToken = fcmToken.trim();
    if (!trimmedClientId || trimmedClientId.length > 256) return res.status(400).json({ error: "invalid clientId" });
    if (trimmedToken.length < 20 || trimmedToken.length > 4096) return res.status(400).json({ error: "invalid fcmToken" });
    const mergedSettings = settings ? parseAndMergePlatformSettings(settings) : { ...ctx.DEFAULT_PLATFORM_SETTINGS };
    const settingsJson = JSON.stringify(mergedSettings);
    const upsertSql = `INSERT INTO android_devices (client_id, fcm_token, device_name, settings_json, updated_at, last_seen_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(fcm_token) DO UPDATE SET client_id = excluded.client_id, device_name = excluded.device_name, settings_json = excluded.settings_json, updated_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP`;
    const params = [trimmedClientId, trimmedToken, trimmedDeviceName, settingsJson];
    function linkUser() { if (req.userId) db.run("UPDATE android_devices SET user_id = ?, updated_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP WHERE fcm_token = ?", [req.userId, trimmedToken]); }
    db.run(upsertSql, params, function (err) {
      if (!err) { linkUser(); return res.json({ success: true, message: "Android device registered" }); }
      db.run("UPDATE android_devices SET client_id = ?, device_name = ?, settings_json = ?, updated_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP WHERE fcm_token = ?", [trimmedClientId, trimmedDeviceName, settingsJson, trimmedToken], function (updateErr) {
        if (updateErr) return res.status(500).json({ error: "DB error", detail: updateErr.message });
        if (this.changes > 0) { linkUser(); return res.json({ success: true, message: "Android device updated" }); }
        db.run("INSERT INTO android_devices (client_id, fcm_token, device_name, settings_json, updated_at, last_seen_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)", params, function (insertErr) {
          if (insertErr) return res.status(500).json({ error: "DB error", detail: insertErr.message });
          linkUser();
          res.json({ success: true, message: "Android device registered" });
        });
      });
    });
  });

  app.delete("/api/android/register", (req, res) => {
    const fcmToken = req.body?.fcmToken || req.query.fcmToken;
    const clientId = req.body?.clientId || req.query.clientId;
    if (!fcmToken && !clientId) return res.status(400).json({ error: "fcmToken or clientId required" });
    const sql = fcmToken ? "DELETE FROM android_devices WHERE fcm_token = ?" : "DELETE FROM android_devices WHERE client_id = ?";
    const param = fcmToken ? String(fcmToken).trim() : String(clientId).trim();
    db.run(sql, [param], function (err) {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      res.json({ success: true, deleted: this.changes || 0 });
    });
  });

  app.post("/api/android/send-test", androidSendTestLimiter, (req, res) => {
    console.log("[android/send-test] Request received");
    const { fcmToken } = req.body || {};
    if (!fcmToken || typeof fcmToken !== "string") return res.status(400).json({ error: "fcmToken required" });
    const trimmedToken = fcmToken.trim();
    console.log("[android/send-test] token prefix:", trimmedToken.substring(0, 20));
    const fcm = notif.initFcm();
    if (!fcm) { console.error("[android/send-test] FCM not configured"); return res.status(500).json({ error: "FCM not configured" }); }
    console.log("[android/send-test] Sending FCM...");
    notif.sendFcmNotification(fcm, trimmedToken, {
      title: "テスト通知",
      body: "通知テスト成功！タップで確認",
      url: "/test/",
      icon: "/icon.webp",
      image: "/testnotify.webp"
    }, "test", null, false).then(result => {
      console.log("[android/send-test] result:", result.sent ? "SENT" : "FAILED", result.error?.message || "");
      if (result.sent) return res.json({ success: true });
      console.error("[android/send-test] FCM send failed:", result.error?.message || result.error);
      res.status(500).json({ error: "FCM send failed", detail: result.error?.message || String(result.error) });
    }).catch(e => {
      console.error("[android/send-test] FCM error:", e);
      res.status(500).json({ error: e.message });
    });
  });

  app.patch("/api/android/settings", (req, res) => {
    const { clientId, fcmToken, settings } = req.body || {};
    if (!settings || typeof settings !== "object") return res.status(400).json({ error: "settings required" });
    if (!clientId && !fcmToken) return res.status(400).json({ error: "clientId or fcmToken required" });
    const merged = parseAndMergePlatformSettings(settings);
    const sql = fcmToken ? "UPDATE android_devices SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE fcm_token = ?" : "UPDATE android_devices SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ?";
    const param = fcmToken ? String(fcmToken).trim() : String(clientId).trim();
    db.run(sql, [JSON.stringify(merged), param], function (err) {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      res.json({ success: true, updated: this.changes > 0 });
    });
  });
}

module.exports = { register };
