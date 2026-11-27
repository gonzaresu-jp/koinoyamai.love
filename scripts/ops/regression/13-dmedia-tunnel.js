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
    //  - 旧 apply-dmedia-tunnel-only.js は scripts/archive/nginx-apply/ へ退避済み。
    //    パッチの冪等性・fail-closed の代わりに、適用結果がテンプレートに
    //    固定されていることと、生成系（render.sh）の fail-closed を固定する
    //  - upload サービスは /dmedia の Host を照合する（LAN vhost のパス置換による迂回防止）
    console.log("[13] Discord 専用メディアの tunnel 限定");
    const discordTmpl = fs.readFileSync(path.join(projectDir, "scripts", "nginx", "templates", "discord.conf.tmpl"), "utf8");
    const dmediaBlock = discordTmpl.slice(
      discordTmpl.indexOf("location ^~ /dmedia/"), discordTmpl.indexOf("location ^~ /watch/"));
    ok("nginx テンプレート（discord）: /dmedia/ は allow 127.0.0.1 / allow ::1 / deny all で tunnel 限定",
      /allow 127\.0\.0\.1;/.test(dmediaBlock) && /allow ::1;/.test(dmediaBlock) && /deny\s+all;/.test(dmediaBlock));
    ok("nginx テンプレート（discord）: /dmedia/ の Discordbot UA 判定も残っている",
      /if \(\$http_user_agent !~\* "Discordbot"\) \{ return 403; \}/.test(dmediaBlock));
    const renderSh = fs.readFileSync(path.join(projectDir, "scripts", "nginx", "render.sh"), "utf8");
    ok("render.sh: 秘密値が未設定なら fail-closed で、/etc/nginx への出力も拒否する",
      /TAILNET_ADMIN_SECRET/.test(renderSh) && /exit 1/.test(renderSh) &&
      /\/etc\/nginx/.test(renderSh));
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
