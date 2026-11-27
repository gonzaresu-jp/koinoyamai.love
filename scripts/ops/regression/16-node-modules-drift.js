"use strict";
// 回帰テスト [16]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 16,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 16. 依存更新の本番反映: 乖離検出が「全パッケージ」を見るか（2026-10-24 追加） ---
    //  実測事故: 監視対象が固定 9 個だったため body-parser 2.3.0→2.4.0 / 入れ子 undici
    //  6.28.1→6.29.1 / qs 6.16.0→6.16.1 の更新を npm-deploy.sh が「乖離なし」と誤判定し、
    //  install をスキップした（lockfile だけ新しく実体は脆弱なまま＝偽の安全感）。
    console.log("\n[16] node_modules の乖離検出（全パッケージ）");
    {
      const helper = path.join(projectDir, "scripts", "deploy", "check-node-modules-drift.js");
      ok("check-node-modules-drift.js が存在する", fs.existsSync(helper));
      const npmDeploy = fs.readFileSync(path.join(projectDir, "scripts", "deploy", "npm-deploy.sh"), "utf8");
      ok("npm-deploy.sh が共通ヘルパで乖離判定する（固定リストを廃止）",
        /check-node-modules-drift\.js/.test(npmDeploy) && !/KEY_PACKAGES=\(/.test(npmDeploy));
      const driftSh = fs.readFileSync(path.join(projectDir, "scripts", "deploy", "check-drift.sh"), "utf8");
      ok("check-drift.sh [3.5] も共通ヘルパを使う",
        /check-node-modules-drift\.js/.test(driftSh) && !/"proxy-addr","sharp","esbuild"/.test(driftSh));
      // 機能テスト: 一時ツリーで「lockfile と実体が違う」を検出できるか
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
      try {
        fs.mkdirSync(path.join(tmp, "node_modules", "foo"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "package-lock.json"),
          JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/foo": { version: "2.0.0" } } }));
        fs.writeFileSync(path.join(tmp, "node_modules", "foo", "package.json"),
          JSON.stringify({ name: "foo", version: "1.0.0" }));
        const r = spawnSync(process.execPath, [helper], { cwd: tmp, encoding: "utf8" });
        ok("乖離（lock=2.0.0 / installed=1.0.0）を exit 10 で報告する",
          r.status === 10 && /foo: lock=2\.0\.0 installed=1\.0\.0/.test(r.stdout));
        fs.writeFileSync(path.join(tmp, "node_modules", "foo", "package.json"),
          JSON.stringify({ name: "foo", version: "2.0.0" }));
        const r2 = spawnSync(process.execPath, [helper], { cwd: tmp, encoding: "utf8" });
        ok("一致時は何も出力せず exit 0（呼び出し側の「空＝一致」契約を維持）",
          r2.status === 0 && r2.stdout.trim() === "");
        fs.rmSync(path.join(tmp, "package-lock.json"));
        const r3 = spawnSync(process.execPath, [helper], { cwd: tmp, encoding: "utf8" });
        ok("lockfile が無いときは exit 1（判定不能を正常に倒さない）", r3.status === 1);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      // npm-deploy.sh の fail-closed（最も重要な性質）: lockfile が壊れているときは
      // pm2 を止める前に exit 1 する。「空出力＝乖離なし」に倒れて install をスキップしない。
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "drift-deploy-"));
      try {
        fs.writeFileSync(path.join(tmp2, "package-lock.json"), "{ broken json ");
        // NODE_BIN を明示する（CI には /home/yuzuki/.nvm/... が無く、
        // npm-deploy.sh の既定値だと「node が見つかりません」で
        // ロックファイルの検査より前に exit 1 して乖離チェックの文言が出てこない＝誤検知）
        const r4 = spawnSync("bash", [path.join(projectDir, "scripts", "deploy", "npm-deploy.sh")], {
          cwd: tmp2, encoding: "utf8",
          env: { ...process.env, ROOT: tmp2, NODE_BIN: process.execPath },
        });
        const all4 = (r4.stdout || "") + (r4.stderr || "");
        ok("lockfile 破損時は npm-deploy.sh が pm2 を触らず exit 1（fail-closed）",
          r4.status === 1 && /乖離チェック自体に失敗/.test(all4) && !/停止対象/.test(r4.stdout || ""));
      } finally {
        fs.rmSync(tmp2, { recursive: true, force: true });
      }
    }
  },
};
