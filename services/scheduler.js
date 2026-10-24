const ctx = require("./context");
const notifier = require("./notification");
const { START_ALARM_CHANNEL } = require("../src/core/notify-channel");

/**
 * そのイベントの事前告知（event_pre_*）を 1 件でも送り済みなら true。
 * 配信開始通知のアラーム要否（`dispatchDueEventNotifications`）で使う。
 */
async function hasSentPreNoticeForEvent(db, eventId) {
  const row = await new Promise((resolve) => {
    db.get(
      "SELECT 1 AS hit FROM scheduled_notifications WHERE ref_id = ? AND kind LIKE 'event_pre_%' AND sent = 1 LIMIT 1",
      [eventId],
      (err, r) => {
        // err 時は null（＝アラーム側に倒す）。ただし黙って倒すと DB 障害時に
        // 「常にアラーム」が続くので、原因を残す。
        if (err) console.error("[Event Notify Dispatch] preNotice query err:", err.message);
        resolve(err ? null : r);
      },
    );
  });
  return !!row;
}

const EVENT_PRE_OFFSETS_MS = [30 * 60 * 1000, 3 * 60 * 1000];
const EVENT_NOTIFY_GRACE_MS = 2 * 60 * 1000;
const EVENT_NOTIFY_LOOKAHEAD_DAYS = 14;
const EVENT_NOTIFY_SYNC_INTERVAL_MS = 60 * 1000;
// ライブ開始からこの時間を過ぎたら終了扱い（end_time が無いイベント用）
const EVENT_AUTO_END_MS = 3 * 60 * 60 * 1000;

function toLocalDateString(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatLocalDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function getWeekBoundsByDate(dateInput) {
  const targetDate = new Date(dateInput || toLocalDateString(new Date()));
  const dayOfWeek = targetDate.getDay();
  const sunday = new Date(targetDate);
  sunday.setDate(targetDate.getDate() - dayOfWeek);
  const nextSunday = new Date(sunday);
  nextSunday.setDate(sunday.getDate() + 7);
  return { sunday, nextSunday, from: formatLocalDate(sunday), to: formatLocalDate(nextSunday), weekStart: toLocalDateString(sunday) };
}

// start_time / end_time は naive(JST) と UTC ISO(Z付き) が混在している。
// SQL の文字列比較は両者を同一視できないため、naive 行の live→ended が
// 約9時間遅れて「終了済みなのに LIVE 表示のまま」になる事故が起きていた。
// Date に渡せば naive はローカル(JST)、Z 付きは UTC として正しく解釈される。
function parseEventTime(value) {
  if (!value) return NaN;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function updateEventStatuses() {
  const db = ctx.db;
  const nowMs = Date.now();
  const autoEndMs = nowMs - EVENT_AUTO_END_MS;

  db.all(
    "SELECT id, status, start_time, end_time FROM events WHERE status IN ('scheduled','live')",
    [],
    function (err, rows) {
      if (err) { console.error("[Event Status] load err:", err.message); return; }
      const toLive = [];
      const toEnded = [];
      for (const row of rows || []) {
        const startMs = parseEventTime(row.start_time);
        if (!Number.isFinite(startMs)) continue;
        if (row.status === "scheduled") {
          if (startMs <= nowMs) toLive.push(row.id);
          continue;
        }
        const endMs = parseEventTime(row.end_time);
        const shouldEnd = Number.isFinite(endMs) ? endMs <= nowMs : startMs <= autoEndMs;
        if (shouldEnd) toEnded.push(row.id);
      }
      if (toLive.length) {
        db.run(`UPDATE events SET status = 'live', updated_at = CURRENT_TIMESTAMP WHERE id IN (${toLive.join(",")})`, function (e) {
          if (e) console.error("[Event Status] live err:", e.message);
          else if (this.changes > 0) console.log(`[Event Status] ${this.changes} events marked as live`);
        });
      }
      if (toEnded.length) {
        db.run(`UPDATE events SET status = 'ended', updated_at = CURRENT_TIMESTAMP WHERE id IN (${toEnded.join(",")})`, function (e) {
          if (e) console.error("[Event Status] ended err:", e.message);
          else if (this.changes > 0) console.log(`[Event Status] ${this.changes} events auto-ended`);
        });
      }
    }
  );
}

// CSP(img-src) は https のみ許可するため、http 配信のサムネは通知に載せる前に
// https へ昇格させる（events の http は全て imagegw*.twitcasting.tv、証明書確認済み）。
function toHttpsThumb(url) {
  if (!url) return null;
  return /^http:\/\/(?:[\w-]+\.)*twitcasting\.tv\//i.test(url) ? 'https://' + url.slice(7) : url;
}

function buildEventNotificationPayload(event, phase) {
  const startDate = new Date(event.start_time);
  const hh = String(startDate.getHours()).padStart(2, "0");
  const mm = String(startDate.getMinutes()).padStart(2, "0");
  const isPre = phase.startsWith("event_pre");
  const offsetMin = isPre ? Math.round(parseInt(phase.split("_")[2], 10) / 60000) : 0;
  // 開始の通知（event_start）はアラーム用チャネルを入れる候補にする。
  // **ただし送信直前に外すことがある**: 事前告知（event_pre_*）を送り済みの配信では、
  // 利用者は既に目を覚ましており（開始 15 分前に端末内アラームが鳴っている）、
  // 開始時にもう一度鳴ると二度鳴りになる（2026-10-23 の利用者報告）。
  // 生成時点では事前告知がまだ未送信の可能性があるため、この関数では**無条件**で付け、
  // 送信直前の `dispatchDueEventNotifications` が事前告知の送信有無を見て外す。
  // 事前告知の通知（event_pre_*）は情報通知のままにする。
  const isStart = phase === "event_start";
  return {
    type: "event", settingKey: "schedule",
    data: {
      title: event.title || "予定通知",
      body: isPre ? `開始${offsetMin}分前です（${hh}:${mm}予定）` : `予定時刻になりました（${hh}:${mm}）`,
      url: event.url || "/events.html", icon: "/icon.webp",
      image: toHttpsThumb(event.thumbnail_url),
      // 配信開始時刻（ISO）。Android アプリが端末内アラームを予約する時に使う。
      start_time: event.start_time || null,
      ...(isStart ? { channel: START_ALARM_CHANNEL } : {}),
    },
  };
}

async function syncEventNotifications() {
  const db = ctx.db;
  const now = Date.now();
  const maxOffset = Math.max(...EVENT_PRE_OFFSETS_MS);
  const fromIso = new Date(now - maxOffset - EVENT_NOTIFY_GRACE_MS).toISOString();
  const toIso = new Date(now + EVENT_NOTIFY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const events = await new Promise((resolve, reject) => {
    db.all(`SELECT id, title, start_time, url, thumbnail_url, platform, event_type, status, time_period FROM events WHERE start_time IS NOT NULL AND status != 'cancelled' AND event_type != 'memo' AND start_time >= ? AND start_time <= ?`, [fromIso, toIso], (err, rows) => {
      if (err) { console.error("[Event Notify Sync] load err:", err.message); resolve([]); } else resolve(rows || []);
    });
  });

  let inserted = 0, updated = 0, deleted = 0;
  for (const event of events) {
    const startMs = new Date(event.start_time).getTime();
    if (!Number.isFinite(startMs)) continue;
    if (String(event.event_type || "").toLowerCase() === "video") {
      await new Promise(r => db.run("DELETE FROM scheduled_notifications WHERE sent = 0 AND ref_id = ?", [event.id], function () { deleted += this.changes || 0; r(); }));
      continue;
    }
    // 曖昧な時間帯指定（time_period あり = 「夜ごろ」等）の予定は、start_time に
    // 入っているのは内部用の代表時刻（例: 22:00）にすぎず実際の開始時刻は未定。
    // 開始前アラーム等の時刻ベース通知は誤作動になるため生成しない（既存の未送信分も削除）。
    if (event.time_period) {
      await new Promise(r => db.run("DELETE FROM scheduled_notifications WHERE sent = 0 AND ref_id = ?", [event.id], function () { deleted += this.changes || 0; r(); }));
      continue;
    }
    const phases = EVENT_PRE_OFFSETS_MS.map(offset => ({ kind: `event_pre_${offset}`, runAt: startMs - offset }));
    if (String(event.event_type || "").toLowerCase() !== "live") phases.push({ kind: "event_start", runAt: startMs });
    else {
      await new Promise(r => db.run("DELETE FROM scheduled_notifications WHERE sent = 0 AND kind = 'event_start' AND ref_id = ?", [event.id], function () { deleted += this.changes || 0; r(); }));
    }
    for (const phase of phases) {
      if (phase.runAt < now - EVENT_NOTIFY_GRACE_MS) continue;
      const payloadJson = JSON.stringify(buildEventNotificationPayload(event, phase.kind));
      const existing = await new Promise(r => db.get("SELECT id, run_at, payload_json, sent FROM scheduled_notifications WHERE kind = ? AND ref_id = ? ORDER BY id DESC LIMIT 1", [phase.kind, event.id], (getErr, row) => r(row || null)));
      if (!existing) {
        await new Promise(r => db.run("INSERT INTO scheduled_notifications (run_at, payload_json, kind, ref_id) VALUES (?, ?, ?, ?)", [phase.runAt, payloadJson, phase.kind, event.id], function (insertErr) { if (!insertErr) inserted++; r(); }));
      } else if (existing.sent === 0) {
        await new Promise(r => db.run("UPDATE scheduled_notifications SET run_at = ?, payload_json = ?, sent = 0 WHERE id = ?", [phase.runAt, payloadJson, existing.id], function (updateErr) { if (!updateErr) updated += this.changes || 0; r(); }));
      } else if (existing.sent !== 1 || existing.run_at !== phase.runAt || existing.payload_json !== payloadJson) {
        await new Promise(r => db.run("INSERT INTO scheduled_notifications (run_at, payload_json, kind, ref_id) VALUES (?, ?, ?, ?)", [phase.runAt, payloadJson, phase.kind, event.id], function (insertErr) { if (!insertErr) inserted++; r(); }));
      }
    }
  }
  await new Promise(r => db.run("DELETE FROM scheduled_notifications WHERE sent = 0 AND (kind LIKE 'event_pre_%' OR kind = 'event_start') AND ref_id NOT IN (SELECT id FROM events WHERE start_time IS NOT NULL AND status = 'scheduled')", [], function (cleanupErr) { if (!cleanupErr) deleted += this.changes || 0; r(); }));
  if (inserted || updated || deleted) console.log(`[Event Notify Sync] inserted=${inserted} updated=${updated} deleted=${deleted}`);
}

async function sendUserScheduleReminders() {
  const db = ctx.db;
  const now = Date.now();
  const USER_SCHEDULE_LATE_CUTOFF_MS = 2 * 60 * 1000;
  const candidates = await new Promise((resolve, reject) => {
    db.all(`SELECT id, user_id, title, note, url, thumbnail_url, scheduled_at, reminder_minutes FROM user_schedules WHERE event_id IS NULL AND COALESCE(source, 'user') = 'user' AND scheduled_at IS NOT NULL AND reminder_sent_at IS NULL`, [], (err, rows) => {
      if (err) reject(err); else resolve(rows || []);
    });
  });
  for (const row of candidates) {
    const scheduledMs = new Date(row.scheduled_at).getTime();
    if (!Number.isFinite(scheduledMs)) continue;
    if (scheduledMs < now - USER_SCHEDULE_LATE_CUTOFF_MS) {
      await new Promise(r => db.run("UPDATE user_schedules SET reminder_sent_at = CURRENT_TIMESTAMP WHERE id = ? AND reminder_sent_at IS NULL", [row.id], () => r()));
      continue;
    }
    const reminderMinutes = Number.isFinite(Number(row.reminder_minutes)) ? Number(row.reminder_minutes) : 30;
    const dueMs = scheduledMs - reminderMinutes * 60 * 1000;
    if (dueMs > now) continue;
    const lockToken = `processing:${Date.now()}:${Math.random()}`;
    const locked = await new Promise(r => db.run("UPDATE user_schedules SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL", [lockToken, row.id], function () { r(this.changes > 0); }));
    if (!locked) continue;
    try {
      const clientIdSet = new Set();
      const clientRows = await new Promise((resolve, reject) => db.all("SELECT us.client_id FROM user_subscriptions us JOIN subscriptions s ON s.client_id = us.client_id WHERE us.user_id = ? AND s.subscription_json IS NOT NULL", [row.user_id], (err, rows) => err ? reject(err) : resolve(rows || [])));
      for (const r of clientRows) { if (r?.client_id) clientIdSet.add(r.client_id); }
      const androidRows = await new Promise((resolve, reject) => db.all("SELECT client_id FROM android_devices WHERE user_id = ?", [row.user_id], (err, rows) => err ? reject(err) : resolve(rows || [])));
      for (const r of androidRows) { if (r?.client_id) clientIdSet.add(r.client_id); }
      const clientId = Array.from(clientIdSet).join(",");
      if (!clientId) {
        await new Promise(r => db.run("UPDATE user_schedules SET reminder_sent_at = NULL WHERE id = ? AND reminder_sent_at = ?", [row.id, lockToken], () => r()));
        continue;
      }
      const payload = { type: "event", settingKey: "schedule", clientId, data: { title: row.title || "マイスケジュール通知", body: row.note || "予定時刻が近づいています。", url: row.url || "/events.html", icon: row.thumbnail_url || "/icon.webp", image: toHttpsThumb(row.thumbnail_url) } };
      const result = await notifier.handleAdminNotify(payload, "user-scheduler");
      if (result?.sentCount > 0) {
        await new Promise(r => db.run("UPDATE user_schedules SET reminder_sent_at = CURRENT_TIMESTAMP WHERE id = ? AND reminder_sent_at = ?", [row.id, lockToken], () => r()));
      } else {
        await new Promise(r => db.run("UPDATE user_schedules SET reminder_sent_at = NULL WHERE id = ? AND reminder_sent_at = ?", [row.id, lockToken], () => r()));
      }
    } catch (e) {
      console.error("[User Schedule Notify] failed id=", row.id, e?.message);
      await new Promise(r => db.run("UPDATE user_schedules SET reminder_sent_at = NULL WHERE id = ? AND reminder_sent_at = ?", [row.id, lockToken], () => r()));
    }
  }
}

// 期限を過ぎた scheduled_notifications を実際に配信する。
// （これが無いと event_pre_* / event_start の予定リマインダーが永久に飛ばない）
const EVENT_NOTIFY_MAX_LATE_MS = 10 * 60 * 1000; // これ以上遅延した分は送らず既読化（スパム防止）
const EVENT_NOTIFY_DISPATCH_INTERVAL_MS = 30 * 1000;

async function dispatchDueEventNotifications() {
  const db = ctx.db;
  const now = Date.now();

  // 遅延しすぎた未送信分は送らずに既読化（再起動直後の過去分一斉送信を防ぐ）
  await new Promise(r => db.run(
    "UPDATE scheduled_notifications SET sent = 1, sent_at = ? WHERE sent = 0 AND run_at < ?",
    [now, now - EVENT_NOTIFY_MAX_LATE_MS], function () { r(); }));

  const due = await new Promise(r => db.all(
    "SELECT id, ref_id, payload_json FROM scheduled_notifications WHERE sent = 0 AND run_at <= ? ORDER BY run_at ASC LIMIT 50",
    [now], (err, rows) => { if (err) console.error("[Event Notify Dispatch] load err:", err.message); r(err ? [] : (rows || [])); }));

  for (const row of due) {
    // 原子的に確保して多重送信を防ぐ
    const claimed = await new Promise(r => db.run(
      "UPDATE scheduled_notifications SET sent = 1, sent_at = ? WHERE id = ? AND sent = 0",
      [Date.now(), row.id], function () { r(this.changes > 0); }));
    if (!claimed) continue;

    let payload;
    try { payload = JSON.parse(row.payload_json); } catch (e) {
      console.error("[Event Notify Dispatch] bad payload id=", row.id);
      continue; // 壊れた行は既読のまま放置（無限リトライ防止）
    }
    // 事前告知（event_pre_*）を送り済みなら、開始通知からアラームを外す。
    // 予定どおりの配信では利用者は既に知っているうえ、開始 15 分前に端末内アラームが
    // 鳴っているため、開始時にもう一度鳴ると二度鳴りになる（2026-10-23 の利用者報告）。
    // 事前告知が無い突然の開始（例: 直前に予定が追加された配信）だけアラームを残す。
    // ※ **送信直前に判定する**（生成時に判定すると、事前告知がまだ未送信の段階で
    //   「事前告知なし＝突然」と誤判定してアラームが付いてしまう）。
    if (payload && payload.data && payload.data.channel === START_ALARM_CHANNEL && row.ref_id) {
      try {
        if (await hasSentPreNoticeForEvent(db, row.ref_id)) delete payload.data.channel;
      } catch (e) {
        console.error("[Event Notify Dispatch] preNotice check failed id=", row.id, e?.message);
      }
    }
    try {
      await notifier.handleAdminNotify(payload, "event-scheduler");
    } catch (e) {
      console.error("[Event Notify Dispatch] send failed id=", row.id, e?.message);
      // 送信失敗は次回再送のため未送信へ戻す
      await new Promise(r => db.run("UPDATE scheduled_notifications SET sent = 0, sent_at = NULL WHERE id = ?", [row.id], () => r()));
    }
  }
}

function startPeriodicTasks() {
  setInterval(updateEventStatuses, 5 * 60 * 1000);
  setTimeout(updateEventStatuses, 5000);

  setInterval(() => { syncEventNotifications().catch(e => console.error("[Event Notify Sync] interval err:", e?.message)); }, EVENT_NOTIFY_SYNC_INTERVAL_MS);
  setTimeout(() => { syncEventNotifications().catch(e => console.error("[Event Notify Sync] startup err:", e?.message)); }, 10 * 1000);

  setInterval(() => { sendUserScheduleReminders().catch(e => console.error("[User Schedule Notify] fatal:", e?.message)); }, 30000);

  setInterval(() => { dispatchDueEventNotifications().catch(e => console.error("[Event Notify Dispatch] fatal:", e?.message)); }, EVENT_NOTIFY_DISPATCH_INTERVAL_MS);
  setTimeout(() => { dispatchDueEventNotifications().catch(e => console.error("[Event Notify Dispatch] startup err:", e?.message)); }, 15 * 1000);
}

module.exports = { updateEventStatuses, syncEventNotifications, dispatchDueEventNotifications, sendUserScheduleReminders, buildEventNotificationPayload, toLocalDateString, formatLocalDate, getWeekBoundsByDate, startPeriodicTasks, EVENT_PRE_OFFSETS_MS, EVENT_NOTIFY_GRACE_MS, EVENT_NOTIFY_LOOKAHEAD_DAYS };
