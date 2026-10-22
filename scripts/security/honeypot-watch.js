#!/usr/bin/env node
"use strict";
/**
 * scripts/security/honeypot-watch.js — ハニーポット（偽物の秘密ファイル）の監視
 *
 * 何を検知するか:
 *   1. **stolen（窃取）**: ハニーファイルが 200 で配信された
 *      → 攻撃者が偽物拿到了（= 攻撃が実在した証拠）
 *   2. **canary_used（窃取後の使用）**: `/_canary/<token>` へのリクエスト
 *      → 盗んだ情報（中身を実際に使った）= 窃取確定
 *   3. **probe（偵察）**: ハニーパスに 404 が返った
 *      → 探している（まだ手EMS 수는ない）＝前兆
 *
 * 通知: Discord（security/notify.js の sendDiscord を再利用。Bot API）
 * ログ : logs/honeypot.log（独自）/ 入力は nginx の honey.log
 * 状態 : data/honeypot-state.json（読み取り位置・既通知の記録。gitignore 済み）
 *
 * 使い方:
 *   node scripts/security/honeypot-watch.js              # 通常実行（cron 用）
 *   node scripts/security/honeypot-watch.js --dry-run    # 通知せず表示だけ
 *   node scripts/security/honeypot-watch.js --test       # 通知の疎通テスト
 *
 * 終了コード: 0 = 正常 / 1 = 監視自体が失敗（fail-closed）
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HONEY_LOG = process.env.HONEY_LOG || "/var/log/nginx/honey.log";
const STATE_FILE = process.env.HONEY_STATE || path.join(REPO_ROOT, "data", "honeypot-state.json");
const SETUP_STATE = path.join(REPO_ROOT, "data", "honeypot-state.json");
const LOG_FILE = path.join(REPO_ROOT, "logs", "honeypot.log");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const TEST = args.includes("--test");

// dotenv は環境ディレクトリ固定（AGENTS.md §11）。
// テスト時など別の .env を使いたい場合のみ HONEYPOT_ENV_FILE で上書きできる。
require("dotenv").config({
  path: process.env.HONEYPOT_ENV_FILE || path.join(REPO_ROOT, ".env"),
  quiet: true,
});

const notify = require(path.join(REPO_ROOT, "scripts", "security", "notify.js"));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) { /* ログは best-effort */ }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

/** honey.log の 1 行をパースする */
function parseLine(line) {
  // 例: 2026-10-22T11:41:00+09:00 ip=1.2.3.4 xff="..." ua="curl/8" req="GET /.env HTTP/1.1" status=200 bytes=1026
  const out = { raw: line };
  const t = /^\S+/.exec(line);
  if (t) out.time = t[0];
  const ip = /\bip=(\S*)/.exec(line);
  const cf = /\bcf=(\S*)/.exec(line);
  const xff = /\bxff="([^"]*)"/.exec(line);
  const ua = /\bua="([^"]*)"/.exec(line);
  const req = /\breq="([^"]*)"/.exec(line);
  const status = /\bstatus=(\d{3})/.exec(line);
  const bytes = /\bbytes=(\d+)/.exec(line);
  out.ip = (cf && cf[1] && cf[1] !== "-") ? cf[1] : (xff && xff && xff[1] && xff[1] !== "-") ? xff[1].split(",")[0].trim() : (ip ? ip[1] : "?");
  out.ua = ua ? ua[1] : "?";
  out.status = status ? Number(status[1]) : 0;
  out.bytes = bytes ? Number(bytes[1]) : 0;
  if (req) {
    const m = /^(\S+)\s+(\S+)/.exec(req[1]);
    if (m) { out.method = m[1]; out.path = m[2]; }
  }
  return out;
}

/** パスがハニーパス（機密ファイル名っぽい）か */
const HONEY_PATH_RE = /\/(?:\.env(?:\.[\w.-]+)?|\.git\/(?:config|HEAD)|\.aws\/credentials|\.ssh\/id_\w+|id_rsa(?:\.pub)?|backup\.(?:zip|tar|gz|7z)|(?:database|db|app|prod|main|site|dump)\.(?:sqlite3?|sql)|config\.(?:php|json|ya?ml)|wp-config\.php|(?:credentials|secret|secrets|passwords?)\.(?:txt|json|ya?ml|db)|dump\.sql)\b/i;

function classify(ev, canaryPath) {
  if (!ev.path) return null;
  if (canaryPath && ev.path.startsWith(canaryPath)) {
    return { kind: "canary_used", severity: "critical", title: "ハニーポットの canary が使われました（窃取後の使用）" };
  }
  if (HONEY_PATH_RE.test(ev.path)) {
    if (ev.status === 200) {
      return { kind: "stolen", severity: "critical", title: "ハニーファイルが取得されました（偽物の窃取）" };
    }
    if (ev.status === 404) {
      return { kind: "probe", severity: "info", title: "秘密ファイルを探索されました（偵察）" };
    }
  }
  return null;
}

async function main() {
  const setup = readJson(SETUP_STATE, {});
  const canaryPath = setup.canaryPath || "";
  const state = readJson(STATE_FILE, { offset: 0, notified: {} });

  if (TEST) {
    log("通知の疎通テストを実行します");
    const res = await notify.sendDiscord(
      { token: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID },
      {
        title: "ハニーポット監視: 通知テスト",
        description: "ハニーポットの監視が通知を配信できることを確認しました。\n(この通知が届けば監視は機能しています)",
        color: notify.SEVERITY_COLOR.info,
      }
    );
    log(res && res.ok ? "通知テスト: 成功" : `通知テスト: 失敗 ${(res && res.error) || "unknown"}`);
    return res && res.ok ? 0 : 1;
  }

  if (!fs.existsSync(HONEY_LOG)) {
    log(`警告: ${HONEY_LOG} がまだありません（nginx 未適用 or まだアクセスなし）`);
    log("  → nginx にハニー location を入れると作成されます: sudo bash scripts/nginx/apply-honeypot.sh --apply");
    return 0;
  }

  const stat = fs.statSync(HONEY_LOG);
  let offset = Number(state.offset) || 0;
  if (stat.size < offset) {
    // ログがローテートされた（縮んだ）→ 先頭から読み直す
    log("ログがローテートされたため読み取り位置をリセットします");
    offset = 0;
  }
  if (stat.size === offset) {
    log("新しいイベントはありません");
    return 0;
  }

  const fd = fs.openSync(HONEY_LOG, "r");
  const buf = Buffer.alloc(stat.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const chunk = buf.toString("utf8");
  const lines = chunk.split("\n").filter((l) => l.trim() !== "");

  const events = [];
  for (const line of lines) {
    const ev = parseLine(line);
    const c = classify(ev, canaryPath);
    if (c) events.push(Object.assign({}, ev, c));
  }

  // 状態を先に保存（通知前に落ちても重複通知しない）
  const notified = state.notified || {};
  const newNotified = Object.assign({}, notified);
  for (const ev of events) {
    const key = `${ev.kind}:${ev.ip}:${ev.path}:${ev.status}`;
    newNotified[key] = new Date().toISOString();
  }
  state.offset = stat.size;
  state.notified = newNotified;
  state.lastRunAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`警告: 状態ファイルを保存できません: ${e.message}`);
  }

  if (events.length === 0) {
    log("新しいイベントはありません（読み取り進めただけ）");
    return 0;
  }

  const stolen = events.filter((e) => e.kind === "stolen");
  const used = events.filter((e) => e.kind === "canary_used");
  const probes = events.filter((e) => e.kind === "probe");

  for (const e of events) {
    log(`[${e.kind}] ${e.time} ip=${e.ip} status=${e.status} path=${e.path} ua=${e.ua}`);
  }

  // 通知（重大は個別、偵察は集約して 1 通）
  const send = async (title, description, color) => {
    if (DRY_RUN) { log(`(dry-run) 通知: ${title}`); return true; }
    const res = await notify.sendDiscord(
      { token: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID },
      { title, description, color }
    );
    log(res && res.ok ? `通知しました: ${title}` : `通知に失敗: ${(res && res.error) || "unknown"}`);
    return !!(res && res.ok);
  };

  if (used.length) {
    await send(
      "重大: ハニーポットの canary が使われました（窃取後の使用）",
      used.map((e) => `• \`${e.time}\` **${e.ip}** が \`${e.path}\` にアクセス\n  UA: \`${e.ua}\``).join("\n") +
      `\n\n偽物の設定ファイルに埋め込んだ追跡 URL にアクセスされています。\n` +
      `**偽物の中身を知っている（＝ファイルを取得した）**ことを意味します。`,
      notify.SEVERITY_COLOR.critical
    );
  }
  if (stolen.length) {
    await send(
      "重大: ハニーファイルが取得されました（窃取）",
      stolen.map((e) => `• \`${e.time}\` **${e.ip}** が \`${e.path}\`（${e.bytes} bytes）を取得\n  UA: \`${e.ua}\``).join("\n") +
      `\n\n返したのは**偽物**です（実物の秘密値は含まれません）。\n` +
      `次の段階（canary の使用）まで来ると窃取が確定します。`,
      notify.SEVERITY_COLOR.critical
    );
  }
  if (probes.length) {
    const uniqIps = [...new Set(probes.map((e) => e.ip))];
    await send(
      `情報: 秘密ファイルの探索 ${probes.length} 件（偵察）`,
      `探索元: ${uniqIps.map((ip) => `\`${ip}\``).join(", ")}\n\n` +
      probes.slice(-10).map((e) => `• \`${e.time}\` \`${e.path}\` → ${e.status}`).join("\n") +
      `\n\nまだ何も取れていません（偽物もまだ配信されていません）。`,
      notify.SEVERITY_COLOR.info
    );
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error("[honeypot-watch] 例外:", e && e.stack ? e.stack : e);
  process.exit(1);
});
