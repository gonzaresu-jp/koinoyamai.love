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
 *   - ログは日次ローテートされる（`rotate 14` / `delaycompress`）ため、
 *     **`honey.log.1` と `honey.log.N.gz` も読む**（現行ファイルだけだと 7/30/90 日指定が
 *     実質 24 時間になる）。
 *   - 自機テスト（`ip=127.0.0.1` かつ `cf=-` かつ `xff=-`）は除外する（watcher と同じ規則）。
 *   - 国・ASN・組織名は `services/geoip.js`（Team Cymru の DNS）で解決してキャッシュする。
 *
 * 分類（watcher と同じ意味）:
 *   - `canary_used`: 偽物に埋め込んだ追跡 URL（`/_canary/<token>`）へのアクセス＝窃取確定。
 *     **ローテート前の token（`previousCanaryPaths`）も同じ**（watcher と揃える）。
 *   - `stolen`     : 偽物が 200 で取得された
 *   - `probe`      : それ以外（404 の偵察・204 の `/_canary/` 探査など）
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const geoip = require("./geoip");

const LOG_PATH = process.env.HONEY_LOG_PATH || "/var/log/nginx/honey.log";
const CANARY_STATE = process.env.HONEY_CANARY_STATE
  || path.join(__dirname, "..", "data", "honeypot-canary.json");
const MAX_FILES = 16; // 現行 + .1 ... （logrotate は rotate 14）
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 20000;
const MAX_UA_CHARS = 500;
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
// `uri` は `$uri`（デコード済み）なので実空白を含み得る → ` bytes=` の手前までを取る。
const PREFIX_RE = /^(\S+) ip=(\S+) cf=(\S+) xff="((?:[^"\\]|\\.)*)" st=(\d{3}) uri=(.+?) bytes=(\d+) /;
const UA_RE = /\bua="((?:[^"\\]|\\.)*)"\s*$/;

/**
 * nginx のログエスケープを戻す。
 * `escape=default` では `"` や制御文字が `\xHH` になる（`\"` 形式でも来る）。
 */
function unescapeLogValue(s) {
  return String(s || "")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

/** honeyfmt の 1 行をパースする（パースできなければ null） */
function parseLine(line) {
  const m = PREFIX_RE.exec(line);
  if (!m) return null;
  const ua = UA_RE.exec(line);
  let pathname = m[6];
  try { pathname = decodeURIComponent(pathname); } catch (e) { /* 生のまま */ }
  const clip = (s) => (s.length > MAX_UA_CHARS ? s.slice(0, MAX_UA_CHARS) + "…" : s);
  return {
    time: m[1],
    remote: m[2],
    cf: m[3],
    xff: unescapeLogValue(m[4]),
    status: Number(m[5]),
    path: pathname,
    bytes: Number(m[7]),
    ua: clip(unescapeLogValue(ua ? ua[1] : "")),
  };
}

/** ローテート済み（`.1`, `.2.gz`, …）を含むログファイル一覧を**古い順**で返す */
function expandLogFiles(base) {
  const out = [];
  for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
    for (const cand of [`${base}.${i}.gz`, `${base}.${i}`]) {
      if (fs.existsSync(cand)) { out.push(cand); break; }
    }
  }
  out.push(base);
  return out;
}

/**
 * 1 ファイル読む。巨大な現行ログは末尾だけ読む。
 * @returns {{text: string, partial: boolean}|null}
 */
function readOneFile(file, st, maxBytes) {
  try {
    if (file.endsWith(".gz")) {
      if (st.size > maxBytes) return null; // 圧縮ファイルは先頭から解凍する必要があるため上限で諦める
      const text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
      return { text, partial: false };
    }
    const bytes = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(bytes);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, bytes, st.size - bytes);
    } finally {
      fs.closeSync(fd);
    }
    return { text: buf.toString("utf8"), partial: bytes < st.size };
  } catch (e) {
    return null;
  }
}

function readCanaryPaths(file) {
  try {
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = [];
    if (st && st.canaryPath) list.push(String(st.canaryPath));
    if (st && Array.isArray(st.previousCanaryPaths)) {
      for (const p of st.previousCanaryPaths) if (p) list.push(String(p));
    }
    return [...new Set(list)].filter((p) => p.startsWith("/_canary/"));
  } catch (e) {
    return [];
  }
}

/** 追跡 URL の token は UI に出さない（スクショ共有時に漏れないように） */
function maskCanary(pathname) {
  return String(pathname || "").replace(/^\/_canary\/[^/]+/, "/_canary/***");
}

function classify(pathname, status, canaryPaths) {
  for (const cp of canaryPaths || []) {
    if (pathname.startsWith(cp)) return "canary_used";
  }
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

// ログのパース結果キャッシュ（60 秒ごとの再取得で毎回 20k 行を読み直さない）。
// key = ファイル群の (path,size,mtime) + canary パス。
let parseCache = null;

function cacheKey(files, canaryPaths) {
  const sig = files.map((f) => {
    try {
      const st = fs.statSync(f);
      return `${f}:${st.size}:${st.mtimeMs}`;
    } catch (e) {
      return `${f}:0:0`;
    }
  }).join("|");
  return `${sig}||${canaryPaths.join(",")}`;
}

/** ログファイル群を読み、**期間フィルタ前**のイベント一覧を返す（キャッシュあり） */
function loadAll(logPath, canaryPaths) {
  const files = expandLogFiles(logPath);
  const key = cacheKey(files, canaryPaths);
  if (parseCache && parseCache.key === key) return parseCache;

  const chunks = [];
  let present = false;
  let totalBytes = 0;
  let firstPartial = false;
  for (const f of files) {
    let st = null;
    try { st = fs.statSync(f); } catch (e) { continue; }
    if (!st.isFile() || st.size === 0) continue;
    present = true;
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const got = readOneFile(f, st, MAX_TOTAL_BYTES - totalBytes);
    if (!got) continue;
    totalBytes += got.text.length;
    if (chunks.length === 0 && got.partial) firstPartial = true;
    chunks.push(got.text);
  }

  let lines = chunks.join("\n").split("\n");
  if (firstPartial && lines.length) lines = lines.slice(1); // 先頭は途中で切れている
  lines = lines.filter(Boolean);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);

  let selfTests = 0;
  let skipped = 0;
  const events = [];
  for (const line of lines) {
    const e = parseLine(line);
    if (!e) { skipped += 1; continue; }
    // 自機（運用者）のテストは通知・集計の対象外（ログには残る）
    if (e.remote === "127.0.0.1" && e.cf === "-" && e.xff === "-") { selfTests += 1; continue; }
    const t = Date.parse(e.time);
    if (!Number.isFinite(t)) { skipped += 1; continue; }
    const ip = e.cf && e.cf !== "-" ? e.cf : e.remote; // 表示は Cloudflare 経由なら cf=（実クライアント）
    const pathname = String(e.path || "").split("?")[0];
    events.push({
      t,
      time: e.time,
      ip,
      kind: classify(pathname, e.status, canaryPaths),
      status: e.status,
      path: pathname,
      canaryScan: pathname.startsWith("/_canary/") &&
        !canaryPaths.some((cp) => pathname.startsWith(cp)),
      ua: e.ua,
    });
  }

  parseCache = { key, present, events, selfTests, skipped, lines: lines.length };
  return parseCache;
}

/**
 * ハニーポットの集計を返す（HTTP を介さない＝テスト可能）。
 *
 * @param {object} [opts]
 * @param {number} [opts.days]
 * @param {string} [opts.logPath]
 * @param {string} [opts.canaryStatePath]
 * @param {number} [opts.now]
 * @param {(ips: string[], options?: object) => Promise<Map<string, object>>} [opts.geoLookup] テスト用に差し替え可
 */
async function collect(opts) {
  const o = opts || {};
  const days = clampDays(o.days);
  const now = Number(o.now) || Date.now();
  const from = now - days * 86400000;
  const canaryPaths = readCanaryPaths(o.canaryStatePath || CANARY_STATE);
  const all = loadAll(o.logPath || LOG_PATH, canaryPaths);
  const events = all.events.filter((e) => e.t >= from);

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

  // 日別は「期間の全日」を 0 埋めで返す（グラフの形を安定させる）。
  // 起点は from の属する日（= 7 日指定で 8 日分になり得るが、**データを隠さない**方を優先）。
  const startDay = jstDate(from);
  const endDay = jstDate(now);
  for (let t = Date.parse(`${startDay}T00:00:00+09:00`); jstDate(t) <= endDay; t += 86400000) {
    const d = jstDate(t);
    if (!byDay.has(d)) byDay.set(d, { date: d, ...emptyBucket() });
    if (byDay.size > MAX_DAYS + 1) break;
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
      logPresent: all.present,
      logLines: all.lines,
      selfTests: all.selfTests,
      skipped: all.skipped,
      events: events.length,
      firstSeen: times.length ? new Date(Math.min(...times)).toISOString() : null,
      lastSeen: times.length ? new Date(Math.max(...times)).toISOString() : null,
    },
    totals: {
      ...totals,
      ips: byIp.size,
      // 「国数」は国コードが分かったものだけ（不明を国として数えない）
      countries: countries.filter((c) => c.cc).length,
      canaryConfigured: canaryPaths.length > 0,
    },
    byCountry: countries,
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    topIps,
    topPaths,
    recent,
    note: "国・ASN・組織名は Team Cymru の DNS で解決（成功 30 日 / 不明 1 時間キャッシュ）。" +
      "自機テスト（127.0.0.1 かつ Cloudflare ヘッダ無し）は除外。",
  };
}

module.exports = {
  collect, parseLine, classify, clampDays, readCanaryPaths, expandLogFiles, loadAll, maskCanary,
};
