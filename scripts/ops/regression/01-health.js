"use strict";
// 回帰テスト [1]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 1,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 1. 起動と /api/health ---
    console.log("[1] /api/health");
    const health = await waitForHealth(child);
    ok("health 200 + status:ok", health.status === 200 && health.json && health.json.status === "ok");
  },
};
