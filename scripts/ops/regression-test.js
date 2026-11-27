#!/usr/bin/env node
/**
 * sqlite3@6 昇格前の回帰テスト（SECURITY_HANDOFF / AGENTS.md 手順に基づく）
 *
 * 使い方:
 *   node scripts/ops/regression-test.js [--port 18099] [--only 9,17]
 *
 * 構成:
 *   - 本ファイルはランナー（サーバー起動・セクション実行・後片付け）。
 *   - 検査本体は scripts/ops/regression/NN-*.js（NN = 回帰テスト [N] の番号）。
 *   - --only でセクション番号を指定すると、その番号だけ実行する（サーバーは常に起動する）。
 *   - 1 セクションで例外が出ても残りのセクションは続けて実行する。
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
const path = require("path");

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

// --- セクション（scripts/ops/regression/NN-*.js）---
// 各ファイルは { id, run(ctx) } を export する。番号は AGENTS.md・更新履歴の「回帰テスト [N]」と共通。
const SECTIONS_DIR = path.join(__dirname, "regression");
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0
  ? new Set(String(args[onlyIdx + 1] || "").split(",").map((s) => Number(s.trim())).filter(Number.isInteger))
  : null;

function loadSections() {
  return fs.readdirSync(SECTIONS_DIR)
    .filter((f) => /^\d{2}-.+\.js$/.test(f))
    .sort()
    .map((f) => require(path.join(SECTIONS_DIR, f)));
}

async function main() {
  const projectDir = path.resolve(__dirname, "../..");
  const sections = loadSections().filter((s) => !ONLY || ONLY.has(s.id));
  if (ONLY && sections.length === 0) {
    console.error(`[regression-test] --only ${args[onlyIdx + 1] || ""} に一致するセクションがありません`);
    process.exit(2);
  }
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

  const ctx = {
    ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth,
    projectDir, child, TOKEN, HMAC_SECRET, DB_NAME,
    sseHandles: [],
  };
  try {
    // [1] を飛ばしても、サーバーを使うセクションが起動前に走らないようにする
    if (!sections.some((s) => s.id === 1)) await waitForHealth(child);
    for (const s of sections) {
      try {
        await s.run(ctx);
      } catch (e) {
        // 1 セクションの例外で残りを止めない（失敗箇所を特定しやすくする）
        failed++;
        console.error(`\n[regression-test] [${s.id}] 例外:`, e && e.message ? e.message : e);
        if (s.id === 1) break; // サーバーが起動しないなら以降は無意味
      }
    }

    console.log(`\n結果: ${passed} passed, ${failed} failed`);
  } catch (e) {
    failed++;
    console.error("\n[regression-test] 例外:", e && e.message ? e.message : e);
  } finally {
    for (const h of ctx.sseHandles) { try { h.res.destroy(); } catch (_) {} }
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
