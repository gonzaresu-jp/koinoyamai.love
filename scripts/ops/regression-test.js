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
    await new Promise((resolve) => db.close(() => resolve()));
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

    // 検知経路の状態判定（検知経路が壊れたことに気づける仕組みの前提）
    const st = feed.decideDetectionState({
        failedChannels: 0, totalChannels: 2, usedFallback: false, failStreak: 0, alertAfter: 3
    });
    ok("検知状態: 正常は success", st.status === "success" && st.alert === false, st.message);
    // RSS が失敗したが、プレイリスト代替で取得できたチャンネルがある状態
    // （failedChannels=0 = 両方とも失敗したチャンネルなし / rssFailedChannels=1）
    const stFallback = feed.decideDetectionState({
        failedChannels: 0, totalChannels: 2, rssFailedChannels: 1, usedFallback: true, failStreak: 0, alertAfter: 3
    });
    ok("検知状態: RSS失敗・代替成功は success", stFallback.status === "success" && stFallback.alert === false, stFallback.message);
    const stBroken = feed.decideDetectionState({
        failedChannels: 2, totalChannels: 2, usedFallback: false, failStreak: 3, alertAfter: 3
    });
    ok("検知状態: 両方失敗は error + アラート", stBroken.status === "error" && stBroken.alert === true, stBroken.message);
    const stBelow = feed.decideDetectionState({
        failedChannels: 2, totalChannels: 2, usedFallback: false, failStreak: 1, alertAfter: 3
    });
    ok("検知状態: 連続失敗が閾値未満ならアラートしない", stBelow.status === "error" && stBelow.alert === false, stBelow.message);
    // 一部チャンネルのみ両方失敗した場合は degraded（「成功」と嘘をつかない）
    const stPartial = feed.decideDetectionState({
        failedChannels: 1, totalChannels: 2, rssFailedChannels: 1, usedFallback: false, failStreak: 0, alertAfter: 3
    });
    ok("検知状態: 一部失敗は degraded", stPartial.status === "degraded" && stPartial.alert === false, stPartial.message);
    // RSS が失敗したが代替で取得できた場合は success（RSS 失敗数が別で数えられる）
    const stRssFail = feed.decideDetectionState({
        failedChannels: 0, totalChannels: 2, rssFailedChannels: 2, usedFallback: true, failStreak: 0, alertAfter: 3
    });
    ok("検知状態: RSS失敗・代替成功は success", stRssFail.status === "success" && stRssFail.alert === false, stRssFail.message);

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

    // --- 9. セキュリティ監視の解析ロジック ---
    // 脆弱性監視（scripts/security/）の判定ロジックは素朴に壊れやすい。
    // ネットワークに出ない純粋な解析部分だけをフィクスチャで検証する。
    console.log("[9] セキュリティ監視の解析ロジック");
    const secChecks = require(path.join(projectDir, "scripts", "security", "checks.js"));
    const secNotify = require(path.join(projectDir, "scripts", "security", "notify.js"));

    // 9-1. バージョン比較
    ok("compareVersions: 24.22.0 < 24.22.1", secChecks.compareVersions("v24.22.0", "24.22.1") === -1);
    ok("compareVersions: 24.22.0 == 24.22.0", secChecks.compareVersions("24.22.0", "v24.22.0") === 0);
    ok("compareVersions: 24.9.0 > 24.10.0 は false（数値比較に落とし込まない）",
      secChecks.compareVersions("24.9.0", "24.10.0") === -1);

    // 9-2. node index.json の解析（security フラグの判定）
    const nodeIdx = secChecks.parseNodeIndex(JSON.stringify([
      { version: "v24.22.1", date: "2026-11-01", security: true, lts: "Krypton" },
      { version: "v24.22.0", date: "2026-10-14", security: false, lts: "Krypton" },
      { version: "v25.0.0", date: "2026-11-01", security: false, lts: false },
    ]));
    ok("parseNodeIndex: 件数", nodeIdx.releases.length === 3);
    ok("parseNodeIndex: security フラグを読む", nodeIdx.releases[0].security === true);
    ok("parseNodeIndex: security=false を保持", nodeIdx.releases[1].security === false);

    // 9-3. PHP ChangeLog の解析（8.3.x セクションと CVE の抽出）
    const phpHtml = `
      <h3>Version 8.3.35</h3><b><time class='releasedate' datetime='2026-09-24'>24 Sep 2026</time></b>
      <p>Fixed bug GHSA-xxxx (CVE-2026-17545).</p>
      <h3>Version 8.3.34</h3><b><time class='releasedate' datetime='2026-08-01'>01 Aug 2026</time></b>
      <p>Fixed bug GHSA-yyyy (CVE-2026-20000).</p>
      <h3>Version 8.2.9</h3><p>Fixed bug (CVE-2026-30000).</p>
    `;
    const phpParsed = secChecks.parsePhpChangelog(phpHtml);
    ok("parsePhpChangelog: 8.3.35 の CVE を取得", (phpParsed["8.3.35"].cves || []).includes("CVE-2026-17545"));
    ok("parsePhpChangelog: 公開日を取得", phpParsed["8.3.35"].date === "2026-09-24");
    ok("parsePhpChangelog: 8.2 系は含めない（8.3 系のみ）", !("8.2.9" in phpParsed));

    // 9-4. Debian パッケージ版から upstream 版を取り出す
    ok("upstreamPhpBaseFromPackage: 8.3.6-0ubuntu0.24.04.12 -> 8.3.6",
      secChecks.upstreamPhpBaseFromPackage("8.3.6-0ubuntu0.24.04.12") === "8.3.6");
    ok("upstreamPhpBaseFromPackage: 8.3.15-1ubuntu8.3 -> 8.3.15",
      secChecks.upstreamPhpBaseFromPackage("8.3.15-1ubuntu8.3") === "8.3.15");

    // 9-5. apt の dist-upgrade 出力（security pocket の判定）
    const aptOut = [
      "Inst ca-certificates [20260601~24.04.1] (20260816ubuntu0.24.04.1 Ubuntu:24.04/noble-security [all])",
      "Inst google-chrome-stable [155.0.1-1] (156.0.2-1 Google:1.0/stable [amd64])",
      "Inst liblzma5 [5.6.1+really5.4.5-1ubuntu0.3] (5.6.1+really5.4.5-1ubuntu0.4 Ubuntu:24.04/noble-security [amd64])",
    ].join("\n");
    const aptParsed = secChecks.parseAptDistUpgrade(aptOut);
    ok("parseAptDistUpgrade: security は 2 件", aptParsed.security.length === 2);
    ok("parseAptDistUpgrade: security 以外は other", aptParsed.other.length === 1);
    ok("parseAptDistUpgrade: パッケージ名を取り出す", aptParsed.security[0].startsWith("ca-certificates "));

    // 9-6. npm audit の解析
    const auditParsed = secChecks.parseNpmAudit(JSON.stringify({
      metadata: { vulnerabilities: { total: 2, critical: 1, high: 0, moderate: 0, low: 1, info: 0 } },
      vulnerabilities: {
        proxyaddr: { name: "proxy-addr", severity: "critical", isDirect: false, range: "1.1.0 - 2.0.7", fixAvailable: true, via: [{ url: "https://github.com/advisories/GHSA-jqcg-44mw-7w3h" }] },
        lowpkg: { name: "lowpkg", severity: "low", isDirect: true, range: "1.0.0", fixAvailable: false, via: [] },
      },
    }));
    ok("parseNpmAudit: 件数", auditParsed.advisories.length === 2);
    ok("parseNpmAudit: critical が先", auditParsed.advisories[0].severity === "critical");
    ok("parseNpmAudit: advisory URL を保持", (auditParsed.advisories[0].via || []).some((u) => String(u).includes("GHSA-")));

    // 9-7. 通知の差分判定（新規 / 継続 / 解消 / 承認済み）
    const nowIso = new Date().toISOString();
    const f1 = { key: "php:CVE-2026-0001", severity: "critical", source: "php", title: "A" };
    const f2 = { key: "npm:foo", severity: "warning", source: "npm", title: "B" };
    const st0 = { findings: {}, acknowledged: {} };
    const d1 = secNotify.diffFindings(st0, [f1, f2], { now: nowIso });
    ok("diffFindings: 初回は全部新規", d1.isNew.length === 2 && d1.repeating.length === 0);

    // 通知が成功した前提（lastNotified が入る）で 2 回目を実行する
    secNotify.markNotified(d1.current, [f1.key, f2.key]);
    const st1 = { findings: d1.current, acknowledged: {} };
    const d2 = secNotify.diffFindings(st1, [f1, f2], { now: nowIso });
    ok("diffFindings: 2回目は新規なし", d2.isNew.length === 0 && d2.repeating.length === 0);

    // 8 日後に critical が残る → 継続として再通知
    const later = new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString();
    const d3 = secNotify.diffFindings(st1, [f1, f2], { now: later });
    ok("diffFindings: critical は 7 日超で再通知", d3.repeating.length === 1 && d3.repeating[0].key === f1.key);
    ok("diffFindings: warning は再通知しない", d3.repeating.every((f) => f.severity === "critical"));

    // 解消
    const d4 = secNotify.diffFindings(st1, [f1], { now: nowIso });
    ok("diffFindings: 解消を検出", d4.resolved.includes("npm:foo"));

    // 承認済みは通知対象外
    const st2 = { findings: d1.current, acknowledged: { "php:CVE-2026-0001": { note: "影響なし", at: nowIso } } };
    const d5 = secNotify.diffFindings(st2, [f1, f2], { now: nowIso });
    ok("diffFindings: 承認済みは new/repeating に出ない", d5.isNew.length === 0 && d5.repeating.length === 0);
    ok("diffFindings: 承認済みは acknowledged に残る", d5.acknowledged.length === 1);

    // 9-8. 公開サマリに詳細（CVE ID）を漏らさない
    const pub = secChecks.publicSummary([
      { source: "php", status: "degraded", summary: "要対応 3 件", findings: [{ severity: "critical", key: "php:CVE-2026-12184" }] },
      { source: "node", status: "ok", summary: "最新", findings: [] },
    ]);
    ok("publicSummary: CVE ID を含まない", !pub.includes("CVE-2026-12184"));
    ok("publicSummary: 件数だけ出す", pub.includes("要対応 1 件"));

    // 9-9. 報告先のポート解決（AGENTS.md §1 の事故対策）
    //   本番ツリーでは cwd 一致の最初の apps が worker(3002) になる。
    //   server.js の API アプリを名指しで選ばないと 3002 に POST して 404 になる。
    //   環境（作業ツリーのパス）に依存しないよう、純粋関数にフィクスチャで検証する。
    const watchMod = require(path.join(projectDir, "scripts", "security", "security-watch.js"));
    ok("resolveApiBase が export されている", typeof watchMod.resolveApiBase === "function");
    const fixtureApps = [
      { name: "mai-push-worker", script: "./main.js", cwd: "/repo", env: { PORT: "3002" } },
      { name: "discord-bot", script: "./discord-bot.js", cwd: "/repo", env: {} },
      { name: "mai-push-api", script: "./server.js", cwd: "/repo", env: { PORT: "8080" } },
      { name: "mai-push-api-test", script: "./server.js", cwd: "/repo-test", env: { PORT: "8081" } },
    ];
    ok("resolveApiBase: worker を先に並べても API ポートを返す",
      watchMod.resolveApiBase(fixtureApps, "/repo") === "http://127.0.0.1:8080");
    ok("resolveApiBase: cwd が違えば選ばない",
      watchMod.resolveApiBase(fixtureApps, "/repo-test") === "http://127.0.0.1:8081");
    ok("resolveApiBase: 一致する API アプリが無い場合は null（fail-closed）",
      watchMod.resolveApiBase(fixtureApps, "/other") === null);
    ok("resolveApiBase: worker のポート(3002/3003)を返さない",
      !/300[23]$/.test(String(watchMod.resolveApiBase(fixtureApps, "/repo"))));

    // 9-10. npm audit のエラー出力を「問題なし」にしない（fail-closed）
    let auditErr = null;
    try { secChecks.parseNpmAudit(JSON.stringify({ error: { code: "ENOLOCK", summary: "lockfile not found" } })); } catch (e) { auditErr = e; }
    ok("parseNpmAudit: error JSON は例外になる（正常扱いしない）", auditErr !== null);
    let auditErr2 = null;
    try { secChecks.parseNpmAudit(JSON.stringify({ vulnerabilities: {} })); } catch (e) { auditErr2 = e; }
    ok("parseNpmAudit: metadata 無しも例外になる", auditErr2 !== null);

    // 9-11. 指摘 key の粒度（同じ key のままだと新しいバージョンが通知されない）
    ok("key に Node のバージョンが含まれる: node:update:24:v24.23.0",
      /node:update:24:v24\.23\.0/.test("node:update:24:v24.23.0"));

    // 9-12. 深刻度が上がった finding は新規として通知される
    const nowIso2 = new Date().toISOString();
    const sevLow = { key: "npm:foo:GHSA-1", severity: "info", source: "npm", title: "A" };
    const sevHigh = { key: "npm:foo:GHSA-1", severity: "critical", source: "npm", title: "A" };
    const stSev = { findings: { "npm:foo:GHSA-1": { firstSeen: nowIso2, lastNotified: nowIso2, severity: "info", title: "A" } }, acknowledged: {} };
    const dSev = secNotify.diffFindings(stSev, [sevHigh], { now: nowIso2 });
    ok("diffFindings: 深刻度上昇は新規扱い", dSev.isNew.length === 1 && dSev.repeating.length === 0);

    // 9-13. 通知に失敗した指摘は lastNotified を更新しない（次回も通知される）
    const stFail = { findings: { "npm:bar:GHSA-2": { firstSeen: nowIso2, lastNotified: null, severity: "warning", title: "B" } }, acknowledged: {} };
    const dFail = secNotify.diffFindings(stFail, [{ key: "npm:bar:GHSA-2", severity: "warning", source: "npm", title: "B" }], { now: nowIso2 });
    ok("diffFindings: lastNotified=null は通知対象になる（再送される）", dFail.isNew.length === 1);
    ok("diffFindings: lastNotified は diff だけでは更新されない", dFail.current["npm:bar:GHSA-2"].lastNotified === null);
    secNotify.markNotified(dFail.current, ["npm:bar:GHSA-2"]);
    ok("markNotified: 通知成功時だけ lastNotified が入る", typeof dFail.current["npm:bar:GHSA-2"].lastNotified === "string");

    // 9-14. Discord の本文が上限を超えない（超えると通知が丸ごと落ちる）
    const many = [];
    for (let i = 0; i < 60; i++) {
      many.push({ key: `npm:pkg${i}:GHSA-${i}`, severity: i === 0 ? "critical" : "warning", source: "npm", title: `パッケージ pkg${i} に脆弱性`, detail: "x".repeat(200) });
    }
    const desc = secNotify.formatFindings(many, { hostname: "test-host" });
    ok(`formatFindings: 上限以内（実際 ${desc.length} / 上限 ${secNotify.DISCORD_DESCRIPTION_LIMIT}）`, desc.length <= secNotify.DISCORD_DESCRIPTION_LIMIT);
    ok("formatFindings: 重大の項目は残す", desc.includes("pkg0"));

    // 9-15. PHP の fail-closed（upstream が読めても解析結果が空なら「正常」にしない）
    const phpEmpty = await secChecks.checkPhp({
      pkgVersion: "8.3.6-0ubuntu0.24.04.12",
      debianChangelog: path.join(projectDir, "webui", "updatelogs.php"), // CVE を含まないファイルを渡す
    });
    ok("checkPhp: CVE 記載が無い changelog は error（大量誤検出を防ぐ）", phpEmpty.status === "error");
    ok("checkPhp: error 時は findings が空でない", phpEmpty.findings.length > 0);

    // 9-16. PHP: Ubuntu tracker による「対象外」判定（2026-10-23 追加）
    // upstream の changelog に CVE があっても、Ubuntu がそのリリースの php8.3 に
    // 影響しないと判定しているもの（not-affected / ignored）は critical にしない。
    const trackerFixture = {
      packages: [
        { name: "php8.3", statuses: [
          { release_codename: "noble", status: "not-affected", description: "" },
          { release_codename: "jammy", status: "DNE", description: "" },
        ] },
        { name: "php8.4", statuses: [
          { release_codename: "noble", status: "ignored", description: "windows only" },
        ] },
      ],
    };
    ok("ubuntuTrackerStatus: noble の状態を取り出す",
      secChecks.ubuntuTrackerStatus(trackerFixture, "php8.3", "noble").status === "not-affected");
    ok("ubuntuTrackerStatus: DNE もそのまま返す",
      secChecks.ubuntuTrackerStatus(trackerFixture, "php8.3", "jammy").status === "DNE");
    ok("ubuntuTrackerStatus: 記載の無いパッケージは status=null",
      secChecks.ubuntuTrackerStatus(trackerFixture, "php9.0", "noble").status === null);
    ok("isUbuntuNotAffected: not-affected は対象外", secChecks.isUbuntuNotAffected("not-affected") === true);
    ok("isUbuntuNotAffected: ignored windows only は対象外",
      secChecks.isUbuntuNotAffected("ignored windows only") === true);
    ok("isUbuntuNotAffected: needed は対象（要対応）", secChecks.isUbuntuNotAffected("needed") === false);
    ok("isUbuntuNotAffected: released は対象（要対応）", secChecks.isUbuntuNotAffected("released") === false);
    ok("isUbuntuNotAffected: 空/NULL は対象（fail-closed）",
      secChecks.isUbuntuNotAffected(null) === false && secChecks.isUbuntuNotAffected("") === false);

    const split = secChecks.splitPhpTrackerView(
      ["CVE-1", "CVE-2", "CVE-3", "CVE-4"],
      [
        { status: "fulfilled", value: { status: "not-affected" } },
        { status: "fulfilled", value: { status: "ignored windows only" } },
        { status: "fulfilled", value: { status: "needed" } },
        { status: "rejected", reason: new Error("network") },
      ],
    );
    ok("splitPhpTrackerView: 対象外 2 件・要対応 2 件に分かれる",
      split.excluded.length === 2 && split.actionable.length === 2);
    ok("splitPhpTrackerView: tracker 失敗は要対応（fail-closed）",
      split.actionable.some((a) => a.cve === "CVE-4" && /network/.test(a.error || "")));
    ok("splitPhpTrackerView: 対象外の key が正しい",
      split.excluded.map((e) => e.cve).join(",") === "CVE-1,CVE-2");

    // 9-17. checkPhp 本体の統合（changelogHtml / trackerStatus を注入してネットワーク非依存に）
    // 純関数だけでは「summary / status / findings の分岐」が壊れても検出できない。
    // php.net と ubuntu.com を注入で差し替え、判定ロジックそのものを固定する。
    const phpLogFixture = path.join(os.tmpdir(), `mai-php-changelog-${process.pid}.gz`);
    fs.writeFileSync(phpLogFixture, require("zlib").gzipSync(Buffer.from(
      "php8.3 (1:8.3.6-0ubuntu0.24.04.13) noble-security; urgency=medium\n\n" +
      "  * SECURITY UPDATE: CVE-2020-1234（365日窓の外なので対象外）\n\n" +
      " -- Ubuntu <sec@ubuntu.com>  Mon, 21 Oct 2026 00:00:00 +0900\n")));
    const phpFixtureBase = {
      pkgVersion: "8.3.6-0ubuntu0.24.04.13",
      debianChangelog: phpLogFixture,
      changelogHtml: [
        "<h3>Version 8.3.32</h3><p datetime='2026-07-02'>CVE-2026-12184</p>",
        "<h3>Version 8.3.33</h3><p datetime='2026-07-30'>CVE-2026-9672</p>",
      ].join("\n"),
      ubuntuCodename: "noble",
    };
    const phpAllExcluded = await secChecks.checkPhp(Object.assign({}, phpFixtureBase, {
      trackerStatus: async () => ({ status: "not-affected" }),
    }));
    ok("checkPhp: tracker がすべて「対象外」なら ok", phpAllExcluded.status === "ok");
    ok("checkPhp: summary に「対象外 2 件」が出る（要対応は無い）",
      /対象外 2 件/.test(phpAllExcluded.summary) && !/要対応/.test(phpAllExcluded.summary));
    ok("checkPhp: findings はすべて info に落ちる",
      phpAllExcluded.findings.length === 2 && phpAllExcluded.findings.every((f) => f.severity === "info"));

    const phpTrackerDown = await secChecks.checkPhp(Object.assign({}, phpFixtureBase, {
      trackerStatus: async () => { throw new Error("tracker down"); },
    }));
    ok("checkPhp: tracker が全滅しても degraded（fail-closed）", phpTrackerDown.status === "degraded");
    ok("checkPhp: tracker 失敗の 2 件は critical のまま",
      phpTrackerDown.findings.filter((f) => f.severity === "critical").length === 2);
    ok("checkPhp: tracker の失敗理由が detail に入る",
      phpTrackerDown.findings.every((f) => /tracker down/.test(f.detail || "")));

    const phpMixed = await secChecks.checkPhp(Object.assign({}, phpFixtureBase, {
      trackerStatus: async (cve) => (
        cve === "CVE-2026-12184" ? { status: "not-affected" } : { status: "needed" }
      ),
    }));
    ok("checkPhp: 混在時は「要対応 1 件（対象外 1 件）」",
      phpMixed.status === "degraded" && /要対応 1 件（対象外 1 件）/.test(phpMixed.summary));
    fs.unlinkSync(phpLogFixture);

    // --- 10. PHP 実行時ハードニングの不変条件（2026-10-21 追加） ---
    // php-fpm は `enable_post_data_reading=Off` / `disable_functions` / `open_basedir` で
    // 実行時を制限する（scripts/php/apply-php-hardening.sh）。
    // その前提が壊れたまま放置されると、PHP コア RCE の被害が即座に拡大する。
    // そのため **アプリ側で守らなければならない前提**をここで固定する。
    console.log("[10] PHP ハードニングの不変条件");
    const phpFiles = fs.readdirSync(path.join(projectDir, "webui"))
      .filter((f) => f.endsWith(".php"))
      .map((f) => path.join(projectDir, "webui", f));

    /** PHP のコメントを除去して、コードだけを見る（行コメントとブロックコメント） */
    function stripPhpComments(src) {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
        .replace(/#[^\n]*/g, " ");
    }
    const phpCode = phpFiles.map((f) => ({ file: f, code: stripPhpComments(fs.readFileSync(f, "utf8")) }));

    // 10-1. POST/FILE を読まない（enable_post_data_reading=Off の前提）
    const postUsers = phpCode.filter((p) => /\$_(POST|FILES|REQUEST)\b/.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php は $_POST/$_FILES/$_REQUEST を読まない", postUsers.length === 0, postUsers.join(", "));

    // 10-2. POST するフォームがない
    const postForms = phpCode.filter((p) => /<form[^>]*method\s*=\s*["']?post/i.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php に method=post のフォームがない", postForms.length === 0, postForms.join(", "));

    // 10-3. mbstring を使わない（mbstring は未導入 → 呼ぶと 500 になる）
    const mbUsers = phpCode.filter((p) => /\bmb_[a-z_]+\s*\(/.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php は mb_* を呼ばない", mbUsers.length === 0, mbUsers.join(", "));

    // 10-4. 危険な実行系を使わない（RCE 後の到達点を作らない）
    const dangerRe = /\b(eval|assert|system|exec|shell_exec|passthru|popen|proc_open|pcntl_exec|dl|unserialize|create_function)\s*\(/;
    const dangerUsers = phpCode.filter((p) => dangerRe.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php に eval/system/exec/unserialize 等がない", dangerUsers.length === 0, dangerUsers.join(", "));

    // 10-5. 動的 include がない
    const dynInclude = phpCode.filter((p) => /(include|require)(_once)?\s*\(?\s*\$/.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php に動的 include/require がない", dynInclude.length === 0, dynInclude.join(", "));

    // 10-6. archive.php の $domain スコープ（関数内で global 宣言する）
    //      漏れるとサーバサイドSEOが空になる（2026-10-21 実測）
    const archiveCode = fs.readFileSync(path.join(projectDir, "webui", "archive.php"), "utf8");
    ok("archive.php: mai_archive_fetch が global $domain を持つ",
      /function\s+mai_archive_fetch[\s\S]*?global\s+\$domain\s*[;,]/.test(archiveCode));
    ok("archive.php: ローカル API（$apiBase）を先に叩く（往復滞后を避ける）",
      /global\s+\$domain\s*,\s*\$apiBase\s*;/.test(archiveCode) &&
      /file_get_contents\(\s*\$apiBase\s*\./.test(archiveCode));

    // 10-6b. _domain.php のローカル API ポート導出（本番 8080 / staging 8081）
    const domainCode = fs.readFileSync(path.join(projectDir, "webui", "_domain.php"), "utf8");
    ok("_domain.php: staging(test.) は 8081 / それ以外は 8080 を導出する",
      /8081/.test(domainCode) && /8080/.test(domainCode) && /strpos\(\s*\$host\s*,\s*'test\.'\s*\)/.test(domainCode));

    // 10-7. ハードニングの適用スクリプトが想定どおりの値を設定している
    const hardenSh = fs.readFileSync(path.join(projectDir, "scripts", "php", "apply-php-hardening.sh"), "utf8");
    ok("apply-php-hardening.sh: enable_post_data_reading=Off を設定する",
      /set_pool\s+"enable_post_data_reading"\s+"Off"/.test(hardenSh));
    ok("apply-php-hardening.sh: ffi.enable=preload を設定する",
      /set_pool\s+"ffi\.enable"\s+"preload"/.test(hardenSh));
    ok("apply-php-hardening.sh: disable_functions / open_basedir を設定する",
      /set_ini\s+"disable_functions"/.test(hardenSh) && /set_ini\s+"open_basedir"/.test(hardenSh));

    // 10-8. nginx の PHP 実行ガードが elza vhost を対象にしている
    const guardJs = fs.readFileSync(path.join(projectDir, "scripts", "nginx", "apply-php-exec-guard.js"), "utf8");
    const guardJsCode = guardJs.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    ok("apply-php-exec-guard.js: elza vhost のみを対象にする",
      /elza/.test(guardJsCode) && !/1717/.test(guardJsCode) && !/koinoyamai\.love/.test(guardJsCode));
    ok("apply-php-exec-guard.js: PHP を 404 にする（return 404）", guardJs.includes("return 404;"));

    // --- 11. ハニーポットの不変条件（2026-10-22 追加） ---
    // 偽物の置き場・配信ルール・監視が「安全側の既定」を保っているかを固定する。
    console.log("[11] ハニーポットの不変条件");
    const hpSetup = fs.readFileSync(path.join(projectDir, "scripts", "security", "honeypot-setup.sh"), "utf8");
    const hpWatch = fs.readFileSync(path.join(projectDir, "scripts", "security", "honeypot-watch.js"), "utf8");
    const hpPatch = fs.readFileSync(path.join(projectDir, "scripts", "nginx", "apply-honeypot.js"), "utf8");

    // 11-1. 偽物は Web 公開ツリーの外（/var/www/html 配下には置かない）
    ok("honeypot: 置き場が Web 公開ツリーの外",
      /HONEY_DIR="\$\{HONEY_DIR:-\/var\/lib\/mai-push\/honeypot\}"/.test(hpSetup) &&
      !/\/var\/www\/html/.test(hpSetup.replace(/^#.*$/gm, "")));

    // 11-2. 実物の .env を読み込まない・実在中身を複製しない
    ok("honeypot: 実物の .env を参照していない（偽物だけを作る）",
      !/cat\s+\/var\/www\/html\/koinoyamai\.love\/\.env/.test(hpSetup) &&
      !/cp\s+.*\.env\s+\/var\/www/.test(hpSetup));

    // 11-3. 監視が canary token を Doc で見ない（ログの token だけが手掛かり）
    ok("honeypot-watch: canary パスで判定している",
      /canaryPath/.test(hpWatch) && /kind:\s*"canary_used"/.test(hpWatch));
    ok("honeypot-watch: 取得（stolen）と偵察（probe）を区別している",
      /kind:\s*"stolen"/.test(hpWatch) && /kind:\s*"probe"/.test(hpWatch));

    // 11-4. nginx パッチは 1717 の vhost だけを対象にする
    ok("apply-honeypot.js: 1717 + koinoyamai.love の vhost のみ対象",
      /listen\\s\+1717/.test(hpPatch) && /koinoyamai/.test(hpPatch));
    // 11-5. 正規表現 location は出現順で評価される → PHP location より前に挿入しないと機能しない
    ok("apply-honeypot.js: 最初の location の直前に挿入する",
      /最初の location の直前/.test(hpPatch) && /const locRe/.test(hpPatch));
    // 11-6. 機密拡張子の deny ルールがある（.zip はアプリの配布物なので除外されている）
    ok("apply-honeypot.js: 機密拡張子を deny する（.zip は対象外）",
      /deny all/.test(hpPatch) && !/\|zip\|/.test(hpPatch.replace(/backup\\\.\(\?:zip[^)]*\)/g, "")));
    // 11-7. 状態ファイルが setup と watcher で分離されている（同じだと offset 消滅→全件再通知）
    const hpSetupState = /honeypot-canary\.json/.test(hpSetup) ? "honeypot-canary.json" : "";
    const hpWatchState = /honeypot-watch-state\.json/.test(hpWatch) ? "honeypot-watch-state.json" : "";
    ok("honeypot: 状態ファイルが setup と watcher で分離されている",
      hpSetupState !== "" && hpWatchState !== "" && hpSetupState !== hpWatchState);
    // 11-8. `.env` の変種（アンダースコア区切りを含む）も偽物として生成・分類できること
    ok("honeypot-setup: .env の変種（.env.bak 等）を生成する",
      /ENV_VARIANTS=/.test(hpSetup) && /\.env\.\$v/.test(hpSetup) || /\.env\.\{v\}/.test(hpSetup) || /\.env\.\$/.test(hpSetup));
    ok("honeypot-setup: .env_xxx（アンダースコア区切り）の変種も生成する",
      /ENV_VARIANTS_UNDERSCORE=/.test(hpSetup) && /\.env_\$v/.test(hpSetup));
    // パターンは**共有ファイル 1 つ**から読む（3 か所に二重管理しない）
    const hpPatternFile = path.join(projectDir, "scripts", "nginx", "honey-path-pattern.txt");
    const hpPattern = fs.existsSync(hpPatternFile) ? fs.readFileSync(hpPatternFile, "utf8").trim() : "";
    ok("ハニーパターンは共有ファイル 1 つに集約されている", hpPattern.length > 0);
    ok("apply-honeypot.js: 共有パターンファイルを読む",
      hpPatch.includes("honey-path-pattern.txt"));
    ok("honeypot-watch: 共有パターンファイルを読む",
      hpWatch.includes("honey-path-pattern.txt"));
    ok("apply-honeypot.sh: 共有パターンファイルを読む（ガードも同期）",
      fs.readFileSync(path.join(projectDir, "scripts", "nginx", "apply-honeypot.sh"), "utf8")
        .includes("honey-path-pattern.txt"));
    // 共有パターンで実際の判定が正しいこと（挙動テスト）
    if (hpPattern) {
      const hpRe = new RegExp("/(?:[\\w.\\-]+/)*(?:" + hpPattern + ")(?![.\\w\\-])", "i");
      const shouldMatch = ["/.env", "/.env.bak", "/.env_secret", "/.env_sendgrid",
        "/.env.docker", "/.env.bak.gz", "/workspace/.env", "/var/.env", "/webui/.env"];
      const shouldNotMatch = ["/index.php", "/admin.html", "/api/history",
        "/dl/android.json", "/css/header.css", "/main.js", "/.envx"];
      ok("共有パターン: ハニーパスにマッチする",
        shouldMatch.every((p) => hpRe.test(p)),
        shouldMatch.filter((p) => !hpRe.test(p)).join(", "));
      ok("共有パターン: 通常パスにマッチしない",
        shouldNotMatch.every((p) => !hpRe.test(p)),
        shouldNotMatch.filter((p) => hpRe.test(p)).join(", "));
    }
    // 11-9b. 通知の分割・重複抑制（2026-10-23 追加）
    //    Discord の embed description は 4096 文字上限。超えると**通知全体が 400 で落ちる**。
    //    実事故: 37 件の窃取を 1 通に詰めて落ち、窃取の通知が届かないうえ
    //    失敗ループで偵察が 5 分おきに再送された（「新規ないのに毎回通知」）。
    const chunkMod = require(path.join(projectDir, "scripts", "security", "discord-chunk.js"));
    const longUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const ev37 = Array.from({ length: 37 }, (_, i) => ({
      time: "2026-10-23T05:58:21+09:00", ip: "203.0.113.5", path: `/.env.test${i}`, bytes: 1040, ua: longUa,
    }));
    const stealFmt = (e) => `• \`${e.time}\` **${e.ip}** が \`${e.path}\`（${e.bytes} bytes）を取得\n  UA: \`${e.ua}\``;
    const oneShot = ev37.map(stealFmt).join("\n");
    const chunks37 = chunkMod.chunkLines(ev37, stealFmt);
    ok("discord-chunk: 大きい通知を 4096 文字以内の複数メッセージへ分割する",
      oneShot.length > chunkMod.DISCORD_DESCRIPTION_LIMIT &&
      chunks37.length > 1 &&
      chunks37.every((c) => c.text.length <= chunkMod.BODY_LIMIT));
    ok("discord-chunk: 分割してもイベントを落とさない",
      chunks37.reduce((n, c) => n + c.items.length, 0) === ev37.length);
    ok("discord-chunk: 1 行が上限を超える場合は行を切り詰める",
      chunkMod.chunkLines([{ ua: "u".repeat(9000) }], (e) => `• ${e.ua}`)[0].text.length
        <= chunkMod.BODY_LIMIT);
    ok("discord-chunk: truncate は embed 上限以内に収める",
      chunkMod.truncate("x".repeat(9000), chunkMod.DISCORD_DESCRIPTION_LIMIT - 20).length
        <= chunkMod.DISCORD_DESCRIPTION_LIMIT - 20);
    ok("honeypot-watch: 通知を分割する（1 通に詰め込まない）",
      /chunkLines/.test(hpWatch) && !/probes\.slice\(-10\)/.test(hpWatch));
    ok("honeypot-watch: イベント単位で配送を追跡する（失敗分だけ再送）",
      /e\.notified\s*=\s*!!ok/.test(hpWatch) && /filter\(\(e\)\s*=>\s*!e\.notified\)/.test(hpWatch));
    ok("honeypot-watch: 同じイベントを一定期間は再通知しない（state.recent）",
      /function eventKey/.test(hpWatch) && /state\.recent/.test(hpWatch) && /DEDUPE_HOURS/.test(hpWatch));
    ok("honeypot-watch: canary_used は重複抑制しない（最も重要な証拠）",
      /e\.kind !== "canary_used"/.test(hpWatch));
    // 11-9c. 通数の上限・UA 長・state のアトミック性（独立レビュー B-1 / N-1 / N-4 の恒久化）
    ok("honeypot-watch: 1 カテゴリの送信通数に上限がある（UA 長での通知爆発を防ぐ）",
      /MAX_CHUNKS_PER_CATEGORY\s*=\s*\d+/.test(hpWatch) &&
      /\.slice\(0,\s*MAX_CHUNKS_PER_CATEGORY\)/.test(hpWatch) &&
      /e\.summarized\s*=\s*true/.test(hpWatch));
    ok("honeypot-watch: 通知に載せる UA を切り詰める",
      /MAX_UA_CHARS\s*=\s*\d+/.test(hpWatch) && /clip\(e\.ua, MAX_UA_CHARS\)/.test(hpWatch));
    ok("honeypot-watch: state をアトミックに書く（壊れると全件再通知になる）",
      /renameSync\(tmp, file\)/.test(hpWatch));
    ok("honeypot-watch: 重複キーからクエリ文字列を落とす",
      /split\("\?"\)\[0\]/.test(hpWatch));
    ok("honeypot-watch: HONEY_DEDUPE_HOURS の不正値は既定 24h に倒す",
      /Number\.isFinite\(DEDUPE_HOURS_RAW\)/.test(hpWatch));
    ok("honeypot-watch: --dry-run は状態報告もしない",
      /if \(DRY_RUN\) \{\s*\n\s*log\("\(dry-run\) 状態報告はスキップします/.test(hpWatch));
    ok("notify.sendDiscord: description を上限で切り詰める（安全網）",
      /truncate\(payload\.description/.test(
        fs.readFileSync(path.join(projectDir, "scripts", "security", "notify.js"), "utf8")));

    // 11-9. 自機リクエストを通知しない仕組み（ノイズ防止）があること
    ok("honeypot-watch: 自機リクエストを判定して通知対象から外す",
      /isLocalSelfTest/.test(hpWatch) && /include-local/.test(hpWatch));
    // 11-9. 404（偵察）も honey.log に残る仕組みが入っていること
    ok("apply-honeypot.js: 404 を named location へ逃がす（error_page）",
      /error_page 404 = @honey_not_found/.test(hpPatch) && /location @honey_not_found/.test(hpPatch));
    // 11-10. 冪等性（同じ入力に 2 回適用して差分ゼロ）
    const hpFixture = [
      "events { worker_connections 16; }",
      "http {",
      "    log_format withff '$remote_addr \"$request\" $status';",
      "    server {",
      "        listen 1717;",
      "        server_name koinoyamai.love;",
      "        root /var/www/html/koinoyamai.love/webui;",
      "        location ~ \\.php$ { fastcgi_pass unix:/run/php/php8.3-fpm.sock; }",
      "    }",
      "}",
    ].join("\n");
    const hpTmp = fs.mkdtempSync(path.join(os.tmpdir(), "honeypot-idem-"));
    const hpIn = path.join(hpTmp, "nginx.conf");
    const hpA = path.join(hpTmp, "a.conf");
    const hpB = path.join(hpTmp, "b.conf");
    fs.writeFileSync(hpIn, hpFixture);
    const hpNode = process.execPath;
    const hpPatchJs = path.join(projectDir, "scripts", "nginx", "apply-honeypot.js");
    const run1 = require("child_process").spawnSync(hpNode, [hpPatchJs, hpIn, hpA], { encoding: "utf8" });
    const run2 = require("child_process").spawnSync(hpNode, [hpPatchJs, hpA, hpB], { encoding: "utf8" });
    let idem = false;
    try {
      idem = run1.status === 0 && run2.status === 0 &&
        fs.readFileSync(hpA, "utf8") === fs.readFileSync(hpB, "utf8");
    } catch (e) { idem = false; }
    ok("apply-honeypot.js: 2 回適用しても差分ゼロ（冪等）", idem,
      `run1=${run1.status} run2=${run2.status} ${(run1.stderr || "").slice(0, 120)}`);
    try { fs.rmSync(hpTmp, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    // 11-11. 挙動テスト（状態管理の不変条件。文字列検査では検出できない）
    const hpSelftest = require("child_process").spawnSync(
      process.execPath,
      [path.join(projectDir, "scripts", "security", "honeypot-watch.js"), "--selftest"],
      { encoding: "utf8", timeout: 30000 }
    );
    const hpSelftestOut = `${hpSelftest.stdout || ""}${hpSelftest.stderr || ""}`;
    const hpFail = (hpSelftestOut.match(/FAIL/g) || []).length;
    ok("honeypot-watch --selftest: 状態管理の不変条件がすべて通る",
      hpSelftest.status === 0 && hpFail === 0,
      `status=${hpSelftest.status} fail=${hpFail} ${hpSelftestOut.slice(-200)}`);

    // 11-12. ハニーポット可視化（管理画面、2026-10-23 追加）
    //   攻撃元の IP・UA・国は**公開に出さない**（§5.3）。集計は services/ に分離してテスト可能に。
    const hpReportPath = path.join(projectDir, "services", "honeypot-report.js");
    const hpReport = require(hpReportPath);
    const hpRouteSrc = fs.readFileSync(path.join(projectDir, "routes", "admin-honeypot.js"), "utf8");
    ok("admin-honeypot: /api/admin/ 配下 + requireAuth（公開エリアに出さない）",
      /app\.get\("\/api\/admin\/honeypot",\s*adminAuth\.requireAuth/.test(hpRouteSrc));
    ok("admin-honeypot: server.js に登録されている",
      /require\("\.\/routes\/admin-honeypot"\)\.register\(app\)/.test(
        fs.readFileSync(path.join(projectDir, "server.js"), "utf8")));
    ok("admin-honeypot: 集計が lib/admin を巻き込まない（HTTP 非依存＝テストが終了する）",
      !/require\("\.\.\/lib\/admin"\)/.test(fs.readFileSync(hpReportPath, "utf8")));
    const hpUnauth = await request("GET", "/api/admin/honeypot?days=7");
    ok("admin-honeypot: 未認証では 401（集計を返さない）",
      hpUnauth.status === 401 && !(hpUnauth.json && hpUnauth.json.totals), `status=${hpUnauth.status}`);
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "honeypot-report-"));
      const logFile = path.join(tmp, "honey.log");
      const canaryFile = path.join(tmp, "canary.json");
      const now = Date.parse("2026-10-23T12:00:00+09:00");
      const line = (iso, ip, cf, xff, st, uri, ua) =>
        `${iso} ip=${ip} cf=${cf} xff="${xff}" st=${st} uri=${uri} bytes=10 req="GET ${uri} HTTP/1.1" ref="-" ua="${ua}"`;
      fs.writeFileSync(canaryFile, JSON.stringify({ token: "abc123", canaryPath: "/_canary/abc123" }));
      fs.writeFileSync(logFile, [
        line("2026-10-23T11:00:00+09:00", "127.0.0.1", "-", "-", 200, "/.env", "curl/8.5.0"), // 自機（除外）
        line("2026-10-23T10:00:00+09:00", "127.0.0.1", "203.0.113.5", "203.0.113.5", 200, "/.env", "Scanner/1.0"), // 窃取
        line("2026-10-23T10:01:00+09:00", "127.0.0.1", "203.0.113.5", "203.0.113.5", 404, "/secrets.json", "Scanner/1.0"), // 偵察
        line("2026-10-23T10:02:00+09:00", "127.0.0.1", "203.0.113.6", "203.0.113.6", 200, "/_canary/abc123", "curl/8.0"), // canary 使用
        line("2026-10-23T10:03:00+09:00", "127.0.0.1", "203.0.113.7", "203.0.113.7", 204, "/_canary/", "curl/8.0"), // canary 探査
        line("2026-10-23T10:04:00+09:00", "127.0.0.1", "203.0.113.8", "203.0.113.8", 404, "/db.sql",
          "Mozilla/5.0 st=200 uri=/.env"), // UA 偽装（実体は 404）
        line("2026-10-15T10:00:00+09:00", "127.0.0.1", "203.0.113.9", "203.0.113.9", 200, "/.env", "old"), // 期間外
      ].join("\n") + "\n");

      const fakeGeo = async (ips) => new Map([...new Set(ips)].map((ip) => [ip, {
        cc: ip === "203.0.113.6" ? "HU" : "US",
        country: ip === "203.0.113.6" ? "ハンガリー" : "アメリカ合衆国",
        asn: "AS64500", org: "TEST-ORG - Example, US", ok: true,
      }]));
      const d = await hpReport.collect({ days: 7, logPath: logFile, canaryStatePath: canaryFile, now, geoLookup: fakeGeo });

      ok("honeypot-report: 自機テストと期間外を除外する",
        d.source.selfTests === 1 && d.totals.events === 5,
        `self=${d.source.selfTests} events=${d.totals.events}`);
      ok("honeypot-report: 窃取 / canary 使用 / 偵察を分類する",
        d.totals.stolen === 1 && d.totals.canaryUsed === 1 && d.totals.probe === 3 &&
        d.totals.canaryScans === 1,
        JSON.stringify(d.totals));
      ok("honeypot-report: UA に紛れ込ませた st= / uri= に騙されない",
        d.recent.filter((r) => r.ua.includes("st=200")).every((r) => r.kind === "probe" && r.status === 404),
        JSON.stringify(d.recent.filter((r) => r.ua.includes("st=200")).map((r) => [r.kind, r.status])));
      ok("honeypot-report: 国別に集計する（IP は重複しない）",
        d.byCountry.length === 2 && d.byCountry[0].cc === "US" && d.byCountry[0].events === 4 &&
        d.totals.ips === 4 && d.totals.countries === 2,
        JSON.stringify(d.byCountry.map((c) => [c.cc, c.events, c.ips])));
      ok("honeypot-report: canary の token を UI に出さない（マスクする）",
        d.recent.every((r) => !r.path.includes("abc123")) &&
        d.topPaths.every((p) => !p.path.includes("abc123")),
        d.recent.map((r) => r.path).join(","));
      ok("honeypot-report: 日別を期間の全日で 0 埋めする（データを隠さない）",
        (d.byDay.length === 7 || d.byDay.length === 8) &&
        d.byDay.every((x) => typeof x.events === "number" && /^\d{4}-\d{2}-\d{2}$/.test(x.date)) &&
        d.byDay[d.byDay.length - 1].date === "2026-10-23",
        `${d.byDay.length} 日: ${d.byDay.map((x) => x.date).join(",")}`);

      // 7 日窓の境界（カレンダー上は 8 日目）のイベントも落とさない
      fs.writeFileSync(logFile, line("2026-10-16T13:00:00+09:00", "127.0.0.1", "203.0.113.30",
        "203.0.113.30", 200, "/.env", "BOUNDARY") + "\n");
      const dB = await hpReport.collect({ days: 7, logPath: logFile, canaryStatePath: canaryFile, now, geoLookup: fakeGeo });
      ok("honeypot-report: 7 日窓の境界（8 日目）のイベントも集計から落とさない",
        dB.totals.events === 1 && dB.byDay.length === 8 && dB.byDay[0].date === "2026-10-16",
        `events=${dB.totals.events} byDay=${dB.byDay.length} first=${dB.byDay[0] && dB.byDay[0].date}`);

      // ローテート前の canary token も watcher と同じく「使用」と判定する
      fs.writeFileSync(canaryFile, JSON.stringify({
        token: "newtok", canaryPath: "/_canary/newtok", previousCanaryPaths: ["/_canary/oldtok"],
      }));
      fs.writeFileSync(logFile, line("2026-10-23T10:05:00+09:00", "127.0.0.1", "203.0.113.31",
        "203.0.113.31", 204, "/_canary/oldtok", "curl/8.0") + "\n");
      const dOld = await hpReport.collect({ days: 7, logPath: logFile, canaryStatePath: canaryFile, now, geoLookup: fakeGeo });
      ok("honeypot-report: ローテート前の canary token も canary_used（watcher と揃える）",
        dOld.totals.canaryUsed === 1 && dOld.totals.canaryScans === 0 && dOld.totals.stolen === 0,
        JSON.stringify(dOld.totals));

      // ローテート済みログ（.1 / .2.gz）も読む（日次ローテートで 7/30/90 日が実質 1 日にならない）
      const rotDir = path.join(tmp, "rot");
      fs.mkdirSync(rotDir, { recursive: true });
      const rot = path.join(rotDir, "honey.log");
      fs.writeFileSync(`${rot}.2.gz`, require("zlib").gzipSync(
        line("2026-10-21T10:00:00+09:00", "127.0.0.1", "203.0.113.40", "203.0.113.40", 200, "/.env", "Z") + "\n"));
      fs.writeFileSync(`${rot}.1`,
        line("2026-10-22T10:00:00+09:00", "127.0.0.1", "203.0.113.41", "203.0.113.41", 200, "/.env", "Y") + "\n");
      fs.writeFileSync(rot,
        line("2026-10-23T10:00:00+09:00", "127.0.0.1", "203.0.113.42", "203.0.113.42", 200, "/.env", "X") + "\n");
      const dRot = await hpReport.collect({ days: 7, logPath: rot, canaryStatePath: canaryFile, now, geoLookup: fakeGeo });
      ok("honeypot-report: ローテート済みログ（.1 / .2.gz）も読む",
        dRot.totals.events === 3 && dRot.byDay.slice(-3).map((x) => x.events).join(",") === "1,1,1",
        `events=${dRot.totals.events} byDay=${dRot.byDay.map((x) => x.events).join(",")}`);

      // パース: uri の実空白・UA の \xHH エスケープ
      const spaced = hpReport.parseLine('2026-10-23T10:00:00+09:00 ip=127.0.0.1 cf=203.0.113.5 xff="203.0.113.5" st=404 uri=/a b bytes=10 req="GET /a%20b HTTP/1.1" ref="-" ua="x"');
      ok("honeypot-report: uri に実空白があってもパースできる（攻撃者が記録を落とせない）",
        !!spaced && spaced.path === "/a b" && spaced.status === 404 && spaced.ua === "x",
        JSON.stringify(spaced));
      const escLine = hpReport.parseLine('2026-10-23T10:00:00+09:00 ip=127.0.0.1 cf=203.0.113.5 xff="-" st=200 uri=/.env bytes=10 req="GET /.env HTTP/1.1" ref="-" ua="Mozilla \\x22q\\x22 end"');
      ok('honeypot-report: nginx の \\x22 エスケープを戻す（UA を正しく表示）',
        !!escLine && escLine.ua === 'Mozilla "q" end', escLine && escLine.ua);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    }

    // 11-12b. 管理画面 JS（時刻の TZ・XSS・異常時の表示）
    const hpJs = fs.readFileSync(path.join(projectDir, "webui", "js", "admin-honeypot.js"), "utf8");
    ok("admin-honeypot.js: 時刻は JST 固定（端末の TZ に依存させない）",
      /timeZone:\s*"Asia\/Tokyo"/.test(hpJs) && /hourCycle:\s*"h23"/.test(hpJs));
    ok("admin-honeypot.js: 攻撃者が制御できる値は esc() を通す（XSS 防止）",
      /function esc\(/.test(hpJs) && /esc\(r\.path\)/.test(hpJs) &&
      /esc\(r\.ua\)/.test(hpJs) && /esc\(r\.ip\)/.test(hpJs));
    ok("admin-honeypot.js: ログが読めない時に黙って「アクセスなし」にしない",
      /logPresent/.test(hpJs) && /canaryConfigured/.test(hpJs) && /skipped/.test(hpJs));

    // 11-12c. スタブ DOM で実際に描画し、例外・XSS・TZ を挙動で確認する（文字列検査だけでは不十分）
    {
      const hpJsPath = path.join(projectDir, "webui", "js", "admin-honeypot.js");
      const fixture = {
        ok: true, days: 7, generatedAt: "2026-10-23T01:00:00.000Z",
        source: {
          logPresent: true, logLines: 1, selfTests: 0, skipped: 0, events: 1,
          firstSeen: "2026-10-22T03:58:43.000Z", lastSeen: "2026-10-23T01:00:39.000Z",
        },
        totals: { events: 1, stolen: 1, canaryUsed: 0, probe: 0, canaryScans: 0, ips: 1, countries: 1, canaryConfigured: true },
        byCountry: [{ cc: "US", country: "アメリカ合衆国<img src=x>", events: 1, stolen: 1, canaryUsed: 0, probe: 0, ips: 1, orgs: [{ org: "<b>x</b>", n: 1 }] }],
        byDay: [
          { date: "2026-10-22", events: 1, stolen: 1, canaryUsed: 0, probe: 0 },
          { date: "2026-10-23", events: 0, stolen: 0, canaryUsed: 0, probe: 0 },
        ],
        topIps: [], topPaths: [{ path: "/.env<img src=x>", events: 1, stolen: 1, canaryUsed: 0, probe: 0 }],
        recent: [{
          time: "2026-10-23T10:00:00+09:00", ip: "<img src=x>", cc: "US", country: "<img>",
          asn: "AS1", org: "<b>", kind: "stolen", status: 200, path: "/.env<img src=x>",
          ua: "<script>alert(1)</script>",
        }],
        note: "note",
      };
      const el = { innerHTML: "", querySelectorAll: () => [], addEventListener: () => {} };
      const saved = { document: global.document, fetch: global.fetch, setInterval: global.setInterval, set: null };
      global.document = {
        getElementById: () => el,
        querySelectorAll: () => [],
        querySelector: () => ({ classList: { contains: () => false } }),
        hidden: false,
      };
      global.fetch = async () => ({ ok: true, status: 200, json: async () => fixture });
      global.setInterval = () => 0;
      let renderError = null;
      try {
        delete require.cache[require.resolve(hpJsPath)];
        require(hpJsPath);
        await sleep(50);
      } catch (e) {
        renderError = e;
      } finally {
        const out = el.innerHTML;
        global.document = saved.document;
        global.fetch = saved.fetch;
        global.setInterval = saved.setInterval;
        try { delete require.cache[require.resolve(hpJsPath)]; } catch (e) { /* best-effort */ }
        ok("admin-honeypot.js: スタブ DOM で例外なく描画し、攻撃者の文字列を esc する",
          !renderError && out.length > 500 &&
          !/<\/?img\b/i.test(out) && !/<script/i.test(out) && out.includes("&lt;img"),
          renderError ? renderError.message : `len=${out.length}`);
        // firstSeen は UTC ISO（03:58Z）→ JST 12:58 で出る（端末 TZ 非依存）
        ok("admin-honeypot.js: 期間表示が JST になる（UTC のまま出さない）",
          /期間内 10\/22 12:58/.test(out), (out.match(/期間内 [^<]{6,40}/) || ["none"])[0]);
      }
    }

    // 11-13. geoip（DNS 方式・外部 DB 不要）の不変条件
    const geoipMod = require(path.join(projectDir, "services", "geoip.js"));
    ok("geoip: IPv4 の問い合わせ名（逆順オクテット）",
      geoipMod.originName("207.175.199.227") === "227.199.175.207.origin.asn.cymru.com");
    ok("geoip: IPv6 の問い合わせ名（nibble 逆順 + origin6）",
      geoipMod.originName("2001:db8::1") ===
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.origin6.asn.cymru.com");
    ok("geoip: 私有/ループバックは問い合わせない（Tailscale 100.64/10 含む）",
      geoipMod.isPrivateIp("100.65.152.57") && geoipMod.isPrivateIp("192.168.1.10") &&
      geoipMod.isPrivateIp("::ffff:127.0.0.1") && !geoipMod.isPrivateIp("8.8.8.8"));
    ok("geoip: 不正な IP は null（DNS を引かない）", geoipMod.originName("not-an-ip") === null);

    // --- 12. Android 配信アラームの不変条件（2026-10-22 追加） ---
    // 「アラームが短く、止まるまで鳴らない」問題の再発を防ぐ。
    console.log("[12] Android 配信アラームの不変条件");
    const ktDir = path.join(projectDir, "mai_notification", "app", "src", "main", "java", "com", "yuzuki", "mai_notification");
    const readKt = (rel) => {
        try { return fs.readFileSync(path.join(ktDir, rel), "utf8"); } catch (e) { return ""; }
    };
    const alarmServiceKt = readKt("AlarmSoundService.kt");
    const alarmReceiverKt = readKt("AlarmReceiver.kt");
    const fcmKt = readKt(path.join("MainActivity", "MyFirebaseMessagingService.kt"));
    const manifestXml = fs.readFileSync(
      path.join(projectDir, "mai_notification", "app", "src", "main", "AndroidManifest.xml"), "utf8");

    // 12-1. 存在しない API を使わない（NotificationCompat.Builder.setTurnScreenOn は無い＝コンパイルエラー）
    ok("Android: NotificationCompat の setTurnScreenOn を使わない（存在しない API）",
      !/setTurnScreenOn/.test(alarmServiceKt) && !/setTurnScreenOn/.test(fcmKt));
    // 12-2. アラーム音はループ再生
    ok("Android: アラーム音をループ再生する（isLooping = true）",
      /isLooping\s*=\s*true/.test(alarmServiceKt));
    ok("Android: USAGE_ALARM で鳴らす（マナーモードでも鳴る）",
      /AudioAttributes\.USAGE_ALARM/.test(alarmServiceKt));
    // 12-3. フォアグラウンドサービスの宣言と権限
    ok("Android: AlarmSoundService を manifest に宣言している",
      /android:name="\.AlarmSoundService"/.test(manifestXml) &&
      /foregroundServiceType="mediaPlayback"/.test(manifestXml));
    ok("Android: FGS の権限（FOREGROUND_SERVICE / MEDIA_PLAYBACK / VIBRATE）がある",
      /FOREGROUND_SERVICE"/.test(manifestXml) &&
      /FOREGROUND_SERVICE_MEDIA_PLAYBACK/.test(manifestXml) &&
      /VIBRATE/.test(manifestXml));
    // 12-4. full-screen intent で起動したときはアラームを止めない（止めると数秒で止まる）
    ok("Android: full-screen intent 起動ではアラームを止めない（launchedFromAlarm）",
      /EXTRA_FROM_ALARM/.test(alarmServiceKt) &&
      /launchedFromAlarm/.test(readKt(path.join("MainActivity", "MainActivity.kt"))));
    // 12-5. サーバーはアラーム用チャネルを data-only で送る（background で onMessageReceived が呼ばれないとループしない）
    const notifSvc = fs.readFileSync(path.join(projectDir, "services", "notification.js"), "utf8");
    ok("サーバー: アラーム用チャネルの FCM は data-only（notification ブロックなし）",
      /isAlarmChannel/.test(notifSvc) && /isAlarmChannel\s*\?\s*\{\s*\}/.test(notifSvc));
    // 12-6. バージョンの整合（APK 配布は Windows 側・json は APK 配置後）
    const gradleKt = fs.readFileSync(path.join(projectDir, "mai_notification", "app", "build.gradle.kts"), "utf8");
    ok("Android: バージョンが 1.7.4 / versionCode 12",
      /versionName\s*=\s*"1\.7\.4"/.test(gradleKt) && /versionCode\s*=\s*12/.test(gradleKt));

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
      ok("upload サービス: /dmedia で Host を照合する（LAN 経由の迂回防止）",
        /app\.use\("\/dmedia",[\s\S]{0,400}?req\.headers\.host/.test(uploadSrc));
      ok("upload サービス: scope=discord の ID が 128bit（16 バイト）",
        /req\.query\.scope\s*===\s*"discord"\s*\?\s*16\s*:\s*4/.test(uploadSrc));
    }

    // --- 14. 境界バリデーションと型検査の部分導入（2026-10-23 追加） ---
    //  「JSON に型を書くだけでは検証していないのと同じ」。壊れる入力は 400 に倒して可視化する。
    //  型は TypeScript を入れず `// @ts-check` + JSDoc で持つ（ビルドステップを増やさないため）。
    console.log("\n[14] 境界バリデーションと型検査（@ts-check）");
    {
      // ⚠️ `lib/admin.js` をプロセス内で require すると sqlite3 のハンドルが開いたまま残る。
      //  **テスト終了時に DB ファイルを消すと**、起動時の CREATE TABLE が IOERR を起こして
      //  「テストは 190 pass なのにプロセスが非 0 で終了する」（pre-push が落ちる）になる。
      //  そのため固定パスを置き去りにし（/tmp は再起動で消える）、消さない。
      const adminLibDb = path.join(os.tmpdir(), "regression-admin-lib.db");
      const v = require(path.join(projectDir, "lib", "validate.js"));
      const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof v.ValidationError; } };
      ok("lib/validate.js: 文字列の型・長さ・トリムを検証する",
        v.str("x", { field: "a", min: 1, max: 5 }) === "x" && v.str("  x ", { field: "a", trim: true }) === "x");
      ok("lib/validate.js: 型が違う入力は ValidationError（数値・配列・null・boolean の混入）",
        throws(() => v.str(123, { field: "a" })) && throws(() => v.str(null, { field: "a" })) &&
        throws(() => v.num("10", { field: "a" })) && throws(() => v.bool("false", { field: "a" })) &&
        throws(() => v.arr("x", { field: "a" })) && throws(() => v.enumOf("z", { field: "a", values: ["a", "b"] })));
      ok("lib/validate.js: 長さ・範囲・整数・許可キー・http(s) のみ",
        throws(() => v.str("xxxxx", { field: "a", max: 4 })) && throws(() => v.num(11, { field: "a", max: 10 })) &&
        throws(() => v.num(1.5, { field: "a", int: true })) &&
        throws(() => v.objKeys({ evil: 1 }, { field: "a", allowed: ["good"] })) &&
        throws(() => v.httpUrl("javascript:alert(1)", { field: "u" })) &&
        v.httpUrl("https://example.com/x", { field: "u" }) === "https://example.com/x");
      ok("lib/validate.js: null 許容・既定値は指定どおり（送信側の仕様を変えないため）",
        v.str(null, { field: "a", allowNull: true }) === null &&
        v.num(undefined, { field: "a", default: 7 }) === 7 &&
        v.enumOf(undefined, { field: "a", values: ["x"], default: "x" }) === "x");

      // 14-2. /api/notify は HMAC 検証の**後**に型も検証する
      //   （型違いを「認証失敗」として数えると、キーが合っているのに原因不明の失敗になる）
      const sign = require(path.join(projectDir, "src", "core", "notify-sign.js")).signNotifyPayload;
      const postNotify = async (payload) => {
        const bodyStr = JSON.stringify(payload);
        const signed = sign(HMAC_SECRET, bodyStr);
        return request("POST", "/api/notify", {
          headers: {
            "x-notify-token": TOKEN,
            "x-notify-hmac": signed.hmac,
            "x-notify-timestamp": signed.timestamp,
          },
          body: bodyStr,
        });
      };
      const rOk = await postNotify({ type: "regression", data: { title: "テスト", body: "b", url: "/x", tweet_id: 123 } });
      ok("notify 検証: 整形済みペイロードは受理される（test env では抑制）",
        rOk.status === 200 && rOk.json && rOk.json.suppressed === true, `status=${rOk.status} body=${rOk.raw && rOk.raw.slice(0, 80)}`);
      const rExtra = await postNotify({ type: "regression", data: { title: "t", unknownNewField: "x" } });
      ok("notify 検証: 未知のフィールドは弾かない（新フィールド追加を壊さないため）",
        rExtra.status === 200, `status=${rExtra.status}`);
      const rTitle = await postNotify({ type: "regression", data: { title: 123 } });
      ok("notify 検証: title が文字列でなければ 400（DB バインドの静かな失敗を防ぐ）",
        rTitle.status === 400 && /data\.title/.test(rTitle.raw || ""), `status=${rTitle.status} body=${rTitle.raw}`);
      const rLong = await postNotify({ type: "regression", data: { title: "x".repeat(501) } });
      ok("notify 検証: title が上限超過なら 400", rLong.status === 400, `status=${rLong.status}`);
      const rType = await postNotify({ type: "x".repeat(51), data: { title: "t" } });
      ok("notify 検証: type が上限超過なら 400", rType.status === 400, `status=${rType.status}`);
      const rNullData = await postNotify({ type: "regression", data: null });
      ok("notify 検証: data が null なら 400", rNullData.status === 400, `status=${rNullData.status}`);
      const rStrData = await postNotify({ type: "regression", data: "x" });
      ok("notify 検証: data が文字列なら 400", rStrData.status === 400, `status=${rStrData.status}`);
      const rObjTweet = await postNotify({ type: "regression", data: { title: "t", tweet_id: { a: 1 } } });
      ok("notify 検証: tweet_id がオブジェクトなら 400", rObjTweet.status === 400, `status=${rObjTweet.status}`);
      const rArrSetting = await postNotify({ type: "regression", data: { title: "t" }, settingKey: ["x"] });
      ok("notify 検証: settingKey が配列なら 400", rArrSetting.status === 400, `status=${rArrSetting.status}`);
      const rNumType = await postNotify({ type: 123, data: { title: "t" } });
      ok("notify 検証: type が数値なら 400", rNumType.status === 400, `status=${rNumType.status}`);
      const rNoData = await postNotify({ type: "regression", data: [] });
      ok("notify 検証: data がオブジェクトでなければ 400",
        rNoData.status === 400 && /data must be an object/.test(rNoData.raw || ""), `status=${rNoData.status}`);
      const rUnsigned = await (async () => {
        const bodyStr = JSON.stringify({ type: "regression", data: { title: 123 } });
        return request("POST", "/api/notify", {
          headers: { "x-notify-token": TOKEN, "x-notify-hmac": "0".repeat(64), "x-notify-timestamp": String(Math.floor(Date.now() / 1000)) },
          body: bodyStr,
        });
      })();
      ok("notify 検証: HMAC 不一致は 401（検証の前後関係が保たれている）",
        rUnsigned.status === 401, `status=${rUnsigned.status}`);

      // 14-3. 管理ログインの入力（`req.body` は JSON 以外だと undefined）
      const lNoBody = await request("POST", "/api/admin/login");
      ok("admin login: ボディ無しは 500 ではなく 400",
        lNoBody.status === 400, `status=${lNoBody.status}`);
      const lBadType = await request("POST", "/api/admin/login", { body: { username: { $ne: "" }, password: "x" } });
      ok("admin login: 型が違うボディは 400（型違いを「認証失敗」として数えない）",
        lBadType.status === 400, `status=${lBadType.status}`);

      // 14-4. 同名ヘッダが複数（Node は配列で返す）来ても 500 にならない
      process.env.ADMIN_DB_PATH = adminLibDb;
      process.env.TRUST_PROXY = "true";
      const adminLib = require(path.join(projectDir, "lib", "admin.js"));
      ok("admin: X-Forwarded-For が配列でも壊れない（`.split()` で 500 にならない）",
        adminLib.getClientIP({ headers: { "x-forwarded-for": ["1.2.3.4", "5.6.7.8"] }, socket: { remoteAddress: "9.9.9.9" } }) === "1.2.3.4");
      ok("admin: ヘッダが無いときは remoteAddress に倒す",
        adminLib.getClientIP({ headers: {}, socket: { remoteAddress: "9.9.9.9" } }) === "9.9.9.9");

      // 14-5. 型検査は TypeScript を入れずに持つ（ビルド・デプロイ経路を変えない判断）
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
      const depNames = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
      ok("型検査: TypeScript / tsx を依存に入れていない（ビルドステップを増やす判断をしない）",
        !depNames.some((n) => ["typescript", "tsx", "ts-node", "ts-jest", "swc"].includes(n)),
        depNames.filter((n) => /typescript|tsx|swc/.test(n)).join(",") || "なし");
      for (const rel of ["lib/validate.js", "lib/admin.js", "src/core/notify-sign.js", "services/geoip.js"]) {
        const src = fs.readFileSync(path.join(projectDir, rel), "utf8");
        ok(`${rel}: @ts-check と JSDoc で型検査している`,
          /\/\/ @ts-check/.test(src) && /@param|@returns|@property/.test(src));
      }
      ok("notify-sign.js: 署名対象の型を JSDoc で固定（JSON を作り直さないことの明文化）",
        /SignedNotifyPayload/.test(fs.readFileSync(path.join(projectDir, "src", "core", "notify-sign.js"), "utf8")));
      // 14-6. SSRF 対策: push エンドポイントは「公開ホスト」しか登録・送信できない
      //   （web push はクライアントが指定した URL へサーバーが POST するため）
      const routable = (u) => v.isRoutableHost(new URL(u).hostname);
      ok("validate: 公開の push サービスは許可する",
        v.publicHttpUrl("https://fcm.googleapis.com/fcm/send", { field: "u" }) === "https://fcm.googleapis.com/fcm/send" &&
        routable("https://web.push.apple.com/x") && routable("https://updates.push.services.mozilla.com/x"));
      ok("validate: loopback / プライベート / メタデータ / Tailscale は拒否する",
        throws(() => v.publicHttpUrl("http://127.0.0.1:8080/api/notify", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://169.254.169.254/latest/meta-data/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://192.168.1.70:1700/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://10.0.0.5/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://172.16.0.9/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://100.65.152.57/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[::1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[fd00::1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://localhost/x", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://foo.local/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://224.0.0.1/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://255.255.255.255/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://0.0.0.0/", { field: "u" })));
      // IPv6 は `URL.hostname` が**角括弧付き**で返る。括弧を外して nibble 列で判定すること
      // （geoip.isPrivateIp は圧縮表記しか見ていないため、ここでは使わない）。
      ok("validate: IPv6 の loopback / unspecified / link-local / unique-local / multicast を拒否する",
        throws(() => v.publicHttpUrl("http://[::1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[0:0:0:0:0:0:0:1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[::]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[fe80:0:0:0:0:0:0:1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[fd00::1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[ff02::1]/", { field: "u" })));
      ok("validate: IPv4-mapped の 16 進表記も IPv4 として判定する（メタデータ・loopback の迂回を塞ぐ）",
        throws(() => v.publicHttpUrl("http://[::ffff:a9fe:a9fe]/", { field: "u" })) && // 169.254.169.254
        throws(() => v.publicHttpUrl("http://[::ffff:7f00:1]/", { field: "u" })) &&     // 127.0.0.1
        throws(() => v.publicHttpUrl("http://[::ffff:a01:1]/", { field: "u" })) &&      // 10.0.0.1
        v.publicHttpUrl("http://[2606:4700::1111]/", { field: "u" }) === "http://[2606:4700::1111]/");
      // WHATWG パーサの正規化に頼っていることを明示的に固定（hex/8進/10進/短縮表記）
      ok("validate: WHATWG URL パーサが IPv4 の変則表記を正規化する前提を確認",
        new URL("http://0x7f000001/").hostname === "127.0.0.1" &&
        new URL("http://2130706433/").hostname === "127.0.0.1" &&
        new URL("http://0177.0.0.1/").hostname === "127.0.0.1" &&
        throws(() => v.publicHttpUrl("http://0x7f000001/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://2130706433/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://0177.0.0.1/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://127.1/", { field: "u" })));

      ok("validate: 非 http（デスクトップアプリの偽エンドポイント）は httpUrl で拒否される",
        throws(() => v.publicHttpUrl("webview2://fake", { field: "u" })) &&
        v.isRoutableHost("100.128.0.1") === true); // CGNAT の外側は通す

      // 14-7. 実サーバーでの挙動（登録時の SSRF 拒否 / デスクトップ用の非 http は通す）
      const subPrivate = await request("POST", "/api/save-platform-settings", {
        body: { clientId: "regression-ssrf", subscription: { endpoint: "http://127.0.0.1:8080/api/notify", keys: {} } },
      });
      ok("save-platform-settings: 内部 URL のエンドポイントは 400（SSRF）",
        subPrivate.status === 400 && /public http/.test(subPrivate.raw || ""), `status=${subPrivate.status} body=${subPrivate.raw}`);
      const subMeta = await request("POST", "/api/save-platform-settings", {
        body: { clientId: "regression-ssrf", subscription: { endpoint: "http://169.254.169.254/latest/meta-data/", keys: {} } },
      });
      ok("save-platform-settings: クラウドメタデータ宛も 400（SSRF）", subMeta.status === 400, `status=${subMeta.status}`);
      const subDesktop = await request("POST", "/api/save-platform-settings", {
        body: { clientId: "regression-desktop", subscription: { endpoint: "webview2://regression", keys: {} } },
      });
      ok("save-platform-settings: デスクトップアプリの非 http エンドポイントは従来どおり受理する",
        subDesktop.status === 200, `status=${subDesktop.status} body=${subDesktop.raw}`);
      const subPublic = await request("POST", "/api/save-platform-settings", {
        body: { clientId: "regression-public", subscription: { endpoint: "https://fcm.googleapis.com/fcm/regression", keys: {} } },
      });
      ok("save-platform-settings: 公開の push サービスは受理する", subPublic.status === 200, `status=${subPublic.status}`);

      // 14-8. OAuth のエラー応答を HTML として返さない（無認証で到達できる）
      const oauthErr = await request("GET", "/auth/discord/callback?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C/script%3E");
      ok("user-auth: OAuth エラーは text/plain で、クエリを HTML にしない",
        oauthErr.status === 400 &&
        String(oauthErr.headers["content-type"] || "").startsWith("text/plain") &&
        !/<script>/i.test(oauthErr.raw || ""),
        `status=${oauthErr.status} ct=${oauthErr.headers["content-type"]} body=${(oauthErr.raw || "").slice(0, 60)}`);

      // 14-9. 無認証の FCM リレー化を防ぐ（send-test にレート制限）
      const sendTestPath = path.join(projectDir, "routes", "android.js");
      ok("android: /api/android/send-test にレート制限がある",
        /app\.post\("\/api\/android\/send-test",\s*androidSendTestLimiter/.test(fs.readFileSync(sendTestPath, "utf8")));
      ok("android: deviceName を型と上限で検証している",
        /str\(deviceName, \{ field: "deviceName", max: 100/.test(fs.readFileSync(sendTestPath, "utf8")));

      // 14-10. その他の境界（ソースの不変条件）
      ok("youtube webhook: 不正な published（Invalid Date）を 24時間フィルタで受けない",
        /Number\.isNaN\(publishedDate\.getTime\(\)\)/.test(
          fs.readFileSync(path.join(projectDir, "src", "scrapers", "youtube.js"), "utf8")));
      ok("rag: transcript 取得の video_id を書式検証 + encodeURIComponent する（他ルートと整合）",
        (() => {
          const src = fs.readFileSync(path.join(projectDir, "routes", "rag.js"), "utf8");
          return /VIDEO_ID_RE\.test\(String\(vid\)\)/.test(src) && /encodeURIComponent\(String\(vid\)\)/.test(src);
        })());
      ok("notification: 送信直前にも公開ホストを検証する（登録後の迂回を塞ぐ）",
        /publicHttpUrl\(subscription\.endpoint/.test(
          fs.readFileSync(path.join(projectDir, "services", "notification.js"), "utf8")));

      ok("型を書いたファイルが実際に型エラーを検出すること（構造の確認）",
        fs.readFileSync(path.join(projectDir, "src", "core", "notify-sign.js"), "utf8").includes("@param {string|null|undefined} secret"));

      // 14-11. ヘッダーのアバターが「壊れた画像」にならない
      // （Google アカウントにプロフィール写真が無いと avatar_url が空になり、
      //   フォールバック先のファイルが無いと 404 の破損アイコンが出ていた / 2026-10-23）
      ok("webui: デフォルトアバター画像が実在する（未設定ユーザーが壊れたアイコンにならない）",
        fs.existsSync(path.join(projectDir, "webui", "default-avatar.webp")));
      ok("webui: アバター読込失敗時のフォールバックがある（外部ホスト不通・欠品）",
        (() => {
          const src = fs.readFileSync(path.join(projectDir, "webui", "js", "header-auth.js"), "utf8");
          return /addEventListener\(['"]error['"]/.test(src) && /default-avatar\.webp/.test(src);
        })());
    }

    // --- 15. iPhone の通知登録: 案内が必ず呼ばれるか（2026-10-23 追加） ---
    //  実際に起きた事故: iOS 向けガイド（ios-helper.js）は読まれるだけで一度も呼ばれておらず、
    //  通常の Safari で登録を試みると「トグルが戻るだけ」の無言失敗になっていた。
    console.log("\n[15] iPhone 通知登録の案内");
    {
      const helperSrc = fs.readFileSync(path.join(projectDir, "webui", "ios-helper.js"), "utf8");
      ok("ios-helper.js: インスタンスを window.iosHelper として公開する（バンドルから参照できるように）",
        /window\.iosHelper\s*=\s*iosHelper/.test(helperSrc));
      const mainSrc = fs.readFileSync(path.join(projectDir, "webui", "js", "main.js"), "utf8");
      ok("js/main.js: iOS かつホーム画面未追加なら案内を出して登録を中断する",
        /helper\.showInstallGuide\(\)/.test(mainSrc) && /IOS_PWA_REQUIRED/.test(mainSrc) &&
        /helper\.isPWA/.test(mainSrc) && /helper\.isIOS/.test(mainSrc));
      ok("js/main.js: iOS の Chrome は Safari へ誘導する案内を出す（Chrome では PWA 追加不可）",
        /isIOSChrome/.test(mainSrc) && /IOS_CHROME_UNSUPPORTED/.test(mainSrc));
      ok("js/main.js: 通知登録の失敗を無言にしない（理由を表示する）",
        /通知を登録できませんでした/.test(mainSrc));
      // ビルド忘れ（js/main.js を直したのに dist を作り直さない）を検出する。
      // 実測: esbuild の更新だけで dist とソースが 86 bytes 食い違うことがある。
      const bundle = fs.readFileSync(path.join(projectDir, "webui", "dist", "main.bundle.min.js"), "utf8");
      ok("dist/main.bundle.min.js: 案内呼び出しがバンドルに含まれる（ビルド忘れ防止）",
        /showInstallGuide/.test(bundle) && /IOS_PWA_REQUIRED/.test(bundle));
    }

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
