"use strict";
// 回帰テスト [18]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 18,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 18. cron から直接実行するスクリプトの実行権限（2026-11-09 追加） ---
    // 実測: verify-backup.sh / db-maintenance.sh / dep-update-pr.sh が index 100644 の
    // まま crontab から直接実行され、毎回 "Permission denied" で静かに失敗していた
    // （logs/*.log）。core.fileMode=false の環境では作業ツリーの chmod が index に
    // 反映されないため、**git の index モード**を検査する。
    // 対象外（意図的）:
    //   - scripts/ops/auto-deploy.sh … 有効化すると PROD_DIR / STG_DIR で
    //     `git reset --hard origin/main` が走り、未コミットの作業と staging ブランチを
    //     壊す。dirty ツリー拒否などのガードを入れるまで 100644 のまま据え置く。
    //   - scripts/ops/node-version-check.sh … ディスク上は 755 で動作しているが index は
    //     100644（既存の不整合。別途修正する）。
    console.log("\n[18] cron 実行スクリプトの実行権限");
    {
      const execScripts = [
        "scripts/ops/backup.sh",
        "scripts/ops/backup-offsite.sh",
        "scripts/ops/verify-backup.sh",
        "scripts/ops/db-maintenance.sh",
        "scripts/ops/dep-update-pr.sh",
      ];
      for (const rel of execScripts) {
        const r = require("child_process").spawnSync(
          "git", ["-C", projectDir, "ls-files", "-s", "--", rel], { encoding: "utf8" });
        const mode = String(r.stdout || "").trim().split(/\s+/)[0];
        ok(`実行権限: ${rel} が 100755`, mode === "100755", mode || "not tracked");
      }
    }
  },
};
