"use strict";
// 回帰テスト [2]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 2,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 2. /api/notify 認証経路 ---
    console.log("[2] /api/notify auth");
    const body = JSON.stringify({ type: "live", settingKey: "twitcasting", data: { title: "回帰テスト", body: " suppressed 期待" } });
    const noToken = await request("POST", "/api/notify", { body });
    ok("tokenなし -> 401", noToken.status === 401, `got ${noToken.status}`);
    const noHmac = await request("POST", "/api/notify", { body, headers: { "x-notify-token": TOKEN } });
    ok("HMACなし -> 401", noHmac.status === 401, `got ${noHmac.status}`);
    const badHmac = await request("POST", "/api/notify", {
      body, headers: { "x-notify-token": TOKEN, "x-notify-hmac": "0".repeat(64), "x-notify-timestamp": String(Math.floor(Date.now() / 1000)) },
    });
    ok("誤HMAC -> 401", badHmac.status === 401, `got ${badHmac.status}`);
    const noTs = await request("POST", "/api/notify", {
      body, headers: { "x-notify-token": TOKEN, "x-notify-hmac": hmacOf(body).hmac },
    });
    ok("タイムスタンプなし -> 401", noTs.status === 401, `got ${noTs.status}`);
    const oldTs = hmacOf(body, Math.floor(Date.now() / 1000) - 600);
    const expired = await request("POST", "/api/notify", {
      body, headers: { "x-notify-token": TOKEN, "x-notify-hmac": oldTs.hmac, "x-notify-timestamp": oldTs.ts },
    });
    ok("期限切れタイムスタンプ -> 401", expired.status === 401, `got ${expired.status}`);
    const sig = hmacOf(body);
    const good = await request("POST", "/api/notify", {
      body, headers: { "x-notify-token": TOKEN, "x-notify-hmac": sig.hmac, "x-notify-timestamp": sig.ts },
    });
    ok("完全認証 -> 200 & suppressed:true (DISABLE_NOTIFICATIONS)", good.status === 200 && good.json && good.json.suppressed === true, `got ${good.status} ${good.raw.slice(0, 120)}`);
  },
};
