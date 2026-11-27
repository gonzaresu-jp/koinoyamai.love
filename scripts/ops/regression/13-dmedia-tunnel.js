"use strict";
// 回帰テスト [13]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 13,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 13. Discord 専用メディア（/dmedia/）の tunnel 限定（2026-10-22 追加） ---
    // 「UA 判定だけで守っている」状態へ戻らないことを固定する。
    //  - nginx 側は cloudflared（127.0.0.1）経由のみ許可する
    //  - 2 回適用しても差分ゼロ（冪等）
    //  - アンカーが 0 件/複数件なら fail-closed（出力ファイルを作らない）
    //  - upload サービスは /dmedia の Host を照合する（LAN vhost のパス置換による迂回防止）
    console.log("[13] Discord 専用メディアの tunnel 限定");
    const dmediaJs = path.join(projectDir, "scripts", "nginx", "apply-dmedia-tunnel-only.js");
    const dmediaSh = path.join(projectDir, "scripts", "nginx", "apply-dmedia-tunnel-only.sh");
    const dmFixture = [
      "server {",
      "    listen 80;",
      "    server_name discord.honna-yuzuki.com;",
      "",
      "    location ^~ /dmedia/ {",
      "        if ($http_user_agent !~* \"Discordbot\") { return 403; }",
      "        proxy_pass http://127.0.0.1:3100/dmedia/;",
      "    }",
      "",
      "    location / { return 404; }",
      "}",
      "",
    ].join("\n");
    const dmTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dmedia-idem-"));
    const dmIn = path.join(dmTmp, "discord.conf");
    const dmA = path.join(dmTmp, "a.conf");
    const dmB = path.join(dmTmp, "b.conf");
    fs.writeFileSync(dmIn, dmFixture);
    const dmNode = process.execPath;
    const dmRun1 = require("child_process").spawnSync(dmNode, [dmediaJs, dmIn, dmA], { encoding: "utf8" });
    const dmRun2 = require("child_process").spawnSync(dmNode, [dmediaJs, dmA, dmB], { encoding: "utf8" });
    let dmIdem = false;
    let dmAllow = false;
    try {
      dmIdem = dmRun1.status === 0 && dmRun2.status === 0 &&
        fs.readFileSync(dmA, "utf8") === fs.readFileSync(dmB, "utf8");
      const dmText = fs.readFileSync(dmA, "utf8");
      dmAllow = /allow 127\.0\.0\.1;/.test(dmText) && /allow ::1;/.test(dmText) && /deny\s+all;/.test(dmText);
    } catch (e) { dmIdem = false; }
    ok("apply-dmedia-tunnel-only.js: allow 127.0.0.1 / allow ::1 / deny all を挿入する", dmAllow);
    ok("apply-dmedia-tunnel-only.js: 2 回適用しても差分ゼロ（冪等）", dmIdem,
      `run1=${dmRun1.status} run2=${dmRun2.status} ${(dmRun1.stderr || "").slice(0, 120)}`);
    // fail-closed: アンカーが 0 件 / 複数件なら exit 1 かつ出力ファイルを作らない
    let dmFailClosed = true;
    for (const [tag, body] of [
      ["0件", "server {\n    listen 80;\n}\n"],
      ["複数件", dmFixture + "\n" + dmFixture],
    ]) {
      const inF = path.join(dmTmp, `f-${tag}.conf`);
      const outF = path.join(dmTmp, `f-${tag}.out`);
      fs.writeFileSync(inF, body);
      const r = require("child_process").spawnSync(dmNode, [dmediaJs, inF, outF], { encoding: "utf8" });
      if (r.status === 0 || fs.existsSync(outF)) dmFailClosed = false;
    }
    ok("apply-dmedia-tunnel-only.js: アンカーが 0 件/複数件なら fail-closed（出力を作らない）", dmFailClosed);
    try { fs.rmSync(dmTmp, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    // upload サービス側: /dmedia の Host 照合（LAN vhost のパス置換による迂回防止）
    // ※ upload サービスは **リポジトリ外**（/var/www/html/upload）のため
    //   GitHub Actions ランナーには存在しない。存在しない環境ではスキップする
    //   （CI で「不在 = 失敗」になると，皆読で回らない）。
    const uploadServer = "/var/www/html/upload/server.js";
    let uploadSrc = null;
    try { uploadSrc = fs.readFileSync(uploadServer, "utf8"); } catch (e) { uploadSrc = null; }
    if (uploadSrc === null) {
      ok("upload サービス: /dmedia で Host を照合する（LAN 経由の迂回防止）※CI では対象不在のためスキップ", true,
        `not found: ${uploadServer}`);
      ok("upload サービス: scope=discord の ID が 128bit（16 バイト）※CI では対象不在のためスキップ", true,
        `not found: ${uploadServer}`);
    } else {
      // 2026-11-07 の upload サービス改修で Host 照合が `isDiscordHost(req)` ヘルパーへ
      // 切り出された（ヘルパー内で `req.headers.host` を読む）。直接参照とヘルパー経由の
      // どちらでも「/dmedia が Host を見ている」ことを検査する。
      const dmediaDirect = /app\.use\("\/dmedia",[\s\S]{0,400}?req\.headers\.host/.test(uploadSrc);
      const dmediaViaHelper =
        /app\.use\("\/dmedia",[\s\S]{0,400}?isDiscordHost\(req\)/.test(uploadSrc) &&
        /function\s+isDiscordHost\([\s\S]{0,400}?req\.headers\.host/.test(uploadSrc);
      ok("upload サービス: /dmedia で Host を照合する（LAN 経由の迂回防止）",
        dmediaDirect || dmediaViaHelper);
      ok("upload サービス: scope=discord の ID が 128bit（16 バイト）",
        /req\.query\.scope\s*===\s*"discord"\s*\?\s*16\s*:\s*4/.test(uploadSrc));
    }
  },
};
