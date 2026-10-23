"use strict";
/**
 * services/geoip.js — IP → 国 / ASN / 組織名（DNS ベース・追加 DB 不要）
 *
 * なぜ DNS か:
 *   - このホストには GeoLite2 / DB-IP の mmdb も `geoiplookup` / `mmdblookup` も無い。
 *     mmdb を置くにはライセンスキーか月次ダウンロードの運用が要る。
 *   - Team Cymru の IP→ASN サービス（`<rev>.origin.asn.cymru.com` / `AS<asn>.asn.cymru.com`、
 *     IPv6 は `<nibbles>.origin6.asn.cymru.com`）は DNS TXT だけで
 *     **国（ISO 2 文字）・ASN・組織名** が引ける（登録不要・追加パッケージ不要）。
 *   - 外部の HTTP API に攻撃元 IP を送らない（DNS クエリのみ）。
 *
 * キャッシュ:
 *   - `data/geoip-cache.json`（gitignore 済み）。成功 30 日 / 失敗（不明）1 時間。
 *     失敗を長く持つと、DNS の一時障害で 1 日中「不明」のままになる。
 *   - アトミックに書く（壊れると全件引き直しになるため）。
 *   - 同じ IP の並行ルックアップは in-flight でまとめる。
 *
 * 失敗時は **fail-soft**（`cc: null` を返す）。ダッシュボードを壊さない。
 *
 * 型検査: TypeScript を入れずに `// @ts-check` + JSDoc で行う（2026-10-23 追加）。
 * ビルドステップを増やさずに、編集時とエージェントに型を伝えるため。
 */

// @ts-check
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;

const CACHE_FILE = process.env.GEOIP_CACHE_FILE
  || path.join(__dirname, "..", "data", "geoip-cache.json");
const OK_TTL_MS = 30 * 24 * 3600 * 1000;
const NG_TTL_MS = 3600 * 1000;
const TIMEOUT_MS = Number(process.env.GEOIP_TIMEOUT_MS) > 0
  ? Number(process.env.GEOIP_TIMEOUT_MS)
  : 1200;
const BUDGET_MS = Number(process.env.GEOIP_BUDGET_MS) > 0
  ? Number(process.env.GEOIP_BUDGET_MS)
  : 3000;
const CONCURRENCY = 5;
const CACHE_LIMIT = 5000;
const LOOKUP_LIMIT = 500;

/**
 * IP 1 件ぶんの解決結果（`at` はキャッシュ作成時刻）。
 * @typedef {object} GeoInfo
 * @property {string|null} cc    ISO 3166-1 alpha-2（不明は null）
 * @property {string} country    日本語の国名（不明は「不明」/ ローカルは「ローカル」）
 * @property {string|null} asn   "AS396982" 形式
 * @property {string|null} org   組織名（Team Cymru の最終フィールド）
 * @property {boolean} ok        国が判明したか
 * @property {boolean} [private] ローカル/私有アドレス（問い合わせしていない）
 * @property {number} [at]       解決時刻（UNIX ms）
 */

/** @type {Record<string, GeoInfo>|null} */
let cache = null;
/** @type {Map<string, Promise<GeoInfo>>} */
const inflight = new Map();
/** @type {Intl.DisplayNames|null} */
let displayNames = null;

function loadCache() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    cache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) { /* キャッシュは best-effort（失敗しても問い合わせは続く） */ }
}

// 1 IP ごとに全キャッシュ（最大 5000 件）を同期フルライトすると、API のイベントループ
// （通知と同居）を塞ぐ。1 秒に 1 回へ間引く（プロセスが落ちたら書き込みは失われるだけ）。
let saveTimer = null;
function saveCacheSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCache();
  }, 1000);
  if (saveTimer.unref) saveTimer.unref();
}

function pruneCache() {
  const keys = Object.keys(cache);
  if (keys.length <= CACHE_LIMIT) return;
  keys
    .sort((a, b) => (Number(cache[a] && cache[a].at) || 0) - (Number(cache[b] && cache[b].at) || 0))
    .slice(0, keys.length - CACHE_LIMIT)
    .forEach((k) => { delete cache[k]; });
}

/** ローカル/私有アドレスは引かない（Tailscale・LAN・ループバック等） */
/**
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  const s = String(ip || "").toLowerCase();
  if (/^10\./.test(s) || /^127\./.test(s) || /^192\.168\./.test(s) || /^169\.254\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  // CGNAT / Tailscale (100.64.0.0/10)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true;
  if (s === "::1" || /^fe80:/.test(s) || /^f[cd][0-9a-f]{2}:/.test(s)) return true;
  // IPv4-mapped (::ffff:127.0.0.1 等) は IPv4 側の判定に委ねる
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

/** @param {*} s @returns {boolean} */
function isIPv4(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || ""));
}

/** @param {*} s @returns {boolean} */
function isIPv6(s) {
  const v = String(s || "");
  return v.includes(":") && /^[0-9a-f:.]+$/i.test(v.replace(/%.*$/, ""));
}

/** IPv6 を 8 グループに展開して 32 桁の nibble 文字列にする（失敗は null） */
/**
 * @param {string} ip
 * @returns {string|null} 32 文字の nibble 列（不正は null）
 */
function ipv6Nibbles(ip) {
  let s = String(ip || "").toLowerCase().replace(/%.*$/, "");
  if (s.includes(".")) {
    const idx = s.lastIndexOf(":");
    const v4 = s.slice(idx + 1).split(".").map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, idx + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (tail === undefined && h.length !== 8)) return null;
  const groups = [...h, ...Array(missing).fill("0"), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0")).join("");
}

/**
 * Team Cymru に問い合わせる DNS 名を返す（IPv4 / IPv6 両対応）。
 * IPv6 は nibble を逆順にドット結合した `origin6.asn.cymru.com`。
 */
function originName(ip) {
  const v = String(ip || "").trim();
  if (isIPv4(v)) return `${v.split(".").reverse().join(".")}.origin.asn.cymru.com`;
  if (isIPv6(v)) {
    const nibbles = ipv6Nibbles(v);
    if (!nibbles) return null;
    return `${nibbles.split("").reverse().join(".")}.origin6.asn.cymru.com`;
  }
  return null;
}

/**
 * @param {string|null} cc
 * @returns {string}
 */
function countryName(cc) {
  if (!cc) return "不明";
  try {
    if (!displayNames) displayNames = new Intl.DisplayNames(["ja"], { type: "region" });
    return displayNames.of(cc) || cc;
  } catch (e) {
    return cc;
  }
}

/** DNS TXT を 1 つ引く（タイムアウト・失敗は null） */
/**
 * @param {string} name
 * @returns {Promise<string|null>} TXT が引けなければ null
 */
async function txt(name) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
  const query = dns.resolveTxt(name)
    .then((rows) => (rows || []).map((r) => r.join("")).join(" "))
    .catch(() => null);
  try {
    return await Promise.race([query, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {string} ip
 * @returns {Promise<GeoInfo>}
 */
async function resolveOne(ip) {
  const at = Date.now();
  const unknown = { cc: null, country: "不明", asn: null, org: null, ok: false, at };
  const name = originName(ip);
  if (!name) return unknown;
  const origin = await txt(name);
  if (!origin) return unknown;
  // "396982 | 207.175.128.0/17 | US | arin | 2025-01-14"
  const parts = String(origin).split("|").map((s) => s.trim());
  const asn = (parts[0] || "").split(/\s+/)[0];
  const cc = /^[A-Za-z]{2}$/.test(parts[2] || "") ? parts[2].toUpperCase() : null;
  let org = null;
  if (/^\d+$/.test(asn)) {
    const nm = await txt(`AS${asn}.asn.cymru.com`);
    if (nm) {
      // "396982 | US | arin | 2018-08-15 | GOOGLE-CLOUD-PLATFORM - Google LLC, US"
      const q = String(nm).split("|").map((s) => s.trim());
      org = q.slice(4).join(" | ").trim() || null;
    }
  }
  return { cc, country: countryName(cc), asn: /^\d+$/.test(asn) ? `AS${asn}` : null, org, ok: !!cc, at };
}

/**
 * IP を 1 つ引く（キャッシュ優先・fail-soft）。
 * @param {string} ip
 * @returns {Promise<GeoInfo>}
 */
async function lookup(ip) {
  const key = String(ip || "").trim();
  if (!key) return { cc: null, country: "不明", asn: null, org: null, ok: false };
  if (isPrivateIp(key)) {
    return { cc: null, country: "ローカル", asn: null, org: null, ok: false, private: true };
  }
  /** @type {Record<string, GeoInfo>} */
  const c = loadCache();
  const hit = c[key];
  if (hit && Number.isFinite(hit.at)) {
    const ttl = hit.ok ? OK_TTL_MS : NG_TTL_MS;
    if (Date.now() - hit.at < ttl) return { ...hit };
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = resolveOne(key)
    .then((v) => {
      cache[key] = v;
      pruneCache();
      saveCacheSoon();
      inflight.delete(key);
      return { ...v };
    })
    .catch(() => {
      inflight.delete(key);
      return { cc: null, country: "不明", asn: null, org: null, ok: false };
    });
  inflight.set(key, p);
  return p;
}

/**
 * 複数 IP をまとめて引く。
 *
 * - 重複は 1 回だけ・同時実行は CONCURRENCY まで。
 * - `limit` 件まで（上位＝呼び出し側が頻度順に並べる）。
 * - `budgetMs` を超えたら**打ち切って部分結果を返す**（未完了分は背景で進み、
 *   キャッシュが埋まるので次のリクエストで拾える）。攻撃元 IP が大量でも
 *   API が DNS 待ちで固まらないようにするため。
 *
 * @param {string[]} ips
 * @param {{limit?: number, budgetMs?: number}} [opts]
 * @returns {Promise<Map<string, object>>}
 */
async function lookupMany(ips, opts) {
  const o = opts || {};
  const limit = Number.isFinite(o.limit) ? o.limit : LOOKUP_LIMIT;
  const budget = Number.isFinite(o.budgetMs) ? o.budgetMs : BUDGET_MS;
  const uniq = [...new Set((ips || []).map((s) => String(s || "").trim()).filter(Boolean))].slice(0, limit);
  const out = new Map();
  let i = 0;
  /** @type {Promise<Map<string, GeoInfo>>} */
  const run = (async () => {
    const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, uniq.length)) }, async () => {
      while (i < uniq.length) {
        const ip = uniq[i];
        i += 1;
        out.set(ip, await lookup(ip));
      }
    });
    await Promise.all(workers);
    return out;
  })();
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), budget);
    if (timer.unref) timer.unref();
  });
  try {
    await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return out; // 打ち切った場合も、背景の解決が同じ Map を埋めていく
}

module.exports = { lookup, lookupMany, isPrivateIp, countryName, originName, ipv6Nibbles, CACHE_FILE };
