"use strict";
/**
 * services/honeypot-report.js — ハニーポットの集計（HTTP 非依存・テスト可能）
 *
 * なぜ `services/` に置くか:
 *   - 集計ロジックを `routes/` に置くと、テストで require した時に
 *     `lib/admin.js`（セッション掃除の setInterval を持つ）まで読み込んでしまい、
 *     テストプロセスが終了しなくなる。
 *   - HTTP（認証・ルーティング）は `routes/admin-honeypot.js` 側に分離する。
 *
 * 公開範囲:
 *   - 攻撃元の **IP・UA・国** は公開エンドポイントに出さない（AGENTS.md §5.3）。
 *     公開ページに出してよいのは「カテゴリと件数」だけ。
 *   - この集計は `/api/admin/honeypot`（`/api/admin/` 配下＝公開ドメインでは nginx が 403
 *     ＋ `requireAuth`）からのみ返す。
 *
 * データ源: `/var/log/nginx/honey.log`（ハニー location 専用のログ）
 *   - ハニー location だけがこのログに書くので、ここにある行は**すべてハニーへのアクセス**。
 *   - 自機テスト（`ip=127.0.0.1` かつ `cf=-` かつ `xff=-`）は除外する（watcher と同じ規則）。
 *   - 国・ASN・組織名は `services/geoip.js`（Team Cymru の DNS）で解決してキャッシュする。
 *
 * 分類（watcher と同じ意味）:
 *   - `canary_used`: 偽物に埋め込んだ追跡 URL（`/_canary/<token>`）へのアクセス＝窃取確定
 *   - `stolen`     : 偽物が 200 で取得された
 *   - `probe`      : それ以外（404 の偵察・204 の `/_canary/` 探査など）
 */

const fs = require("fs");
const path = require("path");
const geoip = require("./geoip");

const LOG_PATH = process.env.HONEY_LOG_PATH || "/var/log/nginx/honey.log";
const CANARY_STATE = process.env.HONEY_CANARY_STATE
  || path.join(__dirname, "..", "data", "honeypot-canary.json");
const MAX_LINES = 20000;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const RECENT_LIMIT = 200;
const TOP_IPS = 20;
const TOP_PATHS = 15;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
// 大量の攻撃元 IP でも API が DNS 待ちで固まらないための上限（未解決分は次の取得で埋まる）
const MAX_GEO_IPS = 500;
const GEO_BUDGET_MS = 3000;

// 固定フィールドは UA より前にある。**先頭から固定順に**読むことで、
// UA に `st=500` などを紛れ込ませたログでも騙されない（watcher と同じ考え方）。
const PREFIX_RE = /^(\S+) ip=(\S+) cf=(\S+) xff="((?:[^"\\]|\\.)*)" st=(\d{3}) uri=(\S+) bytes=(\d+) /;
const UA_RE = /\bua="((?:[^"\\]|\\.)*)"\s*$/;

function unescapeLogValue(s) {
  return String(s || "").replace(/\\(.)/g, "$1");
}

/** honeyfmt の 1 行をパースする（パースできなければ null） */
function parseLine(line) {
  const m = PREFIX_RE.exec(line);
  if (!m) return null;
  const ua = UA_RE.exec(line);
  let pathname = m[6];
  try { pathname = decodeURIComponent(pathname); } catch (e) { /* 生のまま */ }
  return {
    time: m[1],
    remote: m[2],
    cf: m[3],
    xff: unescapeLogValue(m[4]),
    status: Number(m[5]),
    path: pathname,
    bytes: Number(m[7]),
    ua: unescapeLogValue(ua ? ua[1] : ""),
  };
}

/** ログの末尾を最大 maxLines 行読む（巨大化しても全体をメモリに載せない） */
function readTail(file, maxLines) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return { lines: [], present: false };
    const bytes = Math.min(st.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(bytes);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, bytes, st.size - bytes);
    } finally {
      fs.closeSync(fd);
    }
    let lines = buf.toString("utf8").split("\n").filter(Boolean);
    if (bytes < st.size) lines = lines.slice(1); // 先頭は途中で切れている
    return { lines: lines.slice(-maxLines), present: true };
  } catch (e) {
    return { lines: [], present: false, error: e.code || e.message };
  }
}

function readCanaryPath(file) {
  try {
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    const p = String((st && (st.canaryPath || st.canary_path)) || "");
    return p.startsWith("/_canary/") ? p : null;
  } catch (e) {
    return null;
  }
}

/** 追跡 URL の token は UI に出さない（スクショ共有時に漏れないように） */
function maskCanary(pathname) {
  return String(pathname || "").replace(/^\/_canary\/[^/]+/, "/_canary/***");
}

function classify(pathname, status, canaryPath) {
  if (canaryPath && pathname.startsWith(canaryPath)) return "canary_used";
  if (status === 200) return "stolen";
  return "probe";
}

function clampDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.round(n)));
}

function jstDate(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function emptyBucket() {
  return { events: 0, stolen: 0, canaryUsed: 0, probe: 0 };
}

// kind は `canary_used`（スネーク）だが、集計キーは `canaryUsed`（キャメル）。
// 直接 `obj[kind] += 1` すると別キーが生えて 0 のままになる（テストで検出済み）。
function bump(bucket, kind) {
  if (kind === "canary_used") bucket.canaryUsed += 1;
  else if (kind === "stolen" || kind === "probe") bucket[kind] += 1;
  else bucket.probe += 1;
}

/**
 * ハニーポットの集計を返す（HTTP を介さない＝テスト可能）。
 *
 * @param {object} [opts]
 * @param {number} [opts.days]
 * @param {string} [opts.logPath]
 * @param {string} [opts.canaryStatePath]
 * @param {number} [opts.now]
 * @param {(ips: string[]) => Promise<Map<string, object>>} [opts.geoLookup] テスト用に差し替え可
 */
async function collect(opts) {
  const o = opts || {};
  const days = clampDays(o.days);
  const now = Number(o.now) || Date.now();
  const from = now - days * 86400000;
  const canaryPath = readCanaryPath(o.canaryStatePath || CANARY_STATE);
  const log = readTail(o.logPath || LOG_PATH, MAX_LINES);

  let selfTests = 0;
  let skipped = 0;
  const events = [];
  for (const line of log.lines) {
    const e = parseLine(line);
    if (!e) { skipped += 1; continue; }
    // 自機（運用者）のテストは通知・集計の対象外（ログには残る）
    if (e.remote === "127.0.0.1" && e.cf === "-" && e.xff === "-") { selfTests += 1; continue; }
    const t = Date.parse(e.time);
    if (!Number.isFinite(t) || t < from) continue;
    const ip = e.cf && e.cf !== "-" ? e.cf : e.remote; // 表示は Cloudflare 経由なら cf=（実クライアント）
    const pathname = String(e.path || "").split("?")[0];
    events.push({
      t,
      time: e.time,
      ip,
      kind: classify(pathname, e.status, canaryPath),
      status: e.status,
      path: pathname,
      canaryScan: pathname.startsWith("/_canary/") && !(canaryPath && pathname.startsWith(canaryPath)),
      ua: e.ua,
    });
  }

  // 出現回数の多い IP から引く（上限に当たっても重要なものが先に解決される）
  const ipFreq = new Map();
  for (const e of events) ipFreq.set(e.ip, (ipFreq.get(e.ip) || 0) + 1);
  const ipsByFreq = [...ipFreq.entries()].sort((a, b) => b[1] - a[1]).map(([ip]) => ip);
  const geoLookup = typeof o.geoLookup === "function" ? o.geoLookup : geoip.lookupMany;
  const geo = await geoLookup(ipsByFreq, { limit: MAX_GEO_IPS, budgetMs: GEO_BUDGET_MS });
  const geoOf = (ip) => geo.get(ip) || { cc: null, country: "不明", asn: null, org: null, ok: false };
  const where = (ip) => {
    const g = geoOf(ip);
    return { cc: g.cc || null, country: g.country || "不明", asn: g.asn || null, org: g.org || null };
  };

  // --- 集計 ---
  const totals = { events: events.length, stolen: 0, canaryUsed: 0, probe: 0, canaryScans: 0 };
  const byCountry = new Map();
  const byIp = new Map();
  const byPath = new Map();
  const byDay = new Map();

  for (const e of events) {
    const g = where(e.ip);
    const cc = g.cc || "??";
    bump(totals, e.kind);
    if (e.canaryScan) totals.canaryScans += 1;

    let c = byCountry.get(cc);
    if (!c) {
      c = { cc: g.cc || null, country: g.country || "不明", ...emptyBucket(), ips: new Set(), orgs: new Map() };
      byCountry.set(cc, c);
    }
    c.events += 1;
    bump(c, e.kind);
    c.ips.add(e.ip);
    if (g.org) c.orgs.set(g.org, (c.orgs.get(g.org) || 0) + 1);

    let i = byIp.get(e.ip);
    if (!i) {
      i = { ip: e.ip, ...g, ...emptyBucket(), first: e.time, last: e.time };
      byIp.set(e.ip, i);
    }
    i.events += 1;
    bump(i, e.kind);
    if (e.t < Date.parse(i.first)) i.first = e.time;
    if (e.t > Date.parse(i.last)) i.last = e.time;

    let p = byPath.get(e.path);
    if (!p) { p = { path: e.path, events: 0, stolen: 0, canaryUsed: 0, probe: 0 }; byPath.set(e.path, p); }
    p.events += 1;
    bump(p, e.kind);

    const d = jstDate(e.t);
    let day = byDay.get(d);
    if (!day) { day = { date: d, ...emptyBucket() }; byDay.set(d, day); }
    day.events += 1;
    bump(day, e.kind);
  }

  // 日別は「期間の全日」を 0 埋めで返す（グラフの形を安定させる）
  for (let k = days - 1; k >= 0; k -= 1) {
    const d = jstDate(now - k * 86400000);
    if (!byDay.has(d)) byDay.set(d, { date: d, ...emptyBucket() });
  }

  const countries = [...byCountry.values()]
    .map((c) => ({
      cc: c.cc,
      country: c.country,
      events: c.events,
      stolen: c.stolen,
      canaryUsed: c.canaryUsed,
      probe: c.probe,
      ips: c.ips.size,
      orgs: [...c.orgs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([org, n]) => ({ org, n })),
    }))
    .sort((a, b) => b.events - a.events || String(a.cc).localeCompare(String(b.cc)));

  const topIps = [...byIp.values()]
    .sort((a, b) => b.events - a.events)
    .slice(0, TOP_IPS);

  const topPaths = [...byPath.values()]
    .sort((a, b) => b.events - a.events)
    .slice(0, TOP_PATHS)
    .map((p) => ({ ...p, path: maskCanary(p.path) }));

  const recent = events
    .slice()
    .sort((a, b) => b.t - a.t)
    .slice(0, RECENT_LIMIT)
    .map((e) => ({
      time: e.time,
      ip: e.ip,
      ...where(e.ip),
      kind: e.kind,
      status: e.status,
      path: maskCanary(e.path),
      ua: e.ua,
    }));

  const times = events.map((e) => e.t);
  return {
    ok: true,
    days,
    generatedAt: new Date(now).toISOString(),
    source: {
      logPresent: log.present,
      logLines: log.lines.length,
      selfTests,
      skipped,
      events: events.length,
      firstSeen: times.length ? new Date(Math.min(...times)).toISOString() : null,
      lastSeen: times.length ? new Date(Math.max(...times)).toISOString() : null,
    },
    totals: {
      ...totals,
      ips: byIp.size,
      countries: countries.length,
      canaryConfigured: !!canaryPath,
    },
    byCountry: countries,
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    topIps,
    topPaths,
    recent,
    note: "国・ASN・組織名は Team Cymru の DNS で解決（成功 30 日 / 不明 1 日キャッシュ）。" +
      "自機テスト（127.0.0.1 かつ Cloudflare ヘッダ無し）は除外。",
  };
}

module.exports = { collect, parseLine, classify, clampDays, readTail, maskCanary };
