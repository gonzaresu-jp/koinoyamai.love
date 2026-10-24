const webpush = require("web-push");
// firebase-admin v14 は名前空間 API を廃止した（admin.messaging / admin.credential は undefined
// になる）。モジュラー API（firebase-admin/app, firebase-admin/messaging）だけを使う。
// v12 の `admin.messaging()` に戻すと FCM 初期化が静かに失敗する（実測: 2026-10-23）。
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
// 配信開始通知のアラーム用チャネル名（生成側 scheduler.js / 判断側 notify-channel.js と
// 値がずれると、dispatch の再判定が常に false になり二度鳴りが無音で復帰する）。
const { START_ALARM_CHANNEL } = require("../src/core/notify-channel");
const ctx = require("./context");
const { publicHttpUrl } = require("../lib/validate");
const { pushGuard } = require("../lib/push-endpoint-guard");

// --- VAPID ---
function loadVapid() {
  const fs = require("fs");
  const path = require("path");
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vapid.json"), "utf8"));
  } catch (e) {
    console.warn("vapid.json load failed:", e.message);
  }
  if (cfg && cfg.vapidPublicKey && cfg.vapidPrivateKey) {
    try {
      webpush.setVapidDetails("mailto:admin@koinoyamai.love", cfg.vapidPublicKey, cfg.vapidPrivateKey);
      ctx.vapidConfig = cfg;
      console.log("VAPID keys loaded");
      return;
    } catch (e) {
      console.warn("vapid.json is invalid:", e.message);
    }
  }
  // 鍵が無い/壊れている場合も**サーバーを落とさない**。
  // 旧実装は catch の中で setVapidDetails("test-key") を呼び、
  // そこで再度例外が出て起動処理ごと落ちていた（2026-10-21 CI で発覚）。
  // Web Push 以外の機能（通知履歴・アーカイブ・チャット等）は動かしたいので、
  // push だけ無効にして継続する。
  ctx.vapidConfig = { vapidPublicKey: "", vapidPrivateKey: "" };
  console.warn("⚠️ VAPID 鍵が利用できないため Web Push 通知は無効（サーバーは継続します）");
}

// --- FCM ---
const FCM_SERVICE_ACCOUNT_JSON = process.env.FCM_SERVICE_ACCOUNT_JSON || null;
const FCM_SERVICE_ACCOUNT_PATH = process.env.FCM_SERVICE_ACCOUNT_PATH || null;

function initFcm() {
  if (ctx.fcmMessaging) return ctx.fcmMessaging;
  if (ctx.fcmInitAttempted) return null;
  ctx.fcmInitAttempted = true;
  try {
    let serviceAccount = null;
    if (FCM_SERVICE_ACCOUNT_JSON) {
      serviceAccount = JSON.parse(FCM_SERVICE_ACCOUNT_JSON);
    } else if (FCM_SERVICE_ACCOUNT_PATH) {
      const fs = require("fs");
      if (fs.existsSync(FCM_SERVICE_ACCOUNT_PATH)) {
        serviceAccount = JSON.parse(fs.readFileSync(FCM_SERVICE_ACCOUNT_PATH, "utf8"));
      }
    }
    if (!serviceAccount) { console.warn("FCM disabled: service account not configured"); return null; }
    if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
    ctx.fcmMessaging = getMessaging();
    console.log("FCM initialized");
    return ctx.fcmMessaging;
  } catch (e) {
    console.warn("FCM init failed:", e?.message || e);
    return null;
  }
}

// --- Push Notification ---
// webpush は送信前に鍵を検証して弾く。HTTP ステータスが付かないため status 判定では
// 拾えず、購読が恒久的に壊れているのに毎回ここに来続けてノイズになる。
// この2種は再登録しても治らない（＝その端末は受信不能）ため削除対象にする。
const PERMANENT_SUBSCRIPTION_ERROR = /not valid for specified curve|must have 'auth' and 'p256dh' keys/;

async function sendPushNotification(subscription, payload, isTest = false) {
  if (!subscription?.endpoint) { console.error("sendPushNotification: invalid subscription"); return false; }
  // デスクトップアプリ(WebView2/Electron)の偽エンドポイント等、http(s) 以外は
  // web-push が鍵検証エラー→恒久エラー判定で DB 行を消してしまうため、送信自体を避ける。
  // （デスクトップ側は send-test をクライアントで傍受してローカル通知を出す）
  if (!/^https?:\/\//i.test(subscription.endpoint)) {
    console.log("Skip non-http endpoint (desktop app):", subscription.endpoint);
    return false;
  }
  // 🔒 送信直前にも検証する（2026-10-23・SSRF 対策）。
  //  登録時の検証だけでは、①過去に登録された行 ②DNS が内部 IP に変わる経路 を塞げない。
  //  内部向けに見える宛先は**送信しない**（404/410 と同様に「送らない」が正解。DB 行は残す）。
  try {
    publicHttpUrl(subscription.endpoint, { field: "endpoint" });
  } catch (e) {
    console.log("Skip non-public endpoint (SSRF guard)");
    return false;
  }
  // 🔒 送信直前に **DNS 解決**も検証する（2026-10-24・issue #76 / option A）。
  //  上の publicHttpUrl はホスト名の文字列しか見ておらず、「ホスト名が内部 IP に解決される」
  //  経路（DNS rebinding）は塞げていない。解決先が private / loopback / link-local / CGNAT 等なら
  //  **送信しない**（web-push は独自エージェントのため接続 pin は不可。検査で閾値を上げる）。
  //  失敗時は黙って消さず、理由と解決先をログに出す（可視化が条件）。
  {
    const verdict = await pushGuard.check(subscription.endpoint);
    if (!verdict.ok) {
      console.warn("[push-guard] 送信を拒否", JSON.stringify({ reason: verdict.reason, host: verdict.hostname, addresses: verdict.addresses }));
      return false; // DB 行は残す（404/410 の削除とは別経路）
    }
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), isTest ? { TTL: 60 } : {});
    return true;
  } catch (err) {
    const status = err?.statusCode;
    console.error("Push send error", { endpoint: subscription.endpoint, status, message: err?.message });
    const permanent = PERMANENT_SUBSCRIPTION_ERROR.test(String(err?.message || ""));
    if (status === 410 || status === 404 || permanent) {
      console.log("Removing expired subscription:", subscription.endpoint);
      if (ctx.db && typeof ctx.db.run === "function") {
        ctx.db.run("DELETE FROM subscriptions WHERE endpoint = ?", [subscription.endpoint]);
      }
    }
    return false;
  }
}

const PUBLIC_URL = process.env.PUBLIC_URL || "https://koinoyamai.love";
function normalizeAbsoluteUrl(url) {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return PUBLIC_URL.replace(/\/$/, "") + (url.startsWith("/") ? url : "/" + url);
}

function buildFcmData(payload, type, settingKey) {
  const data = payload || {};
  const out = {};
  function put(key, value) { if (value !== undefined && value !== null) out[key] = String(value); }
  put("title", data.title);
  put("body", data.body);
  put("url", data.url);
  put("icon", data.icon);
  put("image", data.image);
  // 配信の開始時刻（ISO）。Android アプリが端末内アラームを予約하기に使う。
  // 値が無い通知（通常の新着通知など）には付けない。
  put("start_time", data.start_time);
  // Android の通知チャネル指定（任意）。「配信開始」通知をアラーム用チャネルで
  // 配信するために使う。指定が無ければ既定チャネル（mai_default）になる。
  put("channel", data.channel);
  if (type) put("type", type);
  if (settingKey) put("settingKey", settingKey);
  return out;
}

function isInvalidFcmError(err) {
  const code = err?.code ? String(err.code) : "";
  return code === "messaging/registration-token-not-registered" ||
         code === "messaging/invalid-registration-token" ||
         code === "messaging/invalid-argument";
}

async function sendFcmNotification(messaging, token, payload, type, settingKey, isTest = false) {
  if (!messaging || !token) return { sent: false, reason: "fcm_disabled_or_missing_token" };
  try {
    const data = buildFcmData(payload, type, settingKey);
    const absoluteImageUrl = payload.image ? normalizeAbsoluteUrl(payload.image) : undefined;
    if (absoluteImageUrl) data.image = absoluteImageUrl;
    // ★ 配信開始（アラーム用チャネル）の FCM は **data-only** で送る。
    //   `notification` ブロックを付けると、**バックグラウンド時に FCM SDK 自身が
    //   描画して `onMessageReceived` が呼ばれない** → アプリ側の
    //   「ループするアラーム音（フォアグラウンドサービス）」に到達できない。
    //   data-only なら（priority: high のため）アプリが起きて処理する。
    const isAlarmChannel = data.channel === START_ALARM_CHANNEL;
    const message = {
      token,
      data,
      ...(isAlarmChannel ? {} : {
        notification: {
          title: payload.title || "新着通知",
          body: payload.body || "",
          image: absoluteImageUrl || undefined
        }
      }),
      android: {
        priority: "high",
        ...(isAlarmChannel ? {} : {
          notification: {
            title: payload.title || "新着通知",
            body: payload.body || "",
            image: absoluteImageUrl || undefined,
            click_action: "OPEN_ACTIVITY_1",
            // 配信開始通知をアラーム用チャネルで配信する（突然の開始でも起きれるように）。
            // チャネル指定が無い環境では FCM SDK が既定チャネルへフォールバックする。
            ...(data.channel ? { channel_id: data.channel } : {})
          }
        })
      },
      webpush: {
        headers: { TTL: "86400" }
      }
    };
    await messaging.send(message, isTest === true);
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err };
  }
}

// --- Dedup ---
function getNotificationHash(data, settingKey) {
  const title = data?.title || "";
  const body = data?.body || "";
  const url = data?.url || "";
  return `${settingKey || ""}:${title}:${body}:${url}`;
}

// --- Admin Notify ---
async function handleAdminNotify(body, adminUser = "scheduler") {
  const { data, type, settingKey, clientId: clientIdsString } = body;
  if (!data || !type) throw new Error("Missing data or type");
  const clientIds = clientIdsString ? String(clientIdsString).split(",").map(id => id.trim()).filter(Boolean) : [];
  const isTargetedSend = clientIds.length > 0;
  const isScheduleEventNotify = type === "event" && settingKey === "schedule";

  if (adminUser === "user-scheduler" && !isTargetedSend) {
    console.warn("[Admin Notification] user-scheduler skip: missing target clientIds");
    return { sentCount: 0, totalCount: 0, skipped: true, reason: "missing_target" };
  }

  const MAX_TARGET = 500;
  if (clientIds.length > MAX_TARGET) throw new Error(`Too many clientIds (max ${MAX_TARGET})`);

  console.log(`[Admin Notification] ${adminUser} => ${isTargetedSend ? `target ${clientIds.length}` : "broadcast"}:`, data.title);

  const notificationHash = getNotificationHash(data, settingKey);
  const now = Date.now();
  const lastSent = ctx.recentNotifications.get(notificationHash);
  if (lastSent && now - lastSent < ctx.DUPLICATE_WINDOW_MS) return { duplicate: true, sentCount: 0, totalCount: 0 };
  ctx.recentNotifications.set(notificationHash, now);

  const db = ctx.db;
  if (!isTargetedSend && !isScheduleEventNotify) {
    db.run("INSERT INTO notifications (title, body, url, icon, image, platform, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [data.title, data.body, data.url, data.icon, data.image || null, settingKey || type || "admin", "success"],
      function (insertErr) {
        if (!insertErr) {
          const { scheduleHistoryJsonUpdate } = require("./history");
          scheduleHistoryJsonUpdate();
          const { sendSseEvent } = require("./sse");
          try { sendSseEvent({ type: "history-updated", lastUpdated: Math.floor(Date.now() / 1000), added: [this.lastID] }); } catch {}
        }
      });
  }

  let selectSql = "SELECT client_id, subscription_json, settings_json FROM subscriptions";
  let selectParams = [];
  if (isTargetedSend) {
    selectSql += ` WHERE client_id IN (${clientIds.map(() => "?").join(", ")})`;
    selectParams = clientIds;
  }

  const rows = await new Promise((resolve, reject) => {
    db.all(selectSql, selectParams, (err, r) => err ? reject(err) : resolve(r || []));
  });
  const total = rows.length;
  const CONCURRENCY = Math.max(1, parseInt(process.env.NOTIFY_CONCURRENCY, 10) || 20);

  async function mapWithLimit(items, limit, iterator) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) break;
        try { results[i] = await iterator(items[i], i); } catch (e) { results[i] = { sent: false }; }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function sendForRow(row) {
    if (!row.subscription_json) return { sent: false };
    try {
      const settings = parseAndMergePlatformSettings(row.settings_json);
      if (settingKey && settings[settingKey] === false) return { sent: false, reason: "disabled" };
      const transformedData = { ...data };
      if (data.url) transformedData.url = transformUrl(data.url, settingKey || type, settings);
      const subscription = JSON.parse(row.subscription_json);
      const sent = await sendPushNotification(subscription, transformedData);
      return { sent };
    } catch { return { sent: false }; }
  }

  const results = await mapWithLimit(rows, CONCURRENCY, sendForRow);
  const webSentCount = results.filter(r => r.sent).length;
  let androidSentCount = 0;
  let androidTotal = 0;

  const fcm = initFcm();
  if (fcm) {
    try {
      let androidSql = "SELECT client_id, fcm_token, settings_json FROM android_devices";
      let androidParams = [];
      if (isTargetedSend) {
        androidSql += ` WHERE client_id IN (${clientIds.map(() => "?").join(", ")})`;
        androidParams = clientIds;
      }
      const androidRows = await new Promise((resolve, reject) => db.all(androidSql, androidParams, (err, r) => err ? reject(err) : resolve(r || [])));
      androidTotal = androidRows.length;
      if (androidTotal) {
        const ANDROID_CONCURRENCY = Math.max(1, parseInt(process.env.ANDROID_NOTIFY_CONCURRENCY, 10) || 20);
        async function sendForAndroidRow(row) {
          if (!row?.fcm_token) return { sent: false };
          if (settingKey) {
            const settings = parseAndMergePlatformSettings(row.settings_json);
            if (settings[settingKey] === false) return { sent: false, reason: "disabled" };
          }
          const result = await sendFcmNotification(fcm, row.fcm_token, data, type, settingKey);
          if (!result.sent && result.error && isInvalidFcmError(result.error)) {
            db.run("DELETE FROM android_devices WHERE fcm_token = ?", [row.fcm_token]);
          }
          return { sent: result.sent };
        }
        const androidResults = await mapWithLimit(androidRows, ANDROID_CONCURRENCY, sendForAndroidRow);
        androidSentCount = androidResults.filter(r => r?.sent).length;
      }
    } catch (e) { console.error("[Admin Notification] Android error:", e?.message); }
  }

  const sentCount = webSentCount + androidSentCount;
  console.log(`[Admin Notification] Done: ${sentCount}/${total + androidTotal} (web=${webSentCount}, android=${androidSentCount})`);
  return { sentCount, totalCount: total + androidTotal, webSentCount, webTotal: total, androidSentCount, androidTotal };
}

function transformUrl(url, platform, settings) {
  if (!url || !settings?.customLinks) return url;
  const mapping = { twitcasting: "twitcasting", youtube: "youtube", youtubeCommunity: "youtube", twitch: "twitch", twitterMain: "twitter", twitterSub: "twitter", fanbox: "other", pixiv: "other", gipt: "other", bilibili: "other", milestone: "other", schedule: "other" };
  const linkKey = mapping[platform] || "other";
  const template = settings.customLinks[linkKey];
  if (!template?.trim()?.includes("{url}")) return url;
  try { return template.replace(/\{url\}/g, url); } catch { return url; }
}

function parseAndMergePlatformSettings(settingsJson) {
  let parsed = {};
  if (typeof settingsJson === "string" && settingsJson.trim() !== "") {
    try { parsed = JSON.parse(settingsJson); } catch { parsed = {}; }
  } else if (settingsJson && typeof settingsJson === "object") parsed = settingsJson;
  if (!parsed || typeof parsed !== "object") parsed = {};
  const merged = { ...ctx.DEFAULT_PLATFORM_SETTINGS, ...parsed };
  if (!merged.customLinks || typeof merged.customLinks !== "object") merged.customLinks = {};
  return merged;
}

async function mapWithLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      try { results[i] = await iterator(items[i], i); } catch (e) { results[i] = { error: e?.message || String(e) }; }
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { loadVapid, initFcm, sendPushNotification, sendFcmNotification, buildFcmData, isInvalidFcmError, getNotificationHash, handleAdminNotify, parseAndMergePlatformSettings, transformUrl, mapWithLimit };
