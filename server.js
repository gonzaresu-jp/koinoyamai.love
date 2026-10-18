require("dotenv").config();
// 日時の getHours/getDay や naive 文字列の new Date() 解釈を JST に固定する
// （イベントの曜日配置・時刻表示のタイムゾーンずれ防止）
process.env.TZ = process.env.TZ || "Asia/Tokyo";
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const helmet = require("helmet");
const discordAlert = require("./src/core/discord-alert");
const MilestoneScheduler = require("./src/core/milestone");
const ctx = require("./services/context");
const { initDatabase } = require("./services/database");
const { loadVapid } = require("./services/notification");
const { startPeriodicTasks } = require("./services/scheduler");
const { updateSchedule } = require("./weekly");

const app = express();
ctx.app = app;
// 前段（nginx/cloudflared）は同一ホストの loopback から接続するため、
// trust proxy は loopback のみ信用する（LAN 直結クライアントが XFF を偽造できても無効）。
// ※ SSE の送信元キー判定（sseClientKey）もこれと同じ方針。
app.set("trust proxy", "loopback");

const dbPath = path.join(__dirname, process.env.DB_FILE_NAME || "data.db");
const db = new sqlite3.Database(dbPath);
ctx.db = db;

discordAlert.attachGlobalCrashHandlers();

updateSchedule().catch(console.error);
setInterval(() => { updateSchedule().catch(console.error); }, 5 * 60 * 1000);

// --- DB Schema ---
initDatabase();

// --- VAPID ---
loadVapid();

// --- Rate Limiters ---
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, keyGenerator: (req) => ipKeyGenerator(req), standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many API requests, please try again later." },
  // アーカイブ系は1画面で約40リクエスト（字幕/チャプターのバッジ判定）飛ぶため、グローバル制限から除外する
  skip: (req) => req.originalUrl.startsWith("/api/archive"),
});
// --- notifyLimiter defined in routes/notify.js ---

// --- Middleware ---
// HMAC 検証はパース後の JSON を作り直さず受信した生ボディで検証する（routes/notify.js）。
// キー順・空白・数値表記の違いで署名が壊れないように、各リクエストの生バイトを保持する。
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); },
}));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
// 同一オリジンの Web UI / デスクトップアプリ / ローカル開発のみ許可する、オリジン制限付き CORS。
// ブラウザは credentials 付きリクエストに `*` を許さないため、実際の送信元を echo する形にし、
// 許可外のオリジンにはヘッダーを付与しない（= ブラウザがブロックする）。
function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") ? url.origin : null;
  } catch { return null; }
}
const allowedCorsOrigins = new Set([
  (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
  "https://mai.honna-yuzuki.com",
  "https://koinoyamai.love",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:3008",
  "http://127.0.0.1:3008",
].map(normalizeOrigin).filter(Boolean));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = !!origin && allowedCorsOrigins.has(origin);
  if (allowed) {
    res.set("Access-Control-Allow-Origin", origin || "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
  next();
});
app.use(helmet({
  contentSecurityPolicy: { directives: { "default-src": ["'self'"], "script-src": ["'self'", "https://static.cloudflareinsights.com"], "style-src": ["'self'", "'unsafe-inline'"], "img-src": ["'self'", "data:", "https:"], "connect-src": ["'self'", "https:"], "font-src": ["'self'"], "frame-ancestors": ["'self'"], "form-action": ["'self'"], "base-uri": ["'self'"], "object-src": ["'none'"] } },
  strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true },
  xFrameOptions: { action: "deny" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));
app.use("/pushweb", express.static(path.join(__dirname, "pushweb")));
// /admin 配下は認証コードのソース漏えい防止のため login.html のみ配信（admin.js 等は lib/ へ移動済み）。
// ※ nginx の alias も同ディレクトリを直接配信するため、JS は admin/ 外に置くこと。
app.get("/admin/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "login.html"));
});
app.use("/webui", express.static(path.join(__dirname, "webui")));

// --- CSRF Protection ---
app.use("/api/", (req, res, next) => {
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const requestOrigin = normalizeOrigin(process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`);
    const sourceOrigin = normalizeOrigin(origin || referer);
    if (sourceOrigin && sourceOrigin !== requestOrigin) return res.status(403).json({ error: "CSRF token mismatch or unauthorized origin" });
  }
  next();
});

// --- SSE endpoint ---
// ※ apiLimiter より前に登録する。ストリーム接続が通常 API のレート制限
//   （300回/分/IP）を消費し、ヒートマップ/ステータス等を 429 で殺さないため。
// SSE保護: 全体/同一送信元ごとの接続数上限・接続寿命の上限を設ける。
// 送信元キーは信頼できる前段(nginx/cloudflared)からの接続のみ X-Forwarded-For の
// 末尾要素（= 実クライアントIP）を使い、直接接続は TCP ピアアドレスを使う。
// （XFF は直結クライアントには偽造可能なため、前段経由以外では参照しない）
const SSE_MAX_CLIENTS = Math.max(1, parseInt(process.env.SSE_MAX_CLIENTS, 10) || 500);
const SSE_MAX_PER_CLIENT = Math.max(1, parseInt(process.env.SSE_MAX_PER_CLIENT, 10) || 5);
const SSE_MAX_AGE_MS = Math.max(60 * 1000, parseInt(process.env.SSE_MAX_AGE_MS, 10) || 30 * 60 * 1000);
const SSE_HEARTBEAT_MS = Math.max(5000, parseInt(process.env.SSE_HEARTBEAT_MS, 10) || 25000);
const sseConnectionCounts = new Map();

function sseClientKey(req) {
  const peer = req.socket?.remoteAddress || "unknown";
  const isLocalProxy = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (isLocalProxy) {
    const xff = String(req.headers["x-forwarded-for"] || "");
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    return "xff:" + (parts.length ? parts[parts.length - 1] : peer);
  }
  return "peer:" + peer;
}

function sseTrackAdd(key) {
  const n = (sseConnectionCounts.get(key) || 0) + 1;
  sseConnectionCounts.set(key, n);
  return n;
}

function sseTrackRemove(key) {
  const n = (sseConnectionCounts.get(key) || 1) - 1;
  if (n <= 0) sseConnectionCounts.delete(key);
  else sseConnectionCounts.set(key, n);
}

function sseHandler(req, res) {
  const sseOrigin = req.headers.origin;
  const sseHost = req.get("host");
  const sseSameOrigin = !!sseOrigin && !!sseHost && (sseOrigin === `http://${sseHost}` || sseOrigin === `https://${sseHost}`);
  const sseAllowed = sseSameOrigin || allowedCorsOrigins.has(sseOrigin);
  const acao = sseAllowed ? (sseOrigin || "*") : undefined;

  const clientKey = sseClientKey(req);
  if (ctx.sseClients.size >= SSE_MAX_CLIENTS || (sseConnectionCounts.get(clientKey) || 0) >= SSE_MAX_PER_CLIENT) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "30", ...(acao ? { "Access-Control-Allow-Origin": acao } : {}) });
    res.end(JSON.stringify({ error: "Too many stream connections, please retry later." }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    // nginx のバッファリングを無効化（ハートビート即時到達・ゾンビ検出のため）
    "X-Accel-Buffering": "no",
    ...(acao ? { "Access-Control-Allow-Origin": acao } : {}),
  });
  res.write(": connected\n\n");
  res.write(`retry: 5000\n\n`);
  ctx.sseClients.add(res);
  sseTrackAdd(clientKey);

  let done = false;
  let heartbeatTimer = null;
  let lifetimeTimer = null;
  function cleanup() {
    if (done) return;
    done = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    ctx.sseClients.delete(res);
    sseTrackRemove(clientKey);
    try { res.end(); } catch {}
  }

  // ハートビート: 無通信で tunnel/nginx に切られてもサーバ側カウントを正し、
  // 死んだ接続の書き込み失敗で即 cleanup して枠を返す。
  heartbeatTimer = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { cleanup(); }
  }, SSE_HEARTBEAT_MS);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

  lifetimeTimer = setTimeout(cleanup, SSE_MAX_AGE_MS);
  if (typeof lifetimeTimer.unref === "function") lifetimeTimer.unref();

  req.on("close", cleanup);
  res.on("error", cleanup);
}

// 旧パス /api/history/stream はフロントの古いキャッシュ JS がまだ叩くため alias で受ける
app.get(["/api/events/stream", "/api/history/stream"], sseHandler);

app.use("/api/", apiLimiter);

// アーカイブAPI専用のリミッタ（上流はローカル・キャッシュ/サーキットブレーカー付きなので緩めに）
// 1画面のバッジ判定で最大 ~40リクエスト/人 になることを考慮
const archiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many archive API requests, please try again later." },
});
app.use("/api/archive", archiveLimiter);

// --- User routes (existing module) ---
const userRoutes = require("./src/core/user-routes");
userRoutes.register(app, db, authLimiter);

// --- All other route modules ---
require("./routes/subscriptions").register(app, db);
require("./routes/android").register(app, db);
require("./routes/events").register(app, db);
require("./routes/admin").register(app, db);
require("./routes/admin-archive").register(app, db);
  require("./routes/admin-twitter-stats").register(app, db);
require("./routes/scraper-status").register(app, db);
require("./routes/system").register(app);
require("./routes/ai-usage").register(app, db);
require("./routes/history").register(app, db);
require("./routes/notify").register(app, db);
require("./routes/twitter-media").register(app, db);
require("./routes/rag").register(app, db);
require("./routes/archive").register(app);
// --- テスト環境フラグ（staging: NODE_ENV=development で定期タスク等を停止） ---
const isTestInstance = process.env.NODE_ENV === "development";

// --- Milestone Scheduler ---
if (ctx.vapidConfig.vapidPublicKey !== "test-key" && !isTestInstance) {
  ctx.milestoneScheduler = new MilestoneScheduler(dbPath, ctx.vapidConfig);
  ctx.milestoneScheduler.start();
} else {
  console.log("Milestone notifications disabled (no VAPID)");
}

// --- Periodic Tasks --- (テスト環境では定期タスク・ベクトル同期・マイルストーン通知を停止)
if (isTestInstance) console.log("[staging] periodic/vector/milestone tasks skipped (test instance)");
else startPeriodicTasks();

// --- アーカイブ上流(.70:8766)のヘルスを定期監視（サーキットブレーカー用） ---
const archiveRoutes = require("./routes/archive");
setInterval(() => { archiveRoutes.refreshHealth().catch(() => {}); }, 20000);

// --- ベクトルDB同期（VECTOR_DB_URL / EMBEDDING_ENDPOINT 設定時のみ稼働・テスト環境では停止） ---
if (!isTestInstance) require("./services/vector-sync").startVectorSync();

// --- System Monitor ---
discordAlert.startSystemMonitor();

// --- Test page (served from webui/test.php) ---
app.get(["/test", "/test/"], (req, res) => {
  const webuiDir = path.join(__dirname, "webui");
  const testPath = path.join(webuiDir, "test.php");
  const exists = fs.existsSync(testPath);
  if (!exists) return res.status(404).send("test.php not found");
  let html = fs.readFileSync(testPath, "utf-8");
  html = html.replace(/<\?php\s+include\s+__DIR__\s+\.\s+'([^']+)'\s*;?\s*\?>/g, (_, inc) => {
    try { return fs.readFileSync(path.join(webuiDir, inc), "utf-8"); } catch { return ""; }
  });
  html = html.replace(/<\?[\s\S]*?\?>/g, "");
  res.type("html").send(html);
});

// --- Health check ---
app.get("/api/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    pid: process.pid,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + "MB",
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + "MB",
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + "MB",
    },
    port: Number(process.env.PORT || 8080),
    node: process.version,
  });
});

app.get("/api/health/live", (req, res) => {
  res.status(200).type("text/plain").send("ok");
});

app.get("/api/health/ready", (req, res) => {
  res.status(200).type("text/plain").send("ready");
});

// --- Start ---
const PORT = process.env.PORT || 8080;
// 前段は nginx/cloudflared 経由の loopback 接続のみ。LAN・外部への直接公開を避けるため loopback に限定。
// （YouTube PubSubHubbub 用の 3001 だけは外部フックのため main.js 側で 0.0.0.0 のまま）
app.listen(PORT, "127.0.0.1", () => {
  console.log(`WebUI Server is running on port ${PORT}`);
});
