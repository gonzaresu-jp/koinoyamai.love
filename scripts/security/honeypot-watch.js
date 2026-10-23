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
 *      → 探している（まだ手に入れていない）＝前兆
 *
 * 設計上の要点（独立レビュー 2026-10-22 の指摘を反映）:
 *   - **通知に失敗したイベントは失わない**（fail-closed）。
 *     通知が成功したイベントだけ `pending` から外す。失敗したら pending に残し、
 *     **exit 2** で異常を報告する（次回に再送される）。
 *   - **`--dry-run` は状態を一切書き換えない**（読むだけ）。
 *     dry-run でイベントを消費すると、以後二度と通知されなくなるため。
 *   - **状態ファイルは setup と watcher で分ける**
 *     （setup = canary token / watcher = 読み取り位置と pending）。
 *     同じファイル使うと setup の再実行で読み取り位置が消え、
 *     過去の重大イベントが全件再通知される（アラーム疲れ）。
 *   - **ログの世代（inode）を管理する**。ローテートや切り詰めでイベントを飛ばさない。
 *   - **UA 文字列に解析を騙されない**。判定は `uri=` と `st=` だけを使う
 *     （UA は honeyfmt の**最後**に置き、先頭の固定フィールドから読む）。
 *   - **検知経路は状態を報告する**（AGENTS.md §11）。
 *     監視が静かに死んでも察觉できるよう `/api/internal/scraper-status` へ報告する。
 *   - **自機からのリクエストは通知しない**（ノイズ防止）。
 *     `ip=127.0.0.1` かつ `cf=-` かつ `xff=-` ＝ **Cloudflare を通っていない自機からの
 *     確認・テスト**（= 運用者本人のテスト）。
 *     インターネット経由は必ず `cf=` に入るので、**公開トラフィックは絶対に落とさない**。
 *     **LAN 直叩き（192.168.1.x 等）は自機扱いせず通知する**
 *     （LAN 内の端末が侵害されている可能性があるため）。
 *     `--include-local` を付けると自機イベントも通知する。
 *
 * 通知: Discord（security/notify.js の sendDiscord を再利用。Bot API）
 * ログ : logs/honeypot.log（イベント記録）/ cron の stdout は logs/honeypot-cron.log
 * 状態 : data/honeypot-watch-state.json（読み取り位置・pending。gitignore 済み）
 * 起点 : data/honeypot-canary.json（canary token。setup が書く。gitignore 済み）
 *
 * 使い方:
 *   node scripts/security/honeypot-watch.js              # 通常実行（cron 用）
 *   node scripts/security/honeypot-watch.js --dry-run    # 通知せず表示だけ（状態は変更しない）
 *   node scripts/security/honeypot-watch.js --test       # 通知の疎通テスト
 *   node scripts/security/honeypot-watch.js --selftest   # 状態管理の自己テスト（回帰テストから呼ぶ）
 *
 * 終了コード: 0 = 正常 / 1 = 実行時エラー / 2 = 監視の失敗（fail-closed）
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HONEY_LOG = process.env.HONEY_LOG || "/var/log/nginx/honey.log";
const WATCH_STATE = process.env.HONEY_WATCH_STATE || path.join(REPO_ROOT, "data", "honeypot-watch-state.json");
const CANARY_STATE = process.env.HONEY_CANARY_STATE || path.join(REPO_ROOT, "data", "honeypot-canary.json");
const LOG_FILE = path.join(REPO_ROOT, "logs", "honeypot.log");
const PENDING_LIMIT = 200;
// 同じイベント（種別・IP・パス・status）を再通知しない期間。
// 「新規がないのに毎回通知が来る」を防ぐ（2026-10-23 ユーザー報告）。
const DEDUPE_HOURS = Number(process.env.HONEY_DEDUPE_HOURS || 24);
const DEDUPE_MS = DEDUPE_HOURS * 3600 * 1000;
const RECENT_LIMIT = 2000;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const TEST = args.includes("--test");
const SELFTEST = args.includes("--selftest");
const INCLUDE_LOCAL = args.includes("--include-local");

// dotenv は環境ディレクトリ固定（AGENTS.md §11）。
// テスト時など別の .env を使いたい場合のみ HONEYPOT_ENV_FILE で上書きできる。
require("dotenv").config({
  path: process.env.HONEYPOT_ENV_FILE || path.join(REPO_ROOT, ".env"),
  quiet: true,
});

const notify = require(path.join(REPO_ROOT, "scripts", "security", "notify.js"));
const { chunkLines } = require(path.join(REPO_ROOT, "scripts", "security", "discord-chunk.js"));

// パターン本体は nginx 側と**共有**する（scripts/nginx/honey-path-pattern.txt）。
// 二重管理すると「配信はされるのに監視が拾えない」不整合が起きる。
const PATTERN_FILE = path.join(REPO_ROOT, "scripts", "nginx", "honey-path-pattern.txt");
const HONEY_BODY = fs.existsSync(PATTERN_FILE) ? fs.readFileSync(PATTERN_FILE, "utf8").trim() : "";

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

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** honeyfmt の 1 行をパースする。
 *  固定フィールドは UA より**前**に並ぶため、UA に紛れ込まれた
 *  `status=` や `uri=` を拾うことはない（先頭一致で読む）。 */
function parseLine(line) {
  const out = { raw: line };
  const t = /^(\S+)\s/.exec(line);
  if (t) out.time = t[1];
  const ip = /\bip=(\S*)/.exec(line);
  const cf = /\bcf=(\S*)/.exec(line);
  const xff = /\bxff="([^"]*)"/.exec(line);
  const ua = /\bua="([^"]*)"/.exec(line);
  const st = /\bst=(\d{3})\b/.exec(line);
  const uri = /\buri=(\S*)/.exec(line);
  const bytes = /\bbytes=(\d+)/.exec(line);
  const req = /\breq="([^"]*)"/.exec(line);
  out.cf = (cf && cf[1]) ? cf[1] : "-";
  out.xff = (xff && xff[1]) ? xff[1] : "-";
  out.remote = ip ? ip[1] : "?";
  // 表示用の IP: Cloudflare 経由なら cf=（実クライアント）。
  // 直接アクセス（LAN / origin 直叩き）なら **実 peer**（$remote_addr）を使う。
  // ※ xff は攻撃者が任意に set できるので、表示には使わない（誤誘導を避ける）。
  out.ip = (cf && cf[1] && cf[1] !== "-") ? cf[1] : (ip ? ip[1] : "?");
  out.ua = ua ? ua[1] : "?";
  out.status = st ? Number(st[1]) : 0;
  out.uri = uri ? uri[1] : "";
  out.bytes = bytes ? Number(bytes[1]) : 0;
  if (req) {
    const m = /^(\S+)\s+(\S+)/.exec(req[1]);
    if (m) { out.method = m[1]; out.path = m[2]; }
  }
  // path が無ければ uri を使う（判定は uri 基準）
  if (!out.path && out.uri) out.path = decodeURIComponent(out.uri);
  return out;
}

/**
 * 自機（運用者）からのリクエストか。
 * 条件: 接続元が loopback かつ Cloudflare ヘッダが無い（＝Cloudflare を通っていない）
 *  - インターネット経由: cf= に実クライアント IP が入る → false
 *  - LAN 直叩き（192.168.1.x 等）: cf=- だが loopback ではない → false（報告する）
 *  - 自機からのテスト（127.0.0.1）: cf=- かつ loopback → true（通知しない）
 */
function isLocalSelfTest(ev) {
  if (!ev) return false;
  if (ev.cf && ev.cf !== "-") return false;
  if (ev.xff && ev.xff !== "-") return false;
  const remote = ev.remote || ev.ip || "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "localhost"
    || remote === "::ffff:127.0.0.1" || remote.startsWith("127.");
}

/** 機密ファイル名っぽいパスか */
// 共有パターンから組み立てる（nginx の location と**同じ判定**にする）。
// 末尾の (?![.\w\-]) は nginx の `$` 相当（`.envx` などが誤検知されないように）。
const HONEY_PATH_RE = HONEY_BODY
  ? new RegExp("/(?:[\\w.\\-]+/)*(?:" + HONEY_BODY + ")(?![.\\w\\-])", "i")
  : /\/(?:\.env|\.git\/config)\b/i;

/** 重複判定のキー。**時刻は含めない**（同じ相手・同じ要求を一定期間は再通知しない）。 */
function eventKey(e) {
  return `${e.kind}|${e.ip}|${e.path}|${e.status}`;
}

/** 古い重複記録を落とす（無制限に育つと状態ファイルが肥大する） */
function pruneRecent(recent, nowMs) {
  const out = {};
  const entries = Object.entries(recent || {})
    .map(([k, v]) => [k, Date.parse(v)])
    .filter(([, t]) => Number.isFinite(t))
    .sort((a, b) => a[1] - b[1]);
  for (const [k, t] of entries) {
    if (nowMs - t < DEDUPE_MS) out[k] = new Date(t).toISOString();
  }
  const keys = Object.keys(out);
  if (keys.length > RECENT_LIMIT) {
    for (const k of keys.slice(0, keys.length - RECENT_LIMIT)) delete out[k];
  }
  return out;
}

function classify(ev, canaryPaths) {
  if (!ev.path) return null;
  for (const cp of canaryPaths) {
    if (cp && ev.path.startsWith(cp)) {
      return { kind: "canary_used", severity: "critical", title: "ハニーポットの canary が使われました（窃取後の使用）" };
    }
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

/** ログを読む。offset と inode を管理し、世代が変われば 0 から読み直す。
 *  末尾の不完全な行（改行で終わっていない）は消費しない。 */
function readNewLines(state, logPath) {
  const target = logPath || HONEY_LOG;
  if (!fs.existsSync(target)) return { lines: [], offset: state.offset || 0, inode: state.inode || 0, missing: true };
  const stat = fs.statSync(target);
  const inode = stat.ino;
  let offset = Number(state.offset) || 0;
  let resetReason = null;
  if (state.inode && state.inode !== inode) {
    resetReason = `inode が変わりました（${state.inode} → ${inode}）: 先頭から読み直します`;
    offset = 0;
  } else if (stat.size < offset) {
    resetReason = "ログが切り詰められました: 先頭から読み直します";
    offset = 0;
  }
  if (stat.size === offset) {
    return { lines: [], offset, inode, resetReason, missing: false };
  }
  const fd = fs.openSync(target, "r");
  const buf = Buffer.alloc(stat.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const chunk = buf.toString("utf8");
  // 末尾が改行で終わっていなければ、その行は「未完成」として消費しない
  const lastNl = chunk.lastIndexOf("\n");
  const usable = lastNl === -1 ? "" : chunk.slice(0, lastNl + 1);
  const newOffset = offset + Buffer.byteLength(usable, "utf8");
  const lines = usable.split("\n").filter((l) => l.trim() !== "");
  return { lines, offset: newOffset, inode, resetReason, missing: false };
}

/** canary token の一覧（現在＋直近の旧分。--rotate で増えた分を拾う） */
function canaryPathsFrom(state) {
  const list = [];
  if (state && state.canaryPath) list.push(state.canaryPath);
  if (state && Array.isArray(state.previousCanaryPaths)) {
    for (const p of state.previousCanaryPaths) if (p && !list.includes(p)) list.push(p);
  }
  return list;
}

async function reportStatus(status, message) {
  // AGENTS.md §11: 検知経路は状態を報告する（壊れても気づけるように）
  const apiBase = process.env.HONEY_API_BASE || "http://127.0.0.1:8080";
  const res = await notify.reportScraperStatus(
    { token: process.env.NOTIFY_API_TOKEN, apiBase },
    { status, message, name: "ハニーポット監視" }
  );
  if (!res || !res.ok) {
    log(`scraper-status 報告に失敗: ${(res && res.error) || "unknown"}`);
  }
  return !!(res && res.ok);
}

// ---------------------------------------------------------------------------
// 自己テスト（状態管理の不変条件を固定する。回帰テスト [11] から呼ぶ）
// ---------------------------------------------------------------------------
function selftest() {
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "honeypot-selftest-"));
  const logPath = path.join(tmp, "honey.log");
  const statePath = path.join(tmp, "state.json");
  let fails = 0;
  const check = (name, cond) => {
    if (cond) console.log(`  PASS ${name}`);
    else { fails++; console.error(`  FAIL ${name}`); }
  };

  // 1) dry-run は状態を書き換えない
  fs.writeFileSync(logPath, '2026-10-22T00:00:00Z ip=1.1.1.1 cf=- xff="-" st=200 uri=/.env bytes=10 | ua="x"\n');
  const before = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null;
  const st1 = readJson(statePath, {});
  const r1 = readNewLines(st1, logPath);
  check("新しい行が読めた", r1.lines.length === 1);
  check("offset が進んだ", r1.offset > 0);
  check("dry-run は状態ファイルを書き換えない", before === null);

  // 2) inode が変われば先頭から読み直す
  const st2 = { offset: r1.offset, inode: 999999 };
  fs.writeFileSync(logPath, '2026-10-22T00:00:00Z ip=1.1.1.1 cf=- xff="-" st=200 uri=/.env bytes=10 | ua="x"\n2026-10-22T00:00:01Z ip=1.1.1.1 cf=- xff="-" st=200 uri=/.env2 bytes=10 | ua="x"\n');
  const r2 = readNewLines(st2, logPath);
  check("inode 変更で先頭から読み直す", r2.resetReason && r2.lines.length === 2);

  // 3) 末尾の不完全な行は消費しない
  const st3 = { offset: 0, inode: fs.statSync(logPath).ino };
  fs.appendFileSync(logPath, '2026-10-22T00:00:02Z ip=1.1.1.1 cf=- xff="-" st=200 uri=/.env3');
  const r3 = readNewLines(st3, logPath);
  check("末尾の未完成行は読まない", r3.lines.length === 2);
  // 未完成行が完成したら（改行が追記されたら）次回で読める
  fs.appendFileSync(logPath, "\n");
  const r3b = readNewLines({ offset: r3.offset, inode: r3.inode }, logPath);
  check("未完成行は次回に読まれる", r3b.lines.length === 1);

  // 4) UA に status/uri を注入しても判定は変わらない
  const ev = parseLine('2026-10-22T00:00:00Z ip=1.1.1.1 cf=- xff="-" st=404 uri=/nothing bytes=10 | ua="x\\" st=200 uri=/.env"');
  check("UA 注入で status 判定が変わらない", ev.status === 404);
  check("UA 注入で uri 判定が変わらない", ev.uri === "/nothing");

  // 4b) 自機リクエストの判定
  const localEv = parseLine('2026-10-22T00:00:00Z ip=127.0.0.1 cf=- xff="-" st=200 uri=/.env bytes=10 | ua="curl/8"');
  const cfEv = parseLine('2026-10-22T00:00:00Z ip=127.0.0.1 cf=203.0.113.9 xff="203.0.113.9" st=200 uri=/.env bytes=10 | ua="x"');
  const lanEv = parseLine('2026-10-22T00:00:00Z ip=192.168.1.50 cf=- xff="-" st=200 uri=/.env bytes=10 | ua="x"');
  check("自機(127.0.0.1 + cf 無し)はローカル扱い", isLocalSelfTest(localEv));
  check("Cloudflare 経由はローカル扱いでない", !isLocalSelfTest(cfEv));
  check("LAN 直叩きはローカル扱いでない（報告する）", !isLocalSelfTest(lanEv));

  // 5) 分類は uri 基準
  const c1 = classify({ path: "/.env", status: 200 }, []);
  const c2 = classify({ path: "/.env", status: 404 }, []);
  const c3 = classify({ path: "/_canary/abc123/x", status: 204 }, ["/_canary/abc123"]);
  check("200 は stolen", c1 && c1.kind === "stolen");
  check("404 は probe", c2 && c2.kind === "probe");
  check("canary パスは canary_used", c3 && c3.kind === "canary_used");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails === 0 ? "  セルftest: すべて PASS" : `  セルftest: ${fails} 件失敗`);
  return fails === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
async function main() {
  if (SELFTEST) {
    return selftest();
  }

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

  const canaryState = readJson(CANARY_STATE, {});
  const canaryPaths = canaryPathsFrom(canaryState);

  // --- 配信されている偽物の token と state が一致しているか（自己検査）---
  // 不一致だと「盗った情報を使った」＝窃取確定の通知が**無言で失われる**。
  const HONEY_ENV = process.env.HONEY_ENV_FILE_DIR
    ? path.join(process.env.HONEY_ENV_FILE_DIR, ".env")
    : "/var/lib/mai-push/honeypot/.env";
  let tokenMismatch = null;
  try {
    if (fs.existsSync(HONEY_ENV) && canaryState.token) {
      const m = /honey-canary-([0-9a-f]+)/.exec(fs.readFileSync(HONEY_ENV, "utf8"));
      if (m && m[1] !== canaryState.token) {
        tokenMismatch = `配信中の偽物の token=${m[1]} / state の token=${canaryState.token}`;
      }
    }
  } catch (e) { /* 検査は best-effort */ }
  if (tokenMismatch) {
    log(`[WARN] ${tokenMismatch}`);
    log("  → 偽物の再生成が必要です: 本番ツリーで bash scripts/security/honeypot-setup.sh");
    await reportStatus("degraded", `ハニーポットの canary token がデシンクしています（${tokenMismatch}）。窃取確定の通知が出ません。`);
    return 2;
  }
  const state = readJson(WATCH_STATE, { offset: 0, inode: 0, pending: [], recent: {} });
  if (!state.pending) state.pending = [];
  // 通知済みイベントの重複抑制マップ（キー → 最後に通知した時刻）
  state.recent = pruneRecent(state.recent, Date.now());

  const r = readNewLines(state);
  if (r.missing) {
    log(`警告: ${HONEY_LOG} がまだありません`);
    log("  → nginx にハニー location を入れる: sudo bash scripts/nginx/apply-honeypot.sh --apply");
    log("  → 監視が動いていないので状態を degraded で報告します");
    await reportStatus("degraded", `honey.log が存在しません（nginx 未適用 or まだアクセスなし）`);
    return 2;
  }
  if (r.resetReason) log(r.resetReason);

  // --- 新しいイベントを取り込んで pending へ ---
  const fresh = [];
  const localEvents = [];
  const deduped = [];
  const seenKey = new Set(Object.keys(state.recent));
  for (const line of r.lines) {
    const ev = parseLine(line);
    const c = classify(ev, canaryPaths);
    if (!c) continue;
    const e = Object.assign({}, ev, c);
    // 自機（運用者）からのテストは**通知しない**（ログには残す）
    if (!INCLUDE_LOCAL && isLocalSelfTest(e)) {
      e.kind = e.kind + "_local";
      localEvents.push(e);
      continue;
    }
    // 同じイベント（種別・IP・パス・status）は一定期間は再通知しない。
    // 同じスキャナが同じファイルを何度も取りに来るのは「新規」ではない。
    const k = eventKey(e);
    if (seenKey.has(k)) {
      deduped.push(e);
      continue;
    }
    seenKey.add(k);
    fresh.push(e);
  }
  if (deduped.length) {
    log(`${deduped.length} 件は通知済みのイベントのため再通知しません（${DEDUPE_HOURS} 時間の重複抑制）`);
  }
  if (localEvents.length) {
    log(`${localEvents.length} 件のイベントは自機からのリクエストのため通知しません（--include-local で含められます）`);
    if (localEvents.length > 50) {
      // 短時間に大量の「自機扱い」= Cloudflare の CF-Connecting-IP が
      // 付かなくなった（設定退行）疑いがある。1 通だけ警告する。
      log("[WARN] 自機扱いのイベントが異常に多い。Cloudflare のヘッダが抜けていないか確認してください");
      if (!DRY_RUN) {
        await notify.sendDiscord(
          { token: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID },
          {
            title: "警告: ハニーポット監視で自機扱いのイベントが大量発生",
            description: `${localEvents.length} 件が「自機（Cloudflare 経由ではない）」として抑制されました。\n` +
              `インターネットからのトラフィックが全部 suppress されている可能性があります。\n` +
              `cloudflared / nginx のヘッダ設定を確認してください。`,
            color: notify.SEVERITY_COLOR.warning,
          }
        );
      }
    }
    for (const e of localEvents) {
      log(`[${e.kind}] ${e.time} ip=${e.ip} status=${e.status} path=${e.path} ua=${e.ua}`);
    }
  }
  if (fresh.length) {
    log(`${fresh.length} 件のイベントを検出しました`);
    for (const e of fresh) {
      log(`[${e.kind}] ${e.time} ip=${e.ip} status=${e.status} path=${e.path} ua=${e.ua}`);
    }
    state.pending = state.pending.concat(fresh);
    // pending は上限を設ける（古いものから捨てる。捨てた件はログに残す）
    if (state.pending.length > PENDING_LIMIT) {
      const dropped = state.pending.length - PENDING_LIMIT;
      log(`pending が上限(${PENDING_LIMIT})を超えたため ${dropped} 件を破棄しました`);
      state.pending = state.pending.slice(-PENDING_LIMIT);
    }
  }

  // --- 通知（pending を全部まとめて）---
  // 設計（2026-10-23 修正・ユーザー報告「新規ないのに毎回通知いらない」）:
  //   - **1 メッセージに詰め込みすぎない**: Discord の embed description は 4096 文字上限で、
  //     超えると**通知全体が 400 で落ちる**（一部だけ捨てられる、ではない）。
  //     37 件の窃取（UA 付き）で実際に落ち、「窃取の通知が一度も届かない」うえ
  //     失敗ループで偵察の通知が 5 分おきに再送され続けた。
  //     → 行数ベースで分割し**複数メッセージ**で送る（`discord-chunk.js`）。
  //   - **イベント単位で配送を追跡する**（`notified`）。1 カテゴリが失敗しても
  //     成功したカテゴリ／チャンクを再送しない（通知の重複を防ぐ）。
  //   - **同じイベントは再通知しない**（`state.recent`。既定 24 時間）。
  let notifiedAll = true;
  if (!state.pending.length) {
    if (!fresh.length) log("新しいイベントはありません");
  } else {
    const send = async (title, description, color) => {
      if (DRY_RUN) { log(`(dry-run) 通知: ${title}`); return true; }
      const res = await notify.sendDiscord(
        { token: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID },
        { title, description, color }
      );
      if (res && res.ok) { log(`通知しました: ${title}`); return true; }
      log(`通知に失敗: ${(res && res.error) || "unknown"}`);
      return false;
    };

    // 1 カテゴリを、上限以内の複数メッセージに分けて送る。
    // 送れたイベントだけ `notified = true` にし、失敗分は pending に残す。
    const sendEvents = async (items, title, color, fmt, footer) => {
      const chunks = chunkLines(items, fmt);
      let allOk = true;
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const head = i === 0 ? "" : `（続き ${i + 1}/${chunks.length}）\n`;
        const tail = i === chunks.length - 1 ? (footer || "") : "";
        const ok = await send(i === 0 ? title : `${title}（続き）`, head + c.text + tail, color);
        if (!ok) allOk = false;
        for (const e of c.items) e.notified = !!ok;
        // Discord のレート制限（5 通/5 秒）を避ける
        if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 1200));
      }
      return allOk;
    };

    const used = state.pending.filter((e) => e.kind === "canary_used");
    const stolen = state.pending.filter((e) => e.kind === "stolen");
    const probes = state.pending.filter((e) => e.kind === "probe");

    let okAll = true;
    if (used.length) {
      okAll = (await sendEvents(
        used,
        "重大: ハニーポットの canary が使われました（窃取後の使用）",
        notify.SEVERITY_COLOR.critical,
        (e) => `• \`${e.time}\` **${e.ip}** が \`${e.path}\` にアクセス\n  UA: \`${e.ua}\``,
        "\n\n偽物の設定ファイルに埋め込んだ追跡 URL にアクセスされています。\n" +
          "**偽物の中身を知っている（＝ファイルを取得した）**ことを意味します。"
      )) && okAll;
    }
    if (stolen.length) {
      okAll = (await sendEvents(
        stolen,
        `重大: ハニーファイルが取得されました（窃取 ${stolen.length} 件）`,
        notify.SEVERITY_COLOR.critical,
        (e) => `• \`${e.time}\` **${e.ip}** が \`${e.path}\`（${e.bytes} bytes）を取得\n  UA: \`${e.ua}\``,
        "\n\n返したのは**偽物**です（実物の秘密値は含まれません）。\n" +
          "次の段階（canary の使用）まで来ると窃取が確定します。"
      )) && okAll;
    }
    if (probes.length) {
      okAll = (await sendEvents(
        probes,
        `情報: 秘密ファイルの探索 ${probes.length} 件（偵察）`,
        notify.SEVERITY_COLOR.info,
        (e) => `• \`${e.time}\` \`${e.ip}\` \`${e.path}\` → ${e.status}`,
        "\n\n" + (stolen.length || used.length
          ? "※ 同時に**取得（窃取）**も検知しています（上の通知）。"
          : "まだ何も取れていません（偽物もまだ配信されていません）。")
      )) && okAll;
    }
    notifiedAll = okAll;

    // 送れたイベントを重複抑制マップに記録し、pending から外す
    const nowIso = new Date().toISOString();
    for (const e of state.pending) {
      if (e.notified) state.recent[eventKey(e)] = nowIso;
    }
    const before = state.pending.length;
    state.pending = state.pending.filter((e) => !e.notified);
    if (state.pending.length) {
      log(`通知に失敗した ${state.pending.length} 件は pending に保持します（次回に再送されます）`);
    } else if (before) {
      log(`${before} 件のイベントをすべて通知しました`);
    }
  }

  // --- 状態を保存（dry-run は一切書き換えない）---
  if (!DRY_RUN) {
    state.offset = r.offset;
    state.inode = r.inode;
    state.lastRunAt = new Date().toISOString();
    state.lastNotified = notifiedAll;
    try {
      writeJson(WATCH_STATE, state);
    } catch (e) {
      log(`警告: 状態を保存できません: ${e.message}`);
      return 2;
    }
  }

  // --- 状態報告（AGENTS.md §11）---
  const summary = state.pending.length
    ? `未通知 ${state.pending.length} 件（通知に失敗しています）`
    : `最新イベント: ${fresh.length} 件` +
      (localEvents.length ? `（自機 ${localEvents.length} 件は通知対象外）` : "");
  const reportOk = await reportStatus(notifiedAll ? "success" : "degraded", `${summary}（監視実行: ${new Date().toISOString()}）`);
  if (!notifiedAll) {
    log("通知に失敗したため degraded として報告しました（fail-closed）");
    return 2;
  }
  if (!reportOk) {
    log("状態報告に失敗しました（監視の異常が検知されなくなるため fail-closed）");
    return 2;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error("[honeypot-watch] 例外:", e && e.stack ? e.stack : e);
  process.exit(1);
});
