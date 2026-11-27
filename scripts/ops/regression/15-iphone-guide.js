"use strict";
// 回帰テスト [15]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 15,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 15. iPhone の通知登録: 案内が必ず呼ばれるか（2026-10-23 追加） ---
    //  実際に起きた事故: iOS 向けガイド（ios-helper.js）は読まれるだけで一度も呼ばれておらず、
    //  通常の Safari で登録を試みると「トグルが戻るだけ」の無言失敗になっていた。
    console.log("\n[15] iPhone 通知登録の案内");
    {
      const helperSrc = fs.readFileSync(path.join(projectDir, "webui", "ios-helper.js"), "utf8");
      ok("ios-helper.js: インスタンスを window.iosHelper として公開する（バンドルから参照できるように）",
        /window\.iosHelper\s*=\s*iosHelper/.test(helperSrc));
      const mainSrc = fs.readFileSync(path.join(projectDir, "webui", "js", "main.js"), "utf8");
      ok("js/main.js: iOS かつホーム画面未追加なら案内を出して登録を中断する",
        /helper\.showInstallGuide\(\)/.test(mainSrc) && /IOS_PWA_REQUIRED/.test(mainSrc) &&
        /helper\.isPWA/.test(mainSrc) && /helper\.isIOS/.test(mainSrc));
      ok("js/main.js: iOS の Chrome は Safari へ誘導する案内を出す（Chrome では PWA 追加不可）",
        /isIOSChrome/.test(mainSrc) && /IOS_CHROME_UNSUPPORTED/.test(mainSrc));
      ok("js/main.js: 通知登録の失敗を無言にしない（理由を表示する）",
        /通知を登録できませんでした/.test(mainSrc));
      // ビルド忘れ（js/main.js を直したのに dist を作り直さない）を検出する。
      // 実測: esbuild の更新だけで dist とソースが 86 bytes 食い違うことがある。
      const bundle = fs.readFileSync(path.join(projectDir, "webui", "dist", "main.bundle.min.js"), "utf8");
      ok("dist/main.bundle.min.js: 案内呼び出しがバンドルに含まれる（ビルド忘れ防止）",
        /showInstallGuide/.test(bundle) && /IOS_PWA_REQUIRED/.test(bundle));
    }
  },
};
