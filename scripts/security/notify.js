"use strict";
/**
 * scripts/security/notify.js - セキュリティ監視の通知と状態管理
 *
 * 役割:
 *   1. 状態ファイル（前回検出した指摘の集合）を読み書きする
 *   2. 前回との差分から「新規の指摘」「継続中の指摘」「解消した指摘」を判定する
 *   3. 新規の critical / warning を Discord に通知する
 *   4. 公開 status ページ向けの要約（詳細を含まない）を /api/internal/scraper-status へ報告する
 *
 * 通知の重複抑制:
 *   - 同じ指摘は再通知しない（同じ指摘 key が消えて再出現した場合は「新規」として扱う）
 *   - critical の指摘が 7 日以上続く場合は「継続中」として 1 回だけ再通知する
 */

const fs = require("fs");
const path = require("path");

const REPEAT_AFTER_DAYS = 7;

const SEVERITY_COLOR = { critical: 16711680, warning: 16776960, info: 5793266 };
const SEVERITY_LABEL = { critical: "重大", warning: "警告", info: "情報" };
const SOURCE_LABEL = { node: "Node.js", php: "PHP 8.3", npm: "npm 依存", os: "OS パッケージ" };

// ---------------------------------------------------------------------------
// 状態ファイル
// ---------------------------------------------------------------------------

function statePath() {
  return process.env.SECURITY_WATCH_STATE_FILE
    || path.join(__dirname, "..", "..", "data", "security-watch-state.json");
}

function loadState(file) {
  const p = file || statePath();
  let exists = true;
  try { fs.accessSync(p, fs.constants.R_OK); } catch (e) { exists = false; }
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") throw new Error("形式不正");
    if (!data.findings || typeof data.findings !== "object") data.findings = {};
    if (!data.baselines || typeof data.baselines !== "object") data.baselines = {};
    if (!data.acknowledged || typeof data.acknowledged !== "object") data.acknowledged = {};
    data.isFirstRun = false;
    return data;
  } catch (e) {
    // 初回 or 壊れていたら空状態から開始（fail-closed は「通知を黙って落とさない」側で担保する）
    return { version: 1, findings: {}, baselines: {}, acknowledged: {}, lastRun: null, isFirstRun: !exists };
  }
}

function saveState(state, file) {
  const p = file || statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// 差分判定
// ---------------------------------------------------------------------------

/**
 * 現在の findings と前回の状態を比較する。
 *
 * 承認済み（acknowledged）の指摘は通知対象から外す（ただしサマリには含める）。
 * これにより「既に把握している指摘で毎回通知される」alert fatigue を防ぐ。
 * 承認は `security-watch.js --ack <key> [--note ...]` で行う。
 *
 * @param {object} state 前回の状態
 * @param {Array} findings 現在の findings
 * @param {object} opts { now, repeatAfterDays }
 * @returns {{isNew: Array, repeating: Array, resolved: Array, acknowledged: Array, current: object}}
 */
function diffFindings(state, findings, opts) {
  const o = opts || {};
  const now = o.now ? new Date(o.now) : new Date();
  const repeatAfter = (o.repeatAfterDays || REPEAT_AFTER_DAYS) * 24 * 3600 * 1000;
  const prev = state.findings || {};
  const acknowledgedMap = state.acknowledged || {};
  const isNew = [];
  const repeating = [];
  const acknowledgedNow = [];
  const current = {};

  for (const f of findings) {
    const isAck = Object.prototype.hasOwnProperty.call(acknowledgedMap, f.key);
    const before = prev[f.key];
    if (!before) {
      if (isAck) {
        // 承認済みだが再出現した → 通知しない（承認記録を優先）
        acknowledgedNow.push(f);
        current[f.key] = { firstSeen: now.toISOString(), lastNotified: now.toISOString(), severity: f.severity, title: f.title };
        continue;
      }
      isNew.push(f);
      current[f.key] = { firstSeen: now.toISOString(), lastNotified: now.toISOString(), severity: f.severity, title: f.title };
    } else {
      const lastNotified = before.lastNotified ? Date.parse(before.lastNotified) : 0;
      const shouldRepeat = f.severity === "critical" && (now.getTime() - lastNotified) >= repeatAfter;
      current[f.key] = {
        firstSeen: before.firstSeen || now.toISOString(),
        lastNotified: shouldRepeat ? now.toISOString() : (before.lastNotified || now.toISOString()),
        severity: f.severity,
        title: f.title,
      };
      if (isAck) {
        acknowledgedNow.push(f);
      } else if (shouldRepeat) {
        repeating.push(f);
      }
    }
  }

  const resolved = Object.keys(prev).filter((k) => !(k in current));
  return { isNew, repeating, resolved, acknowledged: acknowledgedNow, current };
}

// ---------------------------------------------------------------------------
// Discord 通知
// ---------------------------------------------------------------------------

/**
 * Discord の Bot API に embed を送る（healthcheck.sh と同じ方式）。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendDiscord(cfg, payload) {
  if (!cfg.token || !cfg.channelId) {
    return { ok: false, error: "Discord の設定（token / channelId）が未設定" };
  }
  const body = {
    embeds: [{
      title: payload.title,
      description: payload.description,
      color: payload.color || SEVERITY_COLOR.warning,
      fields: payload.fields || [],
      footer: { text: `Host: ${payload.hostname || "?"} | security-watch` },
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(`https://discord.com/api/v10/channels/${cfg.channelId}/messages`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bot ${cfg.token}`,
          "User-Agent": "mai-push-security-watch (https://koinoyamai.love, 1.0)",
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Discord HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * findings から Discord embed の本文を作る。
 * source ごとにまとめて、1 通知あたりの読みやすさを確保する。
 */
function formatFindings(findings, { hostname, isRepeat } = {}) {
  const bySource = new Map();
  for (const f of findings) {
    const key = f.source || "other";
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(f);
  }
  const lines = [];
  for (const [source, list] of bySource) {
    const crit = list.filter((f) => f.severity === "critical").length;
    const warn = list.filter((f) => f.severity === "warning").length;
    const head = `**${SOURCE_LABEL[source] || source}**（重大 ${crit} / 警告 ${warn}）`;
    lines.push(head);
    for (const f of list) {
      const label = SEVERITY_LABEL[f.severity] || f.severity;
      lines.push(`　• [${label}] ${f.title}`);
      if (f.detail) {
        const detail = String(f.detail).split("\n").join("\n　　");
        lines.push(`　　${detail}`);
      }
    }
    lines.push("");
  }
  const head = isRepeat ? "（継続中の指摘の再通知）\n" : "";
  return `${head}${lines.join("\n").trim()}\n\n_host: ${hostname || "?"}_`;
}

// ---------------------------------------------------------------------------
// 状態報告（管理画面 / 公開 status ページ）
// ---------------------------------------------------------------------------

/**
 * /api/internal/scraper-status へ状態を報告する。
 * message には詳細（CVE ID 等）を含めないこと（この API は公開されている）。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function reportScraperStatus(cfg, { status, message, name }) {
  if (!cfg.token) return { ok: false, error: "NOTIFY_API_TOKEN が未設定" };
  const base = (cfg.apiBase || "http://127.0.0.1:8080").replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(`${base}/api/internal/scraper-status`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "x-notify-token": cfg.token,
        },
        body: JSON.stringify({
          id: "security-watch",
          name: name || "セキュリティ監視",
          status, // success | degraded | error
          message,
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `scraper-status HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

module.exports = {
  REPEAT_AFTER_DAYS,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  statePath,
  loadState,
  saveState,
  diffFindings,
  sendDiscord,
  formatFindings,
  reportScraperStatus,
};
