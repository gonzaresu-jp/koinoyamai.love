"use strict";
// 回帰テスト [5]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 5,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 5. SSE 保護（同一クライアント上限・event-stream 応答） ---
    console.log("[5] SSE");
    const first = await openSse();
    ok("SSE 200 + text/event-stream", first.status === 200 && String(first.headers["content-type"] || "").startsWith("text/event-stream"));
    ctx.sseHandles.push(first);
    for (let i = 0; i < 4; i++) ctx.sseHandles.push(await openSse());
    await sleep(300);
    const sixth = await openSse();
    ok("同一クライアント 6接続目 -> 429", sixth.status === 429, `got ${sixth.status}`);
    sixth.res.destroy();
    // 1接続閉じれば再び受け入れられる
    ctx.sseHandles[0].res.destroy();
    ctx.sseHandles = ctx.sseHandles.slice(1);
    await sleep(500);
    const reopen = await openSse();
    ok("切断後の再接続 -> 200", reopen.status === 200, `got ${reopen.status}`);
    ctx.sseHandles.push(reopen);
  },
};
