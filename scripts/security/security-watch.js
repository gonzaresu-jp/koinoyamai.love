#!/usr/bin/env node
"use strict";
/**
 * scripts/security/security-watch.js - 脆弱性・更新の自動監視（cron から日次実行）
 *
 * 目的:
 *   「管理者が偶然見つけないと気づけない」状態を解消する。
 *   Node.js / PHP 8.3 / npm 依存 / OS パッケージの 4 系統を機械判定し、
 *   **新規に検出されたものだけ**を Discord と管理画面へ通知する。
 *
 * 使い方:
 *   node scripts/security/security-watch.js [--dry-run] [--json]
 *   node scripts/security/security-watch.js --list
 *   node scripts/security/security-watch.js --ack <key> [--note "理由"]
 *   node scripts/security/security-watch.js --unack <key>
 *
 *   --dry-run  通知せず判定結果だけを表示する（状態ファイルも更新しない）
 *   --json     判定結果を JSON で標準出力に出す
 *   --list     現在の指摘と承認済み一覧を表示する（ネットワークアクセスなし）
 *   --ack      指定した指摘を「承認済み」にする（以降の通知 대상から除外。alert fatigue 対策）
 *   --unack    承認を解除する
 *
 * 環境変数:
 *   SECURITY_WATCH_STATE_FILE  状態ファイル（既定: <repo>/data/security-watch-state.json）
 *   NOTIFY_API_TOKEN            /api/internal/scraper-status 用のトークン（.env から読む）
 *   DISCORD_BOT_TOKEN           Discord 通知用（.env から読む）
 *   DISCORD_CHANNEL_ID          Discord 通知先（.env から読む）
 *
 * 終了コード:
 *   0 = 全チェックが実行できた
 *   2 = いずれかのチェックが実行できなかった（監視自体が不完全）
 *
 * 注意:
 *   - 適用（パッチインストール・npm update・pm2 再起動）は**しない**。
 *     検知と通知のみ。適用は人が判断して行う（AGENTS.md §5.2）。
 *   - dotenv の path はこのファイル起点（環境ディレクトリ固定。AGENTS.md §11）。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

// dotenv は環境ディレクトリ固定（staging が本番 .env を読む事故を防ぐ）
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const checks = require("./checks");
const notify = require("./notify");

const REPO_ROOT = path.join(__dirname, "..", "..");
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const AS_JSON = argv.includes("--json");
const LIST_ONLY = argv.includes("--list");
const ACK_IDX = argv.indexOf("--ack");
const UNACK_IDX = argv.indexOf("--unack");
const NOTE_IDX = argv.indexOf("--note");

function log(...args) {
  if (AS_JSON) return;
  console.log(`[security-watch] ${args.join(" ")}`);
}

/** 承認済み（acknowledged）の追加・解除・一覧 */
function handleAckCommands(state, stateFile) {
  if (ACK_IDX >= 0) {
    const key = argv[ACK_IDX + 1];
    if (!key) {
      console.error("usage: --ack <key> [--note \"理由\"]");
      process.exit(2);
    }
    const note = NOTE_IDX >= 0 ? (argv[NOTE_IDX + 1] || "") : "";
    state.acknowledged = state.acknowledged || {};
    state.acknowledged[key] = { note, at: new Date().toISOString() };
    notify.saveState(state, stateFile);
    console.log(`[security-watch] 承認済みに追加しました: ${key}${note ? `（${note}）` : ""}`);
    console.log("  ※ 以降の通知は対象から外れます。再通知したい場合は --unack で解除してください。");
    return true;
  }
  if (UNACK_IDX >= 0) {
    const key = argv[UNACK_IDX + 1];
    if (!key) {
      console.error("usage: --unack <key>");
      process.exit(2);
    }
    if (state.acknowledged && state.acknowledged[key]) {
      delete state.acknowledged[key];
      notify.saveState(state, stateFile);
      console.log(`[security-watch] 承認を解除しました: ${key}`);
    } else {
      console.log(`[security-watch] 未承認のキーです: ${key}`);
    }
    return true;
  }
  return false;
}

/** 実際にデプロイされている Node のバージョンを調べる（ecosystem.config.js の interpreter） */
function detectNodeVersion() {
  try {
    const eco = require(path.join(REPO_ROOT, "ecosystem.config.js"));
    const apps = (eco && eco.apps) || [];
    const withInterp = apps.find((a) => a && typeof a.interpreter === "string" && a.interpreter.includes("/node"));
    const bin = withInterp ? withInterp.interpreter : process.execPath;
    const v = checks.runCmd(bin, ["-p", "process.versions.node"], { timeout: 20000 }).trim();
    return { version: v, bin, major: checks.parseVersion(v) ? checks.parseVersion(v)[0] : null };
  } catch (e) {
    return { version: process.versions.node, bin: process.execPath, major: checks.parseVersion(process.versions.node)[0] };
  }
}

/**
 * 状態報告先の API ベース URL を解決する。
 *
 * 重要: staging ツリーから実行したときに**本番 API に報告してはいけない**
 * （本番と staging で別の DB / ポート。AGENTS.md §1 のポート位相の事故）。
 * 判定は ecosystem.config.js の「cwd がこのツリーと一致するアプリの PORT」で行う
 * （パス名や .env の NOTIFY_API_URL に依存しない）。
 */
function detectApiBase() {
  if (process.env.SECURITY_WATCH_API_BASE) return process.env.SECURITY_WATCH_API_BASE.replace(/\/+$/, "");
  if (process.env.NOTIFY_API_URL) return process.env.NOTIFY_API_URL.replace(/\/api\/notify\/?$/, "").replace(/\/+$/, "");
  try {
    const eco = require(path.join(REPO_ROOT, "ecosystem.config.js"));
    const apps = (eco && eco.apps) || [];
    const own = apps.find((a) => a && a.cwd === REPO_ROOT && a.env && a.env.PORT);
    if (own) return `http://127.0.0.1:${own.env.PORT}`;
  } catch (e) {
    // fallthrough
  }
  return "http://127.0.0.1:8080";
}

/** 導入済み PHP パッケージの Debian 版 */
function detectPhpPackageVersion(pkgName) {
  try {
    return checks.runCmd("dpkg-query", ["-W", "-f=${Version}", pkgName], { timeout: 20000 }).trim();
  } catch (e) {
    return null;
  }
}

async function main() {
  const stateFile = notify.statePath();
  const state = notify.loadState(stateFile);

  // --ack / --unack はネットワークアクセス不要
  if (handleAckCommands(state, stateFile)) return 0;

  if (LIST_ONLY) {
    const keys = Object.keys(state.findings || {});
    console.log(`[security-watch] 状態ファイル: ${stateFile}`);
    console.log(`  最終実行: ${state.lastRun || "(未実行)"}`);
    console.log(`  既知の指摘: ${keys.length} 件`);
    for (const k of keys) {
      const f = state.findings[k];
      const ack = (state.acknowledged || {})[k] ? " [承認済み]" : "";
      console.log(`    - ${k} (${f.severity}) ${f.title}${ack}`);
    }
    const acks = Object.keys(state.acknowledged || {});
    console.log(`  承認済み: ${acks.length} 件`);
    for (const k of acks) console.log(`    - ${k} ${state.acknowledged[k].note || ""}`);
    return 0;
  }

  const node = detectNodeVersion();
  const phpPkg = "php8.3-fpm";
  const pkgVersion = detectPhpPackageVersion(phpPkg);

  log(`Node.js ${node.version} (${node.bin})`);
  log(`PHP ${phpPkg} ${pkgVersion || "(取得不可)"}`);

  const results = await checks.runAllChecks({
    installedNodeVersion: node.version,
    nodeMajor: node.major,
    pkgVersion,
    phpPackage: phpPkg,
    repoRoot: REPO_ROOT,
    cwd: REPO_ROOT,
  });

  const allFindings = checks.sortFindings(results.flatMap((r) => r.findings));

  // 状態ファイル
  const diff = notify.diffFindings(state, allFindings, { now: new Date() });

  // baseline（npm の advisory 集合と OS パッケージ集合）は「前回観測した内容」の記録。
  // 指摘の key そのもの（npm:xxx / os:security-updates）が baseline を兼ねるので、
  // ここでは解析結果の要約だけ残す（どのチェックが動いたかの可視化用）。
  const summaryBySource = {};
  for (const r of results) summaryBySource[r.source] = { status: r.status, summary: r.summary };

  const report = {
    ranAt: new Date().toISOString(),
    node: { version: node.version, bin: node.bin },
    php: { package: phpPkg, version: pkgVersion },
    results: results.map((r) => ({ source: r.source, status: r.status, summary: r.summary })),
    findings: allFindings.map((f) => ({ key: f.key, severity: f.severity, source: f.source, title: f.title, detail: f.detail })),
    isNew: diff.isNew.map((f) => f.key),
    repeating: diff.repeating.map((f) => f.key),
    resolved: diff.resolved,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log("--- 判定結果 ---");
    for (const r of results) log(`  ${r.source}: ${r.status} / ${r.summary}`);
    for (const f of allFindings) log(`  [${f.severity}] ${f.key} - ${f.title}`);
    if (diff.resolved.length) log(`  解消: ${diff.resolved.join(", ")}`);
  }

  if (DRY_RUN) {
    log("--dry-run: 通知と状態更新は行いません");
    return 0;
  }

  // --- 通知 ---
  const hostname = os.hostname();
  const isFirstRun = state.isFirstRun === true;
  const notifyTargets = diff.isNew.concat(diff.repeating);
  const notifiable = notifyTargets.filter((f) => f.severity === "critical" || f.severity === "warning");

  if (isFirstRun) {
    // 初回は「既に存在する指摘」を一斉に通知すると量で埋もれて警报が効かなくなる。
    // ベースラインとして登録し、件数と内訳だけを 1 通で知らせる。
    // 詳細は `security-watch.js --list` で確認し、承受できるものを --ack で承認する。
    const bySource = {};
    for (const f of allFindings) {
      if (f.severity !== "critical" && f.severity !== "warning") continue;
      bySource[f.source] = (bySource[f.source] || 0) + 1;
    }
    const desc = Object.entries(bySource)
      .map(([s, n]) => `・${s}: ${n} 件`)
      .join("\n") || "・なし";
    const res = await notify.sendDiscord(
      { token: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID },
      {
        title: "セキュリティ監視: 初回ベースラインを登録しました",
        description: `監視を開始しました。現在の指摘をベースラインとして登録し、**今後新しく出たものだけ**通知します。\n\n${desc}\n\n対応方法:\n・詳細: \`node scripts/security/security-watch.js --list\`\n・承受できる指摘: \`--ack <key>\`（以降の通知対象外）\n・解除: \`--unack <key>\`\n_host: ${hostname}_`,
        color: notify.SEVERITY_COLOR.info,
      }
    );
    if (res.ok) log("初回ベースラインを登録し、Discord に概要を通知しました");
    else log(`Discord 通知に失敗: ${res.error}`);
  } else if (notifiable.length) {
    const isRepeat = diff.repeating.length > 0;
    const res = await notify.sendDiscord(
      { token: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID },
      {
        title: isRepeat ? "セキュリティ監視: 継続中の指摘があります" : "セキュリティ監視: 新しい指摘を検出しました",
        description: notify.formatFindings(notifiable, { hostname, isRepeat }),
        color: notifiable.some((f) => f.severity === "critical")
          ? notify.SEVERITY_COLOR.critical
          : notify.SEVERITY_COLOR.warning,
        fields: [
          { name: "対象", value: notifiable.map((f) => f.source).join(", "), inline: true },
          { name: "件数", value: String(notifiable.length), inline: true },
        ],
      }
    );
    if (res.ok) log(`Discord に通知しました（${notifiable.length} 件）`);
    else log(`Discord 通知に失敗: ${res.error}`);
  } else {
    log("新しい指摘なし（通知なし）");
  }

  // --- 管理画面 / 公開 status ページへの状態報告（詳細を含めない） ---
  const overall = results.some((r) => r.status === "error")
    ? "error"
    : (allFindings.some((f) => f.severity === "critical" || f.severity === "warning") ? "degraded" : "success");
  const apiBase = detectApiBase();
  log(`報告先: ${apiBase}`);
  const reportRes = await notify.reportScraperStatus(
    { token: process.env.NOTIFY_API_TOKEN, apiBase },
    { status: overall, message: checks.publicSummary(results) }
  );
  if (reportRes.ok) log("scraper-status に報告しました");
  else log(`scraper-status 報告に失敗: ${reportRes.error}`);

  // --- 状態更新 ---
  state.findings = diff.current;
  state.baselines = summaryBySource;
  state.acknowledged = state.acknowledged || {};
  state.lastRun = new Date().toISOString();
  state.lastSummary = checks.publicSummary(results);
  notify.saveState(state, stateFile);
  log(`状態を保存しました: ${stateFile}`);
  if (diff.acknowledged.length) {
    log(`承認済みの指摘 ${diff.acknowledged.length} 件は通知対象外（サマリのみ）`);
  }

  // --- 監視自体が不完全なら非0で終了（fail-closed） ---
  const broken = results.filter((r) => r.status === "error");
  if (broken.length) {
    log(`警告: ${broken.length} 件の監視が実行できませんでした（${broken.map((r) => r.source).join(", ")}）`);
    return 2;
  }
  return 0;
}

main().then((code) => {
  process.exit(code);
}).catch((e) => {
  console.error("[security-watch] 例外:", e && e.message ? e.message : e);
  process.exit(2);
});
