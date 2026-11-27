"use strict";
// 回帰テスト [4]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 4,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 4. OAuth: token-exchange 無効code ---
    console.log("[4] /auth/token-exchange");
    const badCode = await request("POST", "/auth/token-exchange", { body: JSON.stringify({ code: "definitely-invalid-code" }) });
    ok("無効code -> 400", badCode.status === 400, `got ${badCode.status}`);
    const noCode = await request("POST", "/auth/token-exchange", { body: JSON.stringify({}) });
    ok("codeなし -> 400", noCode.status === 400, `got ${noCode.status}`);
  },
};
