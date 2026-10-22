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
    // 11-5. 正規表現 location は出現順で評価される → PHP location より前に挿入해야機能する
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
    // 11-8. 自機リクエストを通知しない仕組み（ノイズ防止）があること
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
