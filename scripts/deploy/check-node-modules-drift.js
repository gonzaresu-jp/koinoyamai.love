#!/usr/bin/env node
"use strict";
// scripts/deploy/check-node-modules-drift.js
//
// package-lock.json と node_modules の乖離を **全パッケージ** で比較する。
//
// なぜ必要か（2026-10-24 実測）:
//   以前は npm-deploy.sh / check-drift.sh が **固定リスト（9 個）** だけを見ていた。
//   そのため body-parser 2.3.0→2.4.0 / 入れ子 undici 6.28.1→6.29.1 / qs 6.16.0→6.16.1 の
//   更新を `npm-deploy.sh` が「乖離なし」と誤判定して install をスキップした
//   （= lockfile だけ新しく、実体は脆弱なまま。AGENTS §5 の「偽の安全感」そのもの）。
//   監視対象を列挙する方式は、依存を足すたびに漏れる。全件比較にする。
//
// 使い方: cwd = ツリーのルート（package-lock.json と node_modules がある所）
//   node scripts/deploy/check-node-modules-drift.js
//
// 出力: 乖離を 1 行 1 件（stdout）。0 件なら **何も出さない**。件数が多い場合は先頭のみ + 残件数。
// 終了コード: 0 = 乖離なし / 10 = 乖離あり / 1 = 判定不能（lockfile が読めない等）
//
// 判定の前提:
//   - lockfile にあってディスクに無いものは optional / dev / peer の可能性があるため除外する
//     （他プラットフォーム専用の @esbuild/* 等。実測: prod の欠損 50 件はすべて optional）。
//   - ただし **必須（optional/dev/peer でない）のに無い**ものは報告する
//     （npm install が途中で失敗した node_modules を「一致」と誤判定しないため）。
//   - 逆に、ディスクにあって版が違うものは **必ず** 報告する（部分更新の検出）。
//   - KEY_PACKAGES は「実行時に必ず要る」ものだけ。未インストールなら報告する。
//
// 注意: require() ではなくファイルを直接読む（exports マップで package.json が
// 取れないパッケージがある。例: discord.js）。
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const KEY_PACKAGES = [
  "proxy-addr",
  "sharp",
  "esbuild",
  "undici",
  "follow-redirects",
  "firebase-admin",
  "puppeteer",
  "sqlite3",
  "bcrypt",
  "express",
  "body-parser",
  "discord.js",
];
const MAX_LINES = 30;

/** 判定不能は「正常」ではなく失敗として返す（fail-closed） */
function fail(msg) {
  console.error(`[drift] ${msg}`);
  process.exit(1);
}

let lock;
try {
  lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
} catch (e) {
  fail(`package-lock.json を読めません: ${e.message}`);
}
const packages = (lock && lock.packages) || {};
if (!Object.keys(packages).length) {
  fail("package-lock.json に packages がありません（lockfileVersion 1 は非対応）");
}

const findings = [];
let compared = 0;

for (const [key, meta] of Object.entries(packages)) {
  if (!key.startsWith("node_modules/")) continue;
  if (!meta || meta.link || !meta.version) continue;
  const short = key.slice("node_modules/".length);
  const pj = path.join(ROOT, key, "package.json");
  let raw;
  try {
    raw = fs.readFileSync(pj, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      // optional / dev / peer は「無くてよい」。必須の欠損は壊れた node_modules なので報告する。
      if (!meta.optional && !meta.dev && !meta.peer) {
        findings.push(`${short}: lock=${meta.version} installed=(未インストール)`);
      }
      continue;
    }
    findings.push(`${short}: lock=${meta.version} installed=(読めません: ${e.code || e.message})`);
    continue;
  }
  let installed = null;
  try {
    installed = JSON.parse(raw).version;
  } catch {
    findings.push(`${short}: lock=${meta.version} installed=(package.json が不正)`);
    continue;
  }
  compared++;
  if (installed !== meta.version) {
    findings.push(`${short}: lock=${meta.version} installed=${installed}`);
  }
}

for (const name of KEY_PACKAGES) {
  const meta = packages["node_modules/" + name];
  if (!meta || !meta.version) continue;
  if (!fs.existsSync(path.join(ROOT, "node_modules", name))) {
    findings.push(`${name}: lock=${meta.version} installed=(未インストール)`);
  }
}

if (!findings.length) {
  // 呼び出し側は「出力が空 = 乖離なし」で判定する（従来の契約を維持）
  process.exit(0);
}

for (const line of findings.slice(0, MAX_LINES)) console.log(line);
if (findings.length > MAX_LINES) {
  console.log(`... 他 ${findings.length - MAX_LINES} 件`);
}
process.exit(10);
