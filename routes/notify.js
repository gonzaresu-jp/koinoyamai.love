const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const ctx = require("../services/context");
const notif = require("../services/notification");
const sse = require("../services/sse");
const { isPlainObject, str, ValidationError } = require("../lib/validate");
const { scheduleHistoryJsonUpdate } = require("../services/history");

const notifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many notify requests, please try again later." } });

function register(app, db) {
  const { sendPushNotification, sendFcmNotification, initFcm, isInvalidFcmError, getNotificationHash, parseAndMergePlatformSettings, transformUrl, mapWithLimit } = notif;

  function requireNotifyToken(req, res, next) {
    const token = req.headers["x-notify-token"] || req.headers["x-local-api-token"];
    if (!ctx.NOTIFY_API_TOKEN) return res.status(503).json({ error: "Notification API is not configured" });
    const provided = String(token || "");
    const expected = String(ctx.NOTIFY_API_TOKEN);
    const valid = provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (valid) return next();
    return res.status(401).json({ error: "Unauthorized: invalid notify token" });
  }

  // v2: 署名対象は `${timestamp}.${rawBody}`（生ボディ）。
  // JSON を作り直して検証するとキー順・空白・数値表記の違いで壊れるため、
  // express.json({ verify }) で保持した受信バイト列そのもので検証する。
  // タイムスタンプ（X-Notify-Timestamp: UNIX秒、許容±300秒）でリプレイを防止する。
  const HMAC_SKEW_SEC = 300;
  function verifyNotifyHmac(req, res, next) {
    if (!ctx.NOTIFY_HMAC_SECRET) return res.status(503).json({ error: "Notification HMAC is not configured" });
    const hmac = String(req.headers["x-notify-hmac"] || req.headers["x-hmac-signature"] || '').replace(/^sha256=/, '');
    if (!hmac) return res.status(401).json({ error: "Missing HMAC signature" });
    const ts = String(req.headers["x-notify-timestamp"] || '');
    if (!/^\d{10}$/.test(ts)) return res.status(401).json({ error: "Missing or invalid timestamp" });
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
    if (age > HMAC_SKEW_SEC) return res.status(401).json({ error: "Expired timestamp" });
    const raw = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body);
    const expected = crypto.createHmac("sha256", ctx.NOTIFY_HMAC_SECRET).update(ts + "." + raw).digest("hex");
    const valid = hmac.length === expected.length && crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
    if (!valid) return res.status(401).json({ error: "Invalid HMAC signature" });
    next();
  }

  // 🔒 入力検証（fail-closed）。HMAC で「改ざんされていない」ことは保証されるが、
  //  **型が想定と違う**入力は sqlite3 のバインドでエラーになり、記録も送信もされないまま
  //  `success` を返す「静かな失敗」になる（通知というメイン機能が止まる）。
  //  未知キーは弾かない（新フィールドを足すだけで壊れないようにするため）。
  //  既知フィールドの**型と上限だけ**を検証し、違反は 400 で原因を返す。
  const NOTIFY_TEXT_LIMITS = { title: 500, body: 4000, url: 2048, icon: 2048, image: 2048 };

  app.post("/api/notify", notifyLimiter, requireNotifyToken, verifyNotifyHmac, (req, res) => {
    let data;
    let type;
    let settingKey;
    try {
      const body = isPlainObject(req.body) ? req.body : {};
      if (!isPlainObject(body.data)) throw new ValidationError("data must be an object");
      data = { ...body.data };
      type = str(body.type, { field: "type", min: 1, max: 50 });
      settingKey = body.settingKey == null
        ? null
        : str(body.settingKey, { field: "settingKey", min: 1, max: 50 });
      for (const [key, max] of Object.entries(NOTIFY_TEXT_LIMITS)) {
        const v = data[key];
        if (v == null) { data[key] = null; continue; } // 未指定は従来どおり null（送信側の仕様を変えない）
        data[key] = str(v, { field: `data.${key}`, max });
      }
      // tweet_id は Twitter の snowflake が number で来る（文字列も許容）
      if (data.tweet_id != null) {
        const t = typeof data.tweet_id;
        // NaN/Infinity は JSON に表現できないが、`typeof` だけでは通るため明示的に弾く
        if (t === "number" && !Number.isFinite(data.tweet_id)) throw new ValidationError("data.tweet_id must be finite");
        if (t !== "number" && t !== "string") throw new ValidationError("data.tweet_id must be a string or a number");
      }
    } catch (e) {
      if (e instanceof ValidationError) {
        console.warn("[/api/notify] rejected:", e.message);
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }
    if (!data || !type) return res.status(400).json({ error: "Missing data or type" });
    console.log("[/api/notify] Received:", { title: data.title, settingKey });

    // テスト環境（DISABLE_NOTIFICATIONS=1）では実pushを行わず、履歴に記録するだけにする
    if (process.env.DISABLE_NOTIFICATIONS === "1" || process.env.DISABLE_NOTIFICATIONS === "true") {
      db.run("INSERT INTO notifications (title, body, url, icon, image, platform, status, tweet_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [data.title || "テスト", data.body || "", data.url || null, data.icon || null, data.image || null, settingKey || type, "test", data.tweet_id || null]);
      scheduleHistoryJsonUpdate();
      console.log("[/api/notify] suppressed (DISABLE_NOTIFICATIONS) — logged to test DB only");
      return res.json({ success: true, message: "Notification suppressed (test env)", sentCount: 0, totalCount: 0, suppressed: true });
    }

    const notificationHash = getNotificationHash(data, settingKey);
    const now = Date.now();
    const lastSent = ctx.recentNotifications.get(notificationHash);
    if (lastSent && now - lastSent < ctx.DUPLICATE_WINDOW_MS) {
      return res.json({ success: true, message: "Duplicate notification ignored", duplicate: true });
    }
    ctx.recentNotifications.set(notificationHash, now);
    if (ctx.recentNotifications.size > 1000) {
      const cutoff = now - ctx.DUPLICATE_WINDOW_MS;
      for (const [hash, timestamp] of ctx.recentNotifications.entries()) {
        if (timestamp < cutoff) ctx.recentNotifications.delete(hash);
      }
    }

    db.run("INSERT INTO notifications (title, body, url, icon, image, platform, status, tweet_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [data.title, data.body, data.url, data.icon, data.image || null, settingKey || type, "success", data.tweet_id || null],
      function (insertErr) {
        if (!insertErr) {
          scheduleHistoryJsonUpdate();
          sse.sendSseEvent({ type: "history-updated", lastUpdated: Math.floor(Date.now() / 1000), added: [this.lastID] });
        }
      });

    db.all("SELECT client_id, subscription_json, settings_json FROM subscriptions", [], async (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      const total = rows?.length || 0;
      const CONCURRENCY = Math.max(1, parseInt(process.env.NOTIFY_CONCURRENCY, 10) || 20);

      async function sendForRow(row) {
        const clientId = row.client_id;
        if (!row.subscription_json) return { clientId, sent: false, reason: "no_subscription" };
        let subscription;
        try { subscription = JSON.parse(row.subscription_json); } catch (e) { return { clientId, sent: false, reason: "parse_error" }; }
        let settings = parseAndMergePlatformSettings(row.settings_json);
        if (settingKey && settings[settingKey] === false) return { clientId, sent: false, reason: "disabled" };
        const transformedData = { ...data };
        if (data.url) transformedData.url = transformUrl(data.url, settingKey || type, settings);
        try {
          const sent = await sendPushNotification(subscription, transformedData);
          return { clientId, sent };
        } catch (e) { return { clientId, sent: false, error: e?.message }; }
      }

      const results = await mapWithLimit(rows, CONCURRENCY, sendForRow);
      const webSentCount = results.filter(r => r?.sent).length;
      let androidSentCount = 0;
      let androidTotal = 0;

      const fcm = initFcm();
      if (fcm) {
        try {
          const androidRows = await new Promise((resolve, reject) => db.all("SELECT client_id, fcm_token, settings_json FROM android_devices", [], (err2, rows2) => err2 ? reject(err2) : resolve(rows2 || [])));
          androidTotal = androidRows.length;
          if (androidTotal) {
            const ANDROID_CONCURRENCY = Math.max(1, parseInt(process.env.ANDROID_NOTIFY_CONCURRENCY, 10) || 20);
            async function sendForAndroidRow(row) {
              if (!row?.fcm_token) return { sent: false, reason: "no_token" };
              if (settingKey) { const s = parseAndMergePlatformSettings(row.settings_json); if (s[settingKey] === false) return { sent: false, reason: "disabled" }; }
              const result = await sendFcmNotification(fcm, row.fcm_token, data, type, settingKey);
              if (!result.sent && result.error && isInvalidFcmError(result.error)) db.run("DELETE FROM android_devices WHERE fcm_token = ?", [row.fcm_token]);
              return { sent: result.sent };
            }
            const androidResults = await mapWithLimit(androidRows, ANDROID_CONCURRENCY, sendForAndroidRow);
            androidSentCount = androidResults.filter(r => r?.sent).length;
          }
        } catch (e) { console.error("[/api/notify] Android error:", e?.message); }
      } else { console.log("[/api/notify] FCM not configured; skipping Android"); }

      const sentCount = webSentCount + androidSentCount;
      console.log(`[/api/notify] Done: ${sentCount}/${total + androidTotal} (web=${webSentCount}, android=${androidSentCount})`);
      res.json({ success: true, message: `Notification sent to ${sentCount} clients`, sentCount, totalCount: total + androidTotal, detailsSummary: { attempted: total + androidTotal, succeeded: sentCount, failed: total + androidTotal - sentCount }, webPush: { sentCount: webSentCount, totalCount: total }, android: { sentCount: androidSentCount, totalCount: androidTotal } });
    });
  });

  // 内部API: 新着ツイートのGemma/Gemini分析結果をnotifications.dataに保存する。
  // POST /api/internal/twitter/analysis { tweet_id, platform, analysis }
  // twitter.js のgemmaPromiseから送信され、以降ツイート統計はログなしでこのカラムから集計できる。
  // 認証は /api/notify と同じ（トークン + HMAC 署名必須）で受ける。
  app.post("/api/internal/twitter/analysis", requireNotifyToken, verifyNotifyHmac, (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const analysis = body.analysis;
    let tweet_id;
    let platform;
    try {
      // 長さだけ検証（型は従来どおり。DB にそのまま入るので無制限は避ける）
      tweet_id = str(String(body.tweet_id ?? ""), { field: "tweet_id", min: 1, max: 64 });
      platform = str(body.platform, { field: "platform", min: 1, max: 50 });
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      throw e;
    }
    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
      return res.status(400).json({ error: "tweet_id, platform, analysis required" });
    }
    db.run(
      "UPDATE notifications SET data = ? WHERE tweet_id = ? AND platform = ?",
      [JSON.stringify(analysis), String(tweet_id), platform],
      function (err) {
        if (err) { console.error("[/api/internal/twitter/analysis] update err:", err.message); return res.status(500).json({ error: err.message }); }
        if (!this.changes) { console.warn("[/api/internal/twitter/analysis] no matching notification for tweet_id:", tweet_id); return res.json({ ok: true, updated: 0 }); }
        console.log(`[/api/internal/twitter/analysis] saved analysis for ${platform}/${tweet_id}`);
        res.json({ ok: true, updated: this.changes });
      }
    );
  });
}

module.exports = { register };
