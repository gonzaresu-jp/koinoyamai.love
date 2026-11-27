"use strict";
// 回帰テスト [17]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 17,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 17. push エンドポイントの送信前 DNS 検証（2026-10-24 / issue #76） ---
    //  publicHttpUrl はホスト名の**文字列**しか見ないため「ホスト名が内部 IP に解決される」
    //  経路（DNS rebinding）が残っていた。送信直前に dns.lookup して、解決先がすべて
    //  公開 IP でなければ送信しない（fail-closed・既存の登録行は壊さない）。
    console.log("\n[17] push エンドポイントの送信前 DNS 検証");
    {
      // scripts/ops/ からの相対パスではない（projectDir を使う他セクションと同じ）
      const guardMod = require(path.join(projectDir, "lib", "push-endpoint-guard"));
      const { createPushEndpointGuard, pushGuard } = guardMod;
      /** テスト用ガード（lookup を差し替え、cacheTtlMs はケースごとに指定） */
      const mk = (map, o) => createPushEndpointGuard({
        cacheTtlMs: (o && o.cacheTtlMs) || 0,
        timeoutMs: (o && o.timeoutMs) || 1000,
        lookup: async (h) => {
          const hits = map[h];
          if (hits === undefined) { const e = new Error("ENOTFOUND"); e.code = "ENOTFOUND"; throw e; }
          if (hits === "never") return new Promise(() => {});
          return hits.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
        },
      });

      ok("公開 IP に解決するホストは送信を許可する",
        (await mk({ "ok.example.com": ["93.184.216.34"] }).check("https://ok.example.com/push")).ok === true);
      const loop = await mk({ "evil.example.com": ["127.0.0.1"] }).check("https://evil.example.com/push");
      ok("loopback に解決するホストは拒否する（DNS rebinding）",
        loop.ok === false && /non-public-ip\(127\.0\.0\.1\)/.test(loop.reason || ""));
      ok("private 帯域（10.0.0.5）に解決するホストは拒否する",
        (await mk({ "a.example.com": ["10.0.0.5"] }).check("https://a.example.com/push")).ok === false);
      ok("CGNAT / Tailscale 帯域（100.64.0.1）に解決するホストは拒否する",
        (await mk({ "a.example.com": ["100.64.0.1"] }).check("https://a.example.com/push")).ok === false);
      ok("link-local / メタデータ（169.254.169.254）に解決するホストは拒否する",
        (await mk({ "a.example.com": ["169.254.169.254"] }).check("https://a.example.com/push")).ok === false);
      ok("IPv6 ULA（fd00::1）に解決するホストは拒否する",
        (await mk({ "a.example.com": ["fd00::1"] }).check("https://a.example.com/push")).ok === false);
      const mixed = await mk({ "a.example.com": ["93.184.216.34", "10.0.0.5"] }).check("https://a.example.com/push");
      ok("公開 IP が混ざっていても 1 つでも内部宛なら拒否する", mixed.ok === false);
      const noDns = await mk({}).check("https://gone.example.com/push");
      ok("解決できない（ENOTFOUND）ときは拒否する（fail-closed）",
        noDns.ok === false && /dns-failure\(ENOTFOUND\)/.test(noDns.reason || ""));
      const slow = await mk({ "slow.example.com": "never" }, { timeoutMs: 30 }).check("https://slow.example.com/push");
      ok("解決が時間切れ（30ms）なら拒否する（fail-closed）",
        slow.ok === false && /dns-timeout/.test(slow.reason || ""));
      // キャッシュ: TTL 内は lookup を 1 回しか呼ばない（DNS 負荷と遅延を抑える）
      let calls = 0;
      const cached = createPushEndpointGuard({
        cacheTtlMs: 60_000,
        lookup: async () => { calls++; return [{ address: "93.184.216.34", family: 4 }]; },
      });
      const c1 = await cached.check("https://cache.example.com/push");
      const c2 = await cached.check("https://cache.example.com/push");
      ok("TTL 内は 2 回目をキャッシュから返す（lookup は 1 回）",
        c1.ok === true && c2.ok === true && c2.cached === true && calls === 1);
      // IP リテラルは DNS を呼ばずに同じ基準で判定する（lookup が呼ばれたら失敗させる）
      const literal = createPushEndpointGuard({
        cacheTtlMs: 0,
        lookup: async () => { throw new Error("lookup は呼ばれるべきではない"); },
      });
      ok("IP 直書き（192.168.1.9）は DNS を呼ばずに拒否する",
        (await literal.check("http://192.168.1.9/x")).ok === false);
      ok("IPv6 リテラル（[fd00::1]）も DNS を呼ばずに拒否する",
        (await literal.check("http://[fd00::1]/x")).ok === false);
      ok("非 http（webview2://）は non-http を返す（デスクトップ版は従来どおり別経路でスキップ）",
        (await literal.check("webview2://app/push")).reason === "non-http");
      // 呼び出し側（2 経路）が「送信より前」にガードを通ること（順序固定）
      const notifSrc = fs.readFileSync(path.join(projectDir, "services", "notification.js"), "utf8");
      ok("notification.js が webpush.sendNotification より先に pushGuard.check を呼ぶ",
        /pushGuard\.check\(/.test(notifSrc) &&
        notifSrc.indexOf("pushGuard.check") < notifSrc.indexOf("webpush.sendNotification"));
      const msSrc = fs.readFileSync(path.join(projectDir, "src", "core", "milestone.js"), "utf8");
      ok("milestone.js が webpush.sendNotification より先に pushGuard.check を呼ぶ",
        /pushGuard\.check\(/.test(msSrc) &&
        msSrc.indexOf("pushGuard.check") < msSrc.indexOf("webpush.sendNotification"));
      // 既定インスタンスのキャッシュ経路（呼び出し側が使う同じオブジェクト）で拒否できること
      if (typeof pushGuard.primeForTest === "function" && process.env.PUSH_GUARD_DISABLED !== "1") {
        pushGuard.primeForTest("primed.example.com", false, "non-public-ip(127.0.0.1)");
        const primed = await pushGuard.check("https://primed.example.com/x");
        ok("既定インスタンスでも DNS なしで拒否できる（キャッシュ経路）",
          primed.ok === false && primed.cached === true);
      }
      // --- レビュー指摘（2026-10-24）への対応の固定 ---
      // B-1: 無効化インスタンスは「実際に呼んで動く」こと。過去にここが ReferenceError で
      //  全通知が黙って全滅するバグがあった（正規表現の存在確認だけでは検出できない）。
      {
        const guardPath = path.join(projectDir, "lib", "push-endpoint-guard.js");
        const dis = spawnSync(process.execPath, ["-e", `
          process.env.PUSH_GUARD_DISABLED = "1";
          const g = require(${JSON.stringify(guardPath)});
          g.pushGuard.check("https://evil.example.com/push")
            .then((r) => console.log(JSON.stringify({ ok: r.ok, reason: r.reason })))
            .catch((e) => { console.error("THREW:" + e.message); process.exit(2); });
        `], { encoding: "utf8" });
        ok("PUSH_GUARD_DISABLED=1 のときも check() は例外を出さず許可する（緊急無効化が実際に使える）",
          dis.status === 0 && /"ok":true/.test(dis.stdout || "") && !/THREW/.test(dis.stderr || ""));
        // N-1: env のチューニング（PUSH_GUARD_TIMEOUT_MS）が実際に効くこと
        const savedTtl = process.env.PUSH_GUARD_CACHE_TTL_MS;
        const savedTimeout = process.env.PUSH_GUARD_TIMEOUT_MS;
        try {
          delete require.cache[require.resolve(guardPath)];
          process.env.PUSH_GUARD_TIMEOUT_MS = "30";
          const fresh = require(guardPath);
          const g = fresh.createPushEndpointGuard({ lookup: () => new Promise(() => {}) });
          const t0 = Date.now();
          const r = await g.check("https://env.example.com/x");
          ok("PUSH_GUARD_TIMEOUT_MS が効く（30ms で dns-timeout になる）",
            r.ok === false && /dns-timeout/.test(r.reason || "") && (Date.now() - t0) < 2000);
        } finally {
          if (savedTtl === undefined) delete process.env.PUSH_GUARD_CACHE_TTL_MS; else process.env.PUSH_GUARD_CACHE_TTL_MS = savedTtl;
          if (savedTimeout === undefined) delete process.env.PUSH_GUARD_TIMEOUT_MS; else process.env.PUSH_GUARD_TIMEOUT_MS = savedTimeout;
          delete require.cache[require.resolve(guardPath)];
        }
        // N-2: 成功時にもタイマーを片付ける（clearTimeout がないとプロセスが timeoutMs 掴まれ続ける）
        const t0 = Date.now();
        const fast = spawnSync(process.execPath, ["-e", `
          const g = require(${JSON.stringify(guardPath)}).createPushEndpointGuard({
            cacheTtlMs: 0, timeoutMs: 3000,
            lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          });
          g.check("https://fast.example.com/x").then(() => {});
        `], { encoding: "utf8" });
        ok("成功時もタイマーを片付け、プロセスを timeoutMs 掴み続けない（clearTimeout）",
          fast.status === 0 && (Date.now() - t0) < 1500);
        // N-3: lookup が同期 throw しても inflight に詰まらない（2 回目も必ず lookup する）
        let syncCalls = 0;
        const syncThrow = createPushEndpointGuard({
          cacheTtlMs: 0,
          lookup: () => { syncCalls++; throw new Error("boom"); },
        });
        const s1 = await syncThrow.check("https://sync.example.com/x");
        const s2 = await syncThrow.check("https://sync.example.com/x");
        ok("lookup が同期 throw しても再解決できる（inflight に詰まらない）",
          s1.ok === false && s2.ok === false && syncCalls === 2);
      }
            // 無効化は opt-in（既定で有効）。設定し忘れても外れないことを保証する
      ok("検証の無効化は PUSH_GUARD_DISABLED=1 のときだけ（既定は有効）",
        /PUSH_GUARD_DISABLED\s*===\s*"1"/.test(fs.readFileSync(path.join(projectDir, "lib", "push-endpoint-guard.js"), "utf8")) &&
        process.env.PUSH_GUARD_DISABLED !== "1");
      ok("登録側（routes/subscriptions.js）は登録時にもホスト名検証を残している",
        /publicHttpUrl\(/.test(fs.readFileSync(path.join(projectDir, "routes", "subscriptions.js"), "utf8")));
    }
  },
};
