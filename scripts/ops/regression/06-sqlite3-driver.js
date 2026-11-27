"use strict";
// 回帰テスト [6]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

module.exports = {
  id: 6,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 6. sqlite3 ドライバ直叩き（昇格時の主要回帰ポイント） ---
    // サーバが稼働している同じ DB に書くと
    // ・サーバ側の書き込みとロックが競合して SQLITE_BUSY（サーバが uncaught で落ちる）
    // ・テスト側の接続に busy_timeout が無いため即失敗する
    // といった不安定要因になるので、ドライバ確認は**別の一時DB**で行う。
    console.log("[6] sqlite3 INSERT/SELECT/lastID");
    const driverDbPath = path.join(projectDir, `regression-driver-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
    const db = new sqlite3.Database(driverDbPath);
    await dbRun(db, "PRAGMA busy_timeout = 5000");
    // 検証で触る3テーブルの最小スキーマ（サーバのスキーマとは独立に持つ）
    await dbRun(db, `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, url TEXT, icon TEXT,
      platform TEXT, status TEXT DEFAULT 'success', tweet_id TEXT, image TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, data TEXT)`);
    await dbRun(db, `CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, client_id TEXT NOT NULL UNIQUE,
      endpoint TEXT NOT NULL UNIQUE, subscription_json TEXT, settings_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await dbRun(db, `CREATE TABLE IF NOT EXISTS scraper_status (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, message TEXT, last_run TEXT, updated_at TEXT)`);
    const ins1 = await dbRun(db, "INSERT INTO notifications (title, body, url, platform, status) VALUES (?, ?, ?, ?, ?)", ["reg-t1", "b1", "https://example.com", "reg-test", "success"]);
    ok("notifications lastID", Number.isInteger(ins1.lastID) && ins1.lastID > 0, `lastID=${ins1.lastID}`);
    await dbRun(db, "INSERT INTO notifications (title, body, platform, status) VALUES (?, ?, ?, ?)", ["reg-t2", "b2", "reg-test", "success"]);
    const rows = await dbAll(db, "SELECT id, title FROM notifications WHERE title IN (?, ?) ORDER BY id", ["reg-t1", "reg-t2"]);
    ok("notifications SELECT", rows.length === 2 && rows[0].title === "reg-t1" && rows[1].title === "reg-t2", JSON.stringify(rows));
    const ins2 = await dbRun(db, "INSERT INTO subscriptions (client_id, endpoint, subscription_json, settings_json) VALUES (?, ?, ?, ?)", ["reg-client-1", "https://reg.example/push/1", JSON.stringify({ endpoint: "https://reg.example/push/1" }), "{}"]);
    ok("subscriptions lastID", Number.isInteger(ins2.lastID) && ins2.lastID > 0, `lastID=${ins2.lastID}`);
    const subs = await dbAll(db, "SELECT client_id, subscription_json FROM subscriptions WHERE client_id = ?", ["reg-client-1"]);
    ok("subscriptions SELECT + JSON roundtrip", subs.length === 1 && JSON.parse(subs[0].subscription_json).endpoint === "https://reg.example/push/1");
    await dbRun(db, "INSERT INTO scraper_status (id, name, status, message, last_run, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", ["reg-scraper", "reg", "success", "ok", new Date().toISOString(), new Date().toISOString()]);
    const scraper = await dbAll(db, "SELECT * FROM scraper_status WHERE id = ?", ["reg-scraper"]);
    ok("scraper_status UPSERT + SELECT", scraper.length === 1 && scraper[0].status === "success");
    await new Promise((resolve) => db.close(() => resolve()));
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(driverDbPath + suffix); } catch (_) {}
    }
  },
};
