"use strict";
// 回帰テスト [8]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 8,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 8. YouTube webhook のトークン検証（公開ルートの保護） ---
    // 公開に晒した以上、トークン無し/不正では必ず 403 になること。
    // このゲートが無かったのが 2026-10-20 に webhook が 18 日死んでいた原因の周辺。
    console.log("[8] YouTube webhook token gate");
    const httpLocal = require("http");
    // src/scrapers/youtube.js は weekly → services/context 経由で DB を開く。
    // 一時DB名（DB_FILE_NAME）を先に設定し、本番 data.db を作らないようにする。
    process.env.DB_FILE_NAME = DB_NAME;
    const webhookMod = require(path.join(projectDir, "src", "scrapers", "youtube.js"));
    const tmpRawLog = path.join(os.tmpdir(), `reg-webhook-${Date.now()}.log`);
    const app = webhookMod.createWebhookApp({ token: "reg-token-abc123", rawLogPath: tmpRawLog });
    // 127.0.0.1 にだけバインドする（テスト中に外部へ公開しない）
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const wPort = server.address().port;
    const wReq = (method, qs, body) => new Promise((resolve) => {
        const req = httpLocal.request(
            { host: "127.0.0.1", port: wPort, method, path: `/youtube-webhook${qs}`, headers: body ? { "Content-Type": "text/plain" } : {} },
            (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }
        );
        if (body) req.write(body);
        req.end();
    });
    ok("GET トークンなし -> 403", (await wReq("GET", "?hub.challenge=TEST")) === 403);
    ok("GET トークン不一致 -> 403", (await wReq("GET", "?hub.challenge=TEST&token=wrong")) === 403);
    ok("GET トークン一致 -> 200", (await wReq("GET", "?hub.challenge=TEST&token=reg-token-abc123")) === 200);
    ok("GET hub.mode=denied -> 200", (await wReq("GET", "?hub.mode=denied&token=reg-token-abc123")) === 200);
    ok("POST トークンなし -> 403", (await wReq("POST", "", "<feed/>")) === 403);
    ok("POST トークン一致 -> 200（entry 不在でも 200）", (await wReq("POST", "?token=reg-token-abc123", "<feed/>")) === 200);
    // トークン未設定（fail-closed）
    const appNoToken = webhookMod.createWebhookApp({ token: "", rawLogPath: tmpRawLog });
    const server2 = await new Promise((resolve) => { const s = appNoToken.listen(0, '127.0.0.1', () => resolve(s)); });
    const p2 = server2.address().port;
    const code2 = await new Promise((resolve) => {
        const req = httpLocal.request({ host: "127.0.0.1", port: p2, method: "GET", path: "/youtube-webhook?hub.challenge=TEST" }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.end();
    });
    ok("トークン未設定 -> 403（fail-closed）", code2 === 403);
    server.close();
    server2.close();
    try { fs.unlinkSync(tmpRawLog); } catch (_) {}
  },
};
