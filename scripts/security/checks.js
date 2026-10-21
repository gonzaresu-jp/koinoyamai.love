"use strict";
/**
 * scripts/security/checks.js - 脆弱性・更新の監視判定ロジック
 *
 * 「管理者が偶然見つけないと気づけない」を解消するための機械判定。
 * 各チェックはネットワーク・apt・dpkg などの外部情報を取得し、
 * 結果を finding（指摘）の一覧として返す。判定ロジック自体は純関数に分離して
 * ユニットテストできるようにしている（scripts/ops/regression-test.js [9]）。
 *
 * 重要（設計方針）:
 *   - **fail-closed**: 判定できなかった項目は「正常」ではなく「監視失敗」として出す。
 *     監視が壊れていて気づかない状态的を作らない。
 *   - **通知の重複抑制は呼び出し側**（notify.js）で行う。ここでは
 *     「いま何が起きているか」だけを出す。
 *   - CVE ID などの詳細を外部公開する経路（scraper-status → 公開 status ページ）には
 *     流さない。公開するのはカテゴリと件数だけにする。
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

// Node.js のサポート期限（メジャーバージョン → EOL 日）。
// 新しい LTS がIamovenreleasedしたらここに追記すること（AGENTS.md §5.2）。
const NODE_EOL = {
  18: "2025-04-30",
  20: "2026-04-30",
  22: "2027-04-30",
  24: "2028-04-30",
  26: "2029-04-30",
};

const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";
const PHP_CHANGELOG_URL = "https://www.php.net/ChangeLog-8.php";
// PHP の「upstream 8.3.x より新しい sections だけ」を判定する基準日。
// Ubuntu は upstream のバージョン文字列ではなく Debian リビジョンでバックポートするため、
// バージョン比較では判定できない（AGENTS.md §5.1）。
// 古い CVE（Ubuntu が遡及的に言及しないもの）を誤検出しないよう、公開日を基準に絞る。
const PHP_CVE_WINDOW_DAYS = 365;

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------------------
// 純関数（テスト対象）
// ---------------------------------------------------------------------------

/** "v24.22.0" / "24.22.0" を [24,22,0] に分解。解釈できなければ null */
function parseVersion(v) {
  const m = String(v || "").trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** バージョン比較: a<b → -1, a==b → 0, a>b → 1 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * nodejs.org/dist/index.json を解析する。
 * @returns {{releases: Array<{version,date,security,lts,ltsVersion}>}}
 */
function parseNodeIndex(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(data)) throw new Error("node index: 配列ではない");
  const releases = data
    .map((r) => ({
      version: String(r.version || ""),
      date: r.date || null,
      security: r.security === true,
      lts: r.lts === true ? r.lts : (typeof r.lts === "string" ? r.lts : false),
    }))
    .filter((r) => parseVersion(r.version));
  return { releases };
}

/**
 * php.net/ChangeLog-8.php を解析して 8.3.x のバージョンセクションを返す。
 * @returns {{"8.3.35": {version, date, cves: string[]}}}
 */
function parsePhpChangelog(html) {
  const s = String(html || "");
  const out = {};
  // <h3>Version 8.3.35</h3> で分割し、各セクションの CVE と公開日を拾う
  const parts = s.split(/<h3>Version 8\.3\.(\d+)<\/h3>/);
  for (let i = 1; i < parts.length; i += 2) {
    const patch = Number(parts[i]);
    if (!Number.isFinite(patch)) continue;
    const body = parts[i + 1].split(/<h3>Version /)[0];
    const dm = body.match(/datetime='([0-9]{4}-[0-9]{2}-[0-9]{2})'/);
    const cves = Array.from(new Set(body.match(/CVE-\d{4}-\d+/g) || [])).sort();
    out[`8.3.${patch}`] = {
      version: `8.3.${patch}`,
      date: dm ? dm[1] : null,
      cves,
    };
  }
  return out;
}

/**
 * `apt-get -s dist-upgrade` の出力を解析し、security pocket からの更新パッケージを返す。
 * 出力例: Inst ca-certificates [20260601~24.04.1] (20260816ubuntu0.24.04.1 Ubuntu:24.04/noble-security [all])
 * @returns {{security: string[], other: string[]}}
 */
function parseAptDistUpgrade(stdout) {
  const security = [];
  const other = [];
  const lines = String(stdout || "").split("\n");
  for (const line of lines) {
    const m = line.match(/^Inst\s+(\S+)\s+\[([^\]]*)\]\s+\(([^)]*)\)/);
    if (!m) continue;
    const pkg = m[1];
    const from = m[2];
    const to = m[3];
    if (/-security\b/.test(to)) security.push(`${pkg} (${from} → ${to})`);
    else other.push(`${pkg} (${from} → ${to})`);
  }
  return { security, other };
}

/**
 * `npm audit --json` の出力を解析する。
 * @returns {{advisories: Array<{name, severity, direct, via: string[], range, fixAvailable}>}}
 */
function parseNpmAudit(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const vulns = (data && data.vulnerabilities) || {};
  const advisories = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (!v || typeof v !== "object") continue;
    const via = [];
    for (const item of Array.isArray(v.via) ? v.via : []) {
      if (typeof item === "string") via.push(item);
      else if (item && item.url) via.push(item.url);
    }
    advisories.push({
      name,
      severity: v.severity || "info",
      direct: v.isDirect === true,
      via,
      range: v.range || "",
      fixAvailable: v.fixAvailable === true || (v.fixAvailable && v.fixAvailable.name) || false,
    });
  }
  advisories.sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    return s !== 0 ? s : a.name.localeCompare(b.name);
  });
  return { advisories };
}

/** Debian パッケージ版（例: 8.3.6-0ubuntu0.24.04.12）から upstream の 8.3.x を抜き出す */
function upstreamPhpBaseFromPackage(pkgVersion) {
  const m = String(pkgVersion || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

// ---------------------------------------------------------------------------
// finding ヘルパー
// ---------------------------------------------------------------------------

function finding(key, severity, source, title, detail, extra) {
  return Object.assign({ key, severity, source, title, detail }, extra || {});
}

function sortFindings(list) {
  return list.slice().sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
    if (s !== 0) return s;
    return String(a.key).localeCompare(String(b.key));
  });
}

// ---------------------------------------------------------------------------
// 外部コマンド / ネットワーク
// ---------------------------------------------------------------------------

function runCmd(cmd, args, opts) {
  const o = opts || {};
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: o.timeout || 60000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: o.cwd,
  });
}

async function fetchText(url, timeoutMs, opts) {
  const o = opts || {};
  const retries = o.retries === undefined ? 3 : o.retries;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // _linear backoff: 2s, 5s, 10s...（php.net の CDN は時折 504 を返す）
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": o.userAgent || "mai-push-security-watch (https://koinoyamai.love)",
          "Accept": "*/*",
        },
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue; // リトライ
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("fetch failed");
}

// ---------------------------------------------------------------------------
// チェック本体
// ---------------------------------------------------------------------------

/**
 * Node.js: セキュリティ修正を含む新しいリリースが出ていないか。
 * @param {object} opts { installedVersion, major }
 */
async function checkNode(opts) {
  const o = opts || {};
  const findings = [];
  let status = "ok";
  let summary = "";

  const installed = o.installedVersion || o.installedNodeVersion;
  const major = o.major || o.nodeMajor || (parseVersion(installed) || [])[0];
  if (!installed || !major) {
    return {
      source: "node", status: "error",
      summary: "Node.js の導入バージョンを特定できない",
      findings: [finding("node:unknown", "critical", "node", "Node.js のバージョンを特定できない", "監視対象が不明です")],
    };
  }

  // サポート期限切れチェック（表に無いメジャーは判定しない）
  const eol = NODE_EOL[major];
  if (eol) {
    const today = new Date().toISOString().slice(0, 10);
    if (today > eol) {
      status = "error";
      findings.push(finding(`node:eol:${major}`, "critical", "node",
        `Node.js ${major} 系はサポート期限切れ`,
        `サポート期限は ${eol} でした。対応版への更新が必要です。`));
    }
  }

  let index = null;
  try {
    const raw = await fetchText(NODE_INDEX_URL, 30000);
    index = parseNodeIndex(raw);
  } catch (e) {
    return {
      source: "node", status: "error",
      summary: "Node.js のリリース情報を取得できない",
      findings: [finding("node:fetch-failed", "critical", "node",
        "Node.js のリリース情報を取得できない",
        `nodejs.org への接続に失敗しました: ${e.message}`)],
    };
  }

  const sameMajor = index.releases.filter((r) => parseVersion(r.version)[0] === major);
  const newer = sameMajor.filter((r) => compareVersions(r.version, installed) > 0);
  if (newer.length) {
    const latest = newer[0];
    const hasSecurity = newer.some((r) => r.security);
    findings.push(finding(`node:update:${major}`, hasSecurity ? "critical" : "info", "node",
      hasSecurity
        ? `Node.js ${latest.version}（セキュリティ修正を含む）が利用可能`
        : `Node.js ${latest.version} が利用可能`,
      hasSecurity
        ? `導入中 ${installed} より新しいリリースにセキュリティ修正が含まれます。更新の検討が必要です。`
        : `導入中 ${installed} より新しい ${latest.version} が利用できます（セキュリティ修正の有無は未確認）。`));
    if (hasSecurity) status = "degraded";
  }

  const crit = findings.filter((f) => f.severity === "critical").length;
  const warn = findings.filter((f) => f.severity === "warning").length;
  summary = newer.length
    ? `要更新 ${newer.length} 版` + (crit ? `（セキュリティ修正あり）` : "")
    : "最新";
  if (warn) summary = `要対応 ${warn} 件`;
  return { source: "node", status, summary, findings };
}

/**
 * PHP 8.3: upstream の CVE 修正のうち、Ubuntu がバックポートしていないものを検出。
 * Ubuntu は upstream のバージョン文字列を固定して Debian リビジョンでバックポートするため、
 * バージョン比較ではなく「CVE の集合の包含関係」で判定する。
 */
async function checkPhp(opts) {
  const o = opts || {};
  const findings = [];
  const pkg = o.packageName || "php8.3-fpm";
  const base = upstreamPhpBaseFromPackage(o.pkgVersion);
  if (!base) {
    return {
      source: "php", status: "error",
      summary: "PHP の導入バージョンを特定できない",
      findings: [finding("php:unknown", "critical", "php", "PHP のバージョンを特定できない", "dpkg の情報が取得できませんでした")],
    };
  }

  // Ubuntu 側が「修正済み」として言及している CVE
  let covered = new Set();
  const changelogPath = o.debianChangelog || `/usr/share/doc/${pkg}/changelog.Debian.gz`;
  try {
    const gz = fs.readFileSync(changelogPath);
    const text = zlib.gunzipSync(gz).toString("utf8");
    for (const c of text.match(/CVE-\d{4}-\d+/g) || []) covered.add(c);
  } catch (e) {
    return {
      source: "php", status: "error",
      summary: "PHP の Debian changelog を読めない",
      findings: [finding("php:changelog-unreadable", "critical", "php",
        "PHP の Debian changelog を読めない",
        `${changelogPath} を展開できませんでした: ${e.message}`)],
    };
  }

  let upstream;
  try {
    const html = await fetchText(PHP_CHANGELOG_URL, 60000);
    upstream = parsePhpChangelog(html);
  } catch (e) {
    return {
      source: "php", status: "error",
      summary: "PHP の upstream 変更履歴を取得できない",
      findings: [finding("php:fetch-failed", "critical", "php",
        "PHP の upstream 変更履歴を取得できない",
        `php.net への接続に失敗しました: ${e.message}`)],
    };
  }

  const today = new Date();
  const windowMs = PHP_CVE_WINDOW_DAYS * 24 * 3600 * 1000;
  const needed = new Map(); // CVE → {version, date}
  for (const info of Object.values(upstream)) {
    if (compareVersions(info.version, base) <= 0) continue; // base より古いものは含む
    if (!info.date) continue;
    const age = today.getTime() - Date.parse(`${info.date}T00:00:00Z`);
    if (age > windowMs) continue; // 古い CVE は Ubuntu が言及しないものを含む
    for (const c of info.cves) if (!needed.has(c)) needed.set(c, info);
  }

  const missing = Array.from(needed.keys()).filter((c) => !covered.has(c)).sort();
  for (const cve of missing) {
    const info = needed.get(cve);
    findings.push(finding(`php:${cve}`, "critical", "php",
      `PHP 8.3: ${cve} が未適用`,
      `upstream ${info.version}（${info.date || "日付不明"}）で修正。Ubuntu 側の changelog に未収録です。`));
  }

  const status = missing.length ? "degraded" : "ok";
  const summary = missing.length ? `要対応 ${missing.length} 件` : "対応済み";
  return { source: "php", status, summary, findings };
}

/**
 * npm 依存: npm audit で新しい advisory が出ていないか。
 * baseline（前回の検出集合）との差分を呼び出し側で判定する。
 */
async function checkNpmAudit(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  let raw;
  try {
    raw = runCmd("npm", ["audit", "--json"], { cwd, timeout: 180000 });
  } catch (e) {
    // npm audit は脆弱性が見つかると exit code != 0 で終了する（出力は stdout にある）
    if (e.stdout) raw = e.stdout;
    else {
      return {
        source: "npm", status: "error",
        summary: "npm audit を実行できない",
        findings: [finding("npm:audit-failed", "critical", "npm",
          "npm audit を実行できない",
          `npm audit が失敗しました: ${e.message}`)],
      };
    }
  }
  let parsed;
  try {
    parsed = parseNpmAudit(raw);
  } catch (e) {
    return {
      source: "npm", status: "error",
      summary: "npm audit の出力を解析できない",
      findings: [finding("npm:audit-parse-failed", "critical", "npm",
        "npm audit の出力を解析できない", e.message)],
    };
  }
  const findings = parsed.advisories.map((a) => finding(
    `npm:${a.name}`,
    // 深刻度のマッピング。npm の high を全部 critical 扱いすると
    // 間接依存（puppeteer/firebase 系）で件数だけ増えて alert fatigue になる。
    // critical のみ重大、high は警告、それ以外は情報（通知対象外）。
    a.severity === "critical" ? "critical" : (a.severity === "high" ? "warning" : "info"),
    "npm",
    `npm 依存: ${a.name} に ${a.severity} の脆弱性`,
    `${a.direct ? "直接依存" : "間接依存"} / 影響範囲 ${a.range || "?"} / 修正: ${a.fixAvailable ? "可能" : "要手動対応"}`
    + (a.via.length ? `\n  ${a.via.join("\n  ")}` : ""),
    { advisoryUrls: a.via }
  ));
  const status = findings.some((f) => f.severity === "critical") ? "degraded" : "ok";
  const summary = parsed.advisories.length ? `要対応 ${parsed.advisories.length} 件` : "問題なし";
  return { source: "npm", status, summary, findings };
}

/**
 * OS パッケージ: security pocket の未適用更新がないか。
 */
async function checkOsPackages(opts) {
  const o = opts || {};
  let stdout;
  try {
    stdout = runCmd("apt-get", ["-s", "dist-upgrade"], { timeout: 120000 });
  } catch (e) {
    if (!e.stdout) {
      return {
        source: "os", status: "error",
        summary: "OS パッケージ Updates を確認できない",
        findings: [finding("os:apt-failed", "critical", "os",
          "OS パッケージ更新を確認できない", `apt-get が失敗しました: ${e.message}`)],
      };
    }
    stdout = e.stdout;
  }
  const parsed = parseAptDistUpgrade(stdout);
  const findings = [];
  if (parsed.security.length) {
    findings.push(finding("os:security-updates", "warning", "os",
      `OS セキュリティ更新 ${parsed.security.length} 件が未適用`,
      parsed.security.map((p) => `  - ${p}`).join("\n"),
      { packages: parsed.security }));
  }
  const status = parsed.security.length ? "degraded" : "ok";
  const summary = parsed.security.length ? `未適用 ${parsed.security.length} 件` : "最新";
  return { source: "os", status, summary, findings };
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/**
 * 全チェックを実行する。
 * @param {object} opts { installedNodeVersion, nodeMajor, pkgVersion, repoRoot, phpPackage }
 */
async function runAllChecks(opts) {
  const o = opts || {};
  const results = [];
  for (const fn of [checkNode, checkPhp, checkNpmAudit, checkOsPackages]) {
    try {
      results.push(await fn(o));
    } catch (e) {
      // 想定外の例外も「監視失敗」として出す（fail-closed）
      results.push({
        source: fn.name.replace(/^check/, ""),
        status: "error",
        summary: "監視項目で想定外の例外が発生した",
        findings: [finding(`${fn.name}:exception`, "critical", fn.name.replace(/^check/, ""),
          "監視項目で想定外の例外が発生した", String(e && e.message ? e.message : e))],
      });
    }
  }
  return results;
}

/** 公開 status ページに出す要約（詳細を漏らさない） */
function publicSummary(results) {
  const cat = { node: "Node.js", php: "PHP", npm: "npm依存", os: "OS" };
  const parts = results.map((r) => {
    const n = r.findings.filter((f) => f.severity === "critical" || f.severity === "warning").length;
    return `${cat[r.source] || r.source}: ${n > 0 ? `要対応 ${n}件` : "正常"}`;
  });
  const total = results.reduce((sum, r) =>
    sum + r.findings.filter((f) => f.severity === "critical" || f.severity === "warning").length, 0);
  return total > 0
    ? `要対応 ${total} 件（${parts.join(" / ")}）※詳細は運用ログ参照`
    : `すべて正常（${parts.join(" / ")}）`;
}

module.exports = {
  NODE_EOL,
  PHP_CVE_WINDOW_DAYS,
  parseVersion,
  compareVersions,
  parseNodeIndex,
  parsePhpChangelog,
  parseAptDistUpgrade,
  parseNpmAudit,
  upstreamPhpBaseFromPackage,
  sortFindings,
  finding,
  checkNode,
  checkPhp,
  checkNpmAudit,
  checkOsPackages,
  runAllChecks,
  publicSummary,
  runCmd,
  fetchText,
};
