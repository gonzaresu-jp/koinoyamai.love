"use strict";
// 回帰テスト [3]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 3,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 3. 内部 scraper-status 認証（NOTIFY_API_TOKEN 統一） ---
    console.log("[3] /api/internal/scraper-status");
    const sNoToken = await request("POST", "/api/internal/scraper-status", { body: JSON.stringify({ id: "reg-test", name: "reg", status: "success" }) });
    ok("tokenなし -> 401", sNoToken.status === 401, `got ${sNoToken.status}`);
    const sBad = await request("POST", "/api/internal/scraper-status", { body: JSON.stringify({ id: "reg-test" }), headers: { "x-notify-token": "wrong" } });
    ok("誤token -> 401", sBad.status === 401, `got ${sBad.status}`);
    const sOk = await request("POST", "/api/internal/scraper-status", { body: JSON.stringify({ id: "reg-test", name: "reg", status: "success", message: "ok" }), headers: { "x-notify-token": TOKEN } });
    ok("正token -> 200", sOk.status === 200, `got ${sOk.status} ${sOk.raw.slice(0, 120)}`);
    const sList = await request("GET", "/api/scraper-status");
    ok("scraper-status に反映", sList.status === 200 && JSON.stringify(sList.json && sList.json.items || []).includes("reg-test"));
  },
};
