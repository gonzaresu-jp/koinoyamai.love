#!/usr/bin/env node
/**
 * sqlite3@6 昇格前の回帰テスト（SECURITY_HANDOFF / AGENTS.md 手順に基づく）
 *
 * 使い方:
 *   node scripts/ops/regression-test.js [--port 18099]
 *
 * やること:
 *   - 一時DBを自動生成して server.js を子プロセス起動（DISABLE_NOTIFICATIONS=1 / NODE_ENV=development）
 *   - /api/health, /api/notify の認証(401/401/HMAC inconsistent 401/タイムスタンプなし401/期限切れ401/suppressed), 内部scraper-status認証,
 *     /auth/token-exchange 無効code 400, SSE接続上限, sqlite3 の INSERT/SELECT/lastID を検証
 *   - 終了時に一時DBを削除
 *
 * 注意: 本番(8080)では実行しない。staging(8081)側の作業ツリー、またはローカルで実行すること。
 *       実pushは DISABLE_NOTIFICATIONS=1 で完全抑止される（suppressed:true を検証）。
 */
"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const REQUESTED_PORT = portIdx >= 0 ? Number(args[portIdx + 1]) || 18099 : 0;
// 固定ポート 18099 は同時実行（CI と手動、pre-push と手動など）で衝突して
// テストが不安定になる（2026-10-21 実測: pre-push が flake で落ちた）。
// 明示指定がないときは空きポートを採る。
let PORT = REQUESTED_PORT || 18099;
let BASE = `http://127.0.0.1:${PORT}`;

// ---- 本番 Leak ガード ----
// 本番(8080) の .env は DISABLE_NOTIFICATIONS=0 であり、通知抑止が効かない。
// 誤って本番に対して --port 8080 を指定して実行すると、[2] の完全認証ケースで
// 実ユーザー全員にテスト通知が届いてしまう。それを機械的に防ぐ。
const PROD_PORTS = [8080];
if (REQUESTED_PORT && PROD_PORTS.includes(REQUESTED_PORT)) {
  console.error("╔════════════════════════════════════════════════════════╗");
  console.error("║ ✗ 本番ポートが検査対象に指定されています                                 ║");
  console.error("║   本番(8080) は DISABLE_NOTIFICATIONS=0 のため、             ║");
  console.error("║   このテストの通知が実ユーザーへ実送されます。                              ║");
  console.error("║   実行を中止します。staging(8081) または                          ║");
  console.error("║   ローカル(既定 18099) を使用してください。                           ║");
  console.error("╚════════════════════════════════════════════════════════╝");
  process.exit(2);
}

const TOKEN = "regression-test-token-" + crypto.randomBytes(8).toString("hex");
const HMAC_SECRET = "regression-test-hmac-" + crypto.randomBytes(8).toString("hex");
// 同じミリ秒に2つ起動されると名前が被り、一時DBを共有して flaky になる
// （2026-10-21 実測: 同時実行で通知テーブルの SELECT が4行返って失敗）。
// PID と乱数片を混ぜて一意にする。
const DB_NAME = `regression-test-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`;

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function hmacOf(bodyString, ts) {
  const t = String(ts != null ? ts : Math.floor(Date.now() / 1000));
  return { hmac: crypto.createHmac("sha256", HMAC_SECRET).update(t + "." + bodyString).digest("hex"), ts: t };
}

function request(method, urlPath, { headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(
      `${BASE}${urlPath}`,
      {
        method,
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on("timeout", () => { req.destroy(new Error("client timeout")); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function openSse() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}/api/events/stream`, { headers: { Accept: "text/event-stream" } }, (res) => {
      resolve({ req, res, status: res.statusCode, headers: res.headers });
    });
    req.on("error", reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 空きポートを1つ確保して返す（テストのlisten衝突を避ける） */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const net = require("net");
        const srv = net.createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (e) { e ? reject(e) : resolve(this); }));
}

async function waitForHealth(child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("server exited early: code=" + child.exitCode);
    try {
      const r = await request("GET", "/api/health", { timeoutMs: 1500 });
      if (r.status === 200) return r;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error("server did not become healthy");
}

async function main() {
  const projectDir = path.resolve(__dirname, "../..");
  if (!REQUESTED_PORT) {
    PORT = await findFreePort();
    BASE = `http://127.0.0.1:${PORT}`;
    console.log(`[regression-test] 使用ポート: ${PORT}（空きポートを自動確保）`);
  }
  const dbPath = path.join(projectDir, DB_NAME);
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
  }

  const child = spawn(process.execPath, [path.join(projectDir, "server.js")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "development",
      DISABLE_NOTIFICATIONS: "1",
      DB_FILE_NAME: DB_NAME,
      // lib/admin.js は ADMIN_DB_PATH が無ければ作業ツリーの data.db を開いてしまう
      // （回帰テストのたびに tree に data.db を作っていた）
      ADMIN_DB_PATH: dbPath,
      NOTIFY_API_TOKEN: TOKEN,
      NOTIFY_HMAC_SECRET: HMAC_SECRET,
      SSE_MAX_PER_CLIENT: "5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  child.stdout.on("data", (d) => serverLog.push(d.toString()));
  child.stderr.on("data", (d) => serverLog.push(d.toString()));

  let sseHandles = [];
  try {
    // --- 1. 起動と /api/health ---
    console.log("[1] /api/health");
    const health = await waitForHealth(child);
    ok("health 200 + status:ok", health.status === 200 && health.json && health.json.status === "ok");

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

    // --- 4. OAuth: token-exchange 無効code ---
    console.log("[4] /auth/token-exchange");
    const badCode = await request("POST", "/auth/token-exchange", { body: JSON.stringify({ code: "definitely-invalid-code" }) });
    ok("無効code -> 400", badCode.status === 400, `got ${badCode.status}`);
    const noCode = await request("POST", "/auth/token-exchange", { body: JSON.stringify({}) });
    ok("codeなし -> 400", noCode.status === 400, `got ${noCode.status}`);

    // --- 5. SSE 保護（同一クライアント上限・event-stream 応答） ---
    console.log("[5] SSE");
    const first = await openSse();
    ok("SSE 200 + text/event-stream", first.status === 200 && String(first.headers["content-type"] || "").startsWith("text/event-stream"));
    sseHandles.push(first);
    for (let i = 0; i < 4; i++) sseHandles.push(await openSse());
    await sleep(300);
    const sixth = await openSse();
    ok("同一クライアント 6接続目 -> 429", sixth.status === 429, `got ${sixth.status}`);
    sixth.res.destroy();
    // 1接続閉じれば再び受け入れられる
    sseHandles[0].res.destroy();
    sseHandles = sseHandles.slice(1);
    await sleep(500);
    const reopen = await openSse();
    ok("切断後の再接続 -> 200", reopen.status === 200, `got ${reopen.status}`);
    sseHandles.push(reopen);

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
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(driverDbPath + suffix); } catch (_) {}
    }

    // --- 7. YouTube フィード補助ロジック（RSS / Data API 代替ソース） ---
    // src/core/youtube-feed.js はネットワーク・DB 非依存の純粋モジュールなので
    // require しても副作用がない（src/scrapers/youtube.js は require すると
    // weekly → services/context 経由で data.db を開いてしまうため	require しない）
    console.log("[7] YouTube feed helpers");
    const feed = require(path.join(projectDir, "src", "core", "youtube-feed.js"));
    ok("deriveUploadsPlaylistId", feed.deriveUploadsPlaylistId("UCgttI8QfdWhvd3SRtCYcJzw") === "UUgttI8QfdWhvd3SRtCYcJzw",
        feed.deriveUploadsPlaylistId("UCgttI8QfdWhvd3SRtCYcJzw"));
    ok("deriveUploadsPlaylistId (空値)", feed.deriveUploadsPlaylistId("") === null);

    const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <entry><id>yt:video:VID001</id><yt:videoId>VID001</yt:videoId><yt:channelId>UCgttI8QfdWhvd3SRtCYcJzw</yt:channelId>
    <title>テスト配信A</title><published>2026-10-20T08:49:41+00:00</published></entry>
  <entry><id>yt:video:VID002</id><yt:videoId>VID002</yt:videoId>
    <title>テスト配信B</title><published>2026-10-20T09:00:00+00:00</published></entry>
</feed>`;
    const rssItems = await feed.parseRssEntries(RSS_XML, 15);
    ok("parseRssEntries (videoId/published/title)",
        rssItems.length === 2 && rssItems[0].videoId === "VID001" &&
        rssItems[0].published === "2026-10-20T08:49:41+00:00" && rssItems[0].title === "テスト配信A",
        JSON.stringify(rssItems[0]));
    ok("parseRssEntries (maxItems)", (await feed.parseRssEntries(RSS_XML, 1)).length === 1);

    const PLAYLIST_JSON = {
        items: [
            {
                snippet: { publishedAt: "2026-10-20T08:49:41Z", title: "テスト配信A", resourceId: { videoId: "VID001" } },
                contentDetails: { videoPublishedDate: "2026-10-20T08:49:41Z" }
            },
            {
                snippet: { publishedAt: "2026-10-20T09:00:00Z", title: "テスト配信B", resourceId: { videoId: "VID002" } },
                contentDetails: {}
            }
        ]
    };
    const plItems = feed.parsePlaylistItems(PLAYLIST_JSON, 15);
    ok("parsePlaylistItems (RSS と同じ形)",
        plItems.length === 2 && plItems[0].videoId === "VID001" && plItems[0].title === "テスト配信A" &&
        plItems[1].videoId === "VID002" && typeof plItems[0].published === "string",
        JSON.stringify(plItems[0]));
    ok("parsePlaylistItems (空レスポンス)", feed.parsePlaylistItems({}, 15).length === 0);

    // RSS とプレイリストの動画IDが一致すること（＝代替ソースが主経路と等価であることの前提）
    const rssIds = rssItems.map((x) => x.videoId).sort().join(",");
    const plIds = plItems.map((x) => x.videoId).sort().join(",");
    ok("RSS とプレイリストの videoId 一致", rssIds === plIds, `${rssIds} vs ${plIds}`);

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

    console.log(`\n結果: ${passed} passed, ${failed} failed`);
  } catch (e) {
    failed++;
    console.error("\n[regression-test] 例外:", e && e.message ? e.message : e);
  } finally {
    for (const h of sseHandles) { try { h.res.destroy(); } catch (_) {} }
    child.kill("SIGTERM");
    await sleep(300);
    if (child.exitCode === null) child.kill("SIGKILL");
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
    }
    // 一時DB名から導出された履歴JSON（services/context.js の HISTORY_JSON_PATH）も削除する。
    // 残すと毎回 webui/history-regression-test-<ts>.json が溜まる。
    try {
      const histBase = path.basename(DB_NAME, path.extname(DB_NAME));
      fs.unlinkSync(path.join(projectDir, "webui", `history-${histBase}.json`));
    } catch (_) {}
    if (failed > 0) {
      console.error("\n--- server log (tail) ---");
      console.error(serverLog.join("").split("\n").slice(-40).join("\n"));
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
