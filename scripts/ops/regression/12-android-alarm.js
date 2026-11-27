"use strict";
// 回帰テスト [12]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

module.exports = {
  id: 12,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 12. Android 配信アラームの不変条件（2026-10-22 追加） ---
    // 「アラームが短く、止まるまで鳴らない」問題の再発を防ぐ。
    console.log("[12] Android 配信アラームの不変条件");
    const ktDir = path.join(projectDir, "mai_notification", "app", "src", "main", "java", "com", "yuzuki", "mai_notification");
    const readKt = (rel) => {
        try { return fs.readFileSync(path.join(ktDir, rel), "utf8"); } catch (e) { return ""; }
    };
    const alarmServiceKt = readKt("AlarmSoundService.kt");
    const alarmReceiverKt = readKt("AlarmReceiver.kt");
    const fcmKt = readKt(path.join("MainActivity", "MyFirebaseMessagingService.kt"));
    const manifestXml = fs.readFileSync(
      path.join(projectDir, "mai_notification", "app", "src", "main", "AndroidManifest.xml"), "utf8");

    // 12-1. 存在しない API を使わない（NotificationCompat.Builder.setTurnScreenOn は無い＝コンパイルエラー）
    ok("Android: NotificationCompat の setTurnScreenOn を使わない（存在しない API）",
      !/setTurnScreenOn/.test(alarmServiceKt) && !/setTurnScreenOn/.test(fcmKt));
    // 12-2. アラーム音はループ再生
    ok("Android: アラーム音をループ再生する（isLooping = true）",
      /isLooping\s*=\s*true/.test(alarmServiceKt));
    ok("Android: USAGE_ALARM で鳴らす（マナーモードでも鳴る）",
      /AudioAttributes\.USAGE_ALARM/.test(alarmServiceKt));
    // 12-3. フォアグラウンドサービスの宣言と権限
    ok("Android: AlarmSoundService を manifest に宣言している",
      /android:name="\.AlarmSoundService"/.test(manifestXml) &&
      /foregroundServiceType="mediaPlayback"/.test(manifestXml));
    ok("Android: FGS の権限（FOREGROUND_SERVICE / MEDIA_PLAYBACK / VIBRATE）がある",
      /FOREGROUND_SERVICE"/.test(manifestXml) &&
      /FOREGROUND_SERVICE_MEDIA_PLAYBACK/.test(manifestXml) &&
      /VIBRATE/.test(manifestXml));
    // 12-4. full-screen intent で起動したときはアラームを止めない（止めると数秒で止まる）
    ok("Android: full-screen intent 起動ではアラームを止めない（launchedFromAlarm）",
      /EXTRA_FROM_ALARM/.test(alarmServiceKt) &&
      /launchedFromAlarm/.test(readKt(path.join("MainActivity", "MainActivity.kt"))));
    // 12-5. サーバーはアラーム用チャネルを data-only で送る（background で onMessageReceived が呼ばれないとループしない）
    const notifSvc = fs.readFileSync(path.join(projectDir, "services", "notification.js"), "utf8");
    ok("サーバー: アラーム用チャネルの FCM は data-only（notification ブロックなし）",
      /isAlarmChannel/.test(notifSvc) && /isAlarmChannel\s*\?\s*\{\s*\}/.test(notifSvc));
    // 12-6. バージョンの整合（APK 配布は Windows 側・json は APK 配置後）
    const gradleKt = fs.readFileSync(path.join(projectDir, "mai_notification", "app", "build.gradle.kts"), "utf8");
    ok("Android: バージョンが 1.7.4 / versionCode 12",
      /versionName\s*=\s*"1\.7\.4"/.test(gradleKt) && /versionCode\s*=\s*12/.test(gradleKt));

    // 12-7. 配信開始通知のチャネル選択（2026-10-24 追加・アラームの二度鳴り防止）
    // 事前告知（30分前/3分前）を送り済みの配信では、開始通知でアラームを鳴らさない
    // （利用者は既に目を覚ましており、開始 15 分前の端末内アラームと二度鳴りになる）。
    // 事前告知が無い突然の配信だけアラーム用チャネルを使う。
    const notifyChannel = require(path.join(projectDir, "src", "core", "notify-channel.js"));
    ok("サーバー: 事前告知あり → 開始通知は通常チャネル（アラームを付けない）",
      notifyChannel.startNotificationChannel(true) === undefined);
    ok("サーバー: 事前告知なし → 開始通知はアラーム用チャネル",
      notifyChannel.startNotificationChannel(false) === "mai_stream_alarm");
    ok("サーバー: アラーム用チャネル名がアプリ側と一致する",
      notifyChannel.START_ALARM_CHANNEL === "mai_stream_alarm");
    // 検知経路（webhook / RSS フォールバック）で挙動が分かれると
    // 「突然なのに鳴らない」「予定通りなのに二度鳴る」の両方が起きる。
    const ytScraperSrc = fs.readFileSync(path.join(projectDir, "src", "scrapers", "youtube.js"), "utf8");
    const schedulerSrc = fs.readFileSync(path.join(projectDir, "services", "scheduler.js"), "utf8");
    ok("サーバー: ライブ通知の 2 経路（webhook / RSS）が同じ判断関数を使う",
      (ytScraperSrc.match(/startNotificationChannel\(/g) || []).length === 2);
    ok("サーバー: スケジューラは送信直前にアラーム要否を再判定する（生成時だと誤判定）",
      /hasSentPreNoticeForEvent/.test(schedulerSrc) &&
      /payload\.data\.channel === START_ALARM_CHANNEL/.test(schedulerSrc));

    // 12-8. hasSentPreNotice の判定（一時 DB）
    // 直近の実データでは予定が Twitter/Gemma 経由で先に作られ platform='twitter' のまま
    // になることがあるため、platform では絞らず external_id / url で拾えること。
    const preNoticeDbRel = path.join("tmp", `mai-pre-notice-${process.pid}.db`);
    const preNoticeDb = path.join(projectDir, preNoticeDbRel);
    // CI の fresh checkout には tmp/ が無い（gitignore 対象）。作ってから開く
    // （無いと sqlite3 が SQLITE_CANTOPEN でプロセスごと落ちる＝CI 実測）。
    fs.mkdirSync(path.dirname(preNoticeDb), { recursive: true });
    const prevDbFileEnv = process.env.DB_FILE_NAME;
    // weekly/index.js は DB_FILE_NAME を「weekly/ の 1 つ上」に繋げて開く（path.join）。
    // 絶対パスを渡すと projectDir 配下に繋がって別ファイルになるため、相対パスで渡す。
    process.env.DB_FILE_NAME = preNoticeDbRel;
    // ここより前の [8] で src/scrapers/youtube.js → weekly を読み込んでいる（＝require キャッシュに
    // 残っている）。キャッシュを外して読み直さないと、テスト用一時DB ではなく別の DB を見に行く。
    const weeklyPath = require.resolve(path.join(projectDir, "weekly", "index.js"));
    delete require.cache[weeklyPath];
    const weeklyMod = require(weeklyPath);
    // 後続テストへ影響しないよう戻す（undefined のとき `= undefined` は文字列 "undefined" になる）
    if (prevDbFileEnv === undefined) delete process.env.DB_FILE_NAME;
    else process.env.DB_FILE_NAME = prevDbFileEnv;
    // エラーハンドラが無いと「開けない」が unhandled 'error' としてプロセスごと落ちる。
    const pnConn = new sqlite3.Database(preNoticeDb, (openErr) => {
        if (openErr) console.error("[12-8] 一時DB を開けない:", openErr.message);
    });
    pnConn.on("error", (e) => console.error("[12-8] 一時DB error:", e.message));
    try {
        await new Promise((resolve) => pnConn.serialize(() => {
            pnConn.run("CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT, start_time TEXT, url TEXT, platform TEXT, external_id TEXT)");
            pnConn.run("CREATE TABLE scheduled_notifications (id INTEGER PRIMARY KEY, run_at INTEGER, payload_json TEXT, kind TEXT, ref_id INTEGER, sent INTEGER DEFAULT 0, sent_at TEXT)");
            pnConn.run("INSERT INTO events (id, title, start_time, url, platform, external_id) VALUES (1, '配信', '2026-10-23T23:00:00', 'https://www.youtube.com/watch?v=VID000000001', 'twitter', 'VID000000001')");
            pnConn.run("INSERT INTO scheduled_notifications (run_at, payload_json, kind, ref_id, sent) VALUES (1, '{}', 'event_pre_180000', 1, 1)", () => resolve());
        }));
        ok("hasSentPreNotice: 事前告知済みの videoId は true（platform が twitter でも拾える）",
            (await weeklyMod.hasSentPreNotice("VID000000001")) === true);
        ok("hasSentPreNotice: 事前告知が無い videoId は false（＝アラーム側に倒す）",
            (await weeklyMod.hasSentPreNotice("VID000000002")) === false);
        ok("hasSentPreNotice: 未送信（sent=0）の事前告知は数えない",
            await new Promise((resolve) => {
                pnConn.run("UPDATE scheduled_notifications SET sent = 0", () => {
                    weeklyMod.hasSentPreNotice("VID000000001").then((v) => resolve(v === false));
                });
            }));
    } finally {
        await new Promise((resolve) => pnConn.close(() => resolve()));
        for (const suffix of ["", "-wal", "-shm"]) {
            try { fs.rmSync(preNoticeDb + suffix, { force: true }); } catch (e) { /* best-effort */ }
        }
    }

    // 12-9. アラーム用チャネル名を定数で統一する（定数とリテラルがずれると、
    // dispatch の再判定が常に false になり「二度鳴り」が無音で復帰する）。
    const schedulerSrc2 = fs.readFileSync(path.join(projectDir, "services", "scheduler.js"), "utf8");
    const notifSrc2 = fs.readFileSync(path.join(projectDir, "services", "notification.js"), "utf8");
    const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    ok("サーバー: 生成・再判定・FCM 分岐が START_ALARM_CHANNEL を使う（コードにリテラルを残さない）",
        /channel: START_ALARM_CHANNEL/.test(schedulerSrc2) &&
        /data\.channel === START_ALARM_CHANNEL/.test(notifSrc2) &&
        !/mai_stream_alarm/.test(stripComments(schedulerSrc2)) &&
        !/mai_stream_alarm/.test(stripComments(notifSrc2)));
  },
};
