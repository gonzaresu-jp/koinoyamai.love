"use strict";
// 回帰テスト [9]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 9,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 9. セキュリティ監視の解析ロジック ---
    // 脆弱性監視（scripts/security/）の判定ロジックは素朴に壊れやすい。
    // ネットワークに出ない純粋な解析部分だけをフィクスチャで検証する。
    console.log("[9] セキュリティ監視の解析ロジック");
    const secChecks = require(path.join(projectDir, "scripts", "security", "checks.js"));
    const secNotify = require(path.join(projectDir, "scripts", "security", "notify.js"));

    // 9-1. バージョン比較
    ok("compareVersions: 24.22.0 < 24.22.1", secChecks.compareVersions("v24.22.0", "24.22.1") === -1);
    ok("compareVersions: 24.22.0 == 24.22.0", secChecks.compareVersions("24.22.0", "v24.22.0") === 0);
    ok("compareVersions: 24.9.0 > 24.10.0 は false（数値比較に落とし込まない）",
      secChecks.compareVersions("24.9.0", "24.10.0") === -1);

    // 9-2. node index.json の解析（security フラグの判定）
    const nodeIdx = secChecks.parseNodeIndex(JSON.stringify([
      { version: "v24.22.3", date: "2026-11-10", security: true, lts: "Krypton" },
      { version: "v24.22.0", date: "2026-10-14", security: false, lts: "Krypton" },
      { version: "v25.0.0", date: "2026-11-01", security: false, lts: false },
    ]));
    ok("parseNodeIndex: 件数", nodeIdx.releases.length === 3);
    ok("parseNodeIndex: security フラグを読む", nodeIdx.releases[0].security === true);
    ok("parseNodeIndex: security=false を保持", nodeIdx.releases[1].security === false);

    // 9-3. PHP ChangeLog の解析（8.3.x セクションと CVE の抽出）
    const phpHtml = `
      <h3>Version 8.3.35</h3><b><time class='releasedate' datetime='2026-09-24'>24 Sep 2026</time></b>
      <p>Fixed bug GHSA-xxxx (CVE-2026-17545).</p>
      <h3>Version 8.3.34</h3><b><time class='releasedate' datetime='2026-08-01'>01 Aug 2026</time></b>
      <p>Fixed bug GHSA-yyyy (CVE-2026-20000).</p>
      <h3>Version 8.2.9</h3><p>Fixed bug (CVE-2026-30000).</p>
    `;
    const phpParsed = secChecks.parsePhpChangelog(phpHtml);
    ok("parsePhpChangelog: 8.3.35 の CVE を取得", (phpParsed["8.3.35"].cves || []).includes("CVE-2026-17545"));
    ok("parsePhpChangelog: 公開日を取得", phpParsed["8.3.35"].date === "2026-09-24");
    ok("parsePhpChangelog: 8.2 系は含めない（8.3 系のみ）", !("8.2.9" in phpParsed));

    // 9-4. Debian パッケージ版から upstream 版を取り出す
    ok("upstreamPhpBaseFromPackage: 8.3.6-0ubuntu0.24.04.12 -> 8.3.6",
      secChecks.upstreamPhpBaseFromPackage("8.3.6-0ubuntu0.24.04.12") === "8.3.6");
    ok("upstreamPhpBaseFromPackage: 8.3.15-1ubuntu8.3 -> 8.3.15",
      secChecks.upstreamPhpBaseFromPackage("8.3.15-1ubuntu8.3") === "8.3.15");

    // 9-5. apt の dist-upgrade 出力（security pocket の判定）
    const aptOut = [
      "Inst ca-certificates [20260601~24.04.1] (20260816ubuntu0.24.04.1 Ubuntu:24.04/noble-security [all])",
      "Inst google-chrome-stable [155.0.1-1] (156.0.2-1 Google:1.0/stable [amd64])",
      "Inst liblzma5 [5.6.1+really5.4.5-1ubuntu0.3] (5.6.1+really5.4.5-1ubuntu0.4 Ubuntu:24.04/noble-security [amd64])",
    ].join("\n");
    const aptParsed = secChecks.parseAptDistUpgrade(aptOut);
    ok("parseAptDistUpgrade: security は 2 件", aptParsed.security.length === 2);
    ok("parseAptDistUpgrade: security 以外は other", aptParsed.other.length === 1);
    ok("parseAptDistUpgrade: パッケージ名を取り出す", aptParsed.security[0].startsWith("ca-certificates "));

    // 9-6. npm audit の解析
    const auditParsed = secChecks.parseNpmAudit(JSON.stringify({
      metadata: { vulnerabilities: { total: 2, critical: 1, high: 0, moderate: 0, low: 1, info: 0 } },
      vulnerabilities: {
        proxyaddr: { name: "proxy-addr", severity: "critical", isDirect: false, range: "1.1.0 - 2.0.7", fixAvailable: true, via: [{ url: "https://github.com/advisories/GHSA-jqcg-44mw-7w3h" }] },
        lowpkg: { name: "lowpkg", severity: "low", isDirect: true, range: "1.0.0", fixAvailable: false, via: [] },
      },
    }));
    ok("parseNpmAudit: 件数", auditParsed.advisories.length === 2);
    ok("parseNpmAudit: critical が先", auditParsed.advisories[0].severity === "critical");
    ok("parseNpmAudit: advisory URL を保持", (auditParsed.advisories[0].via || []).some((u) => String(u).includes("GHSA-")));

    // 9-7. 通知の差分判定（新規 / 継続 / 解消 / 承認済み）
    const nowIso = new Date().toISOString();
    const f1 = { key: "php:CVE-2026-0001", severity: "critical", source: "php", title: "A" };
    const f2 = { key: "npm:foo", severity: "warning", source: "npm", title: "B" };
    const st0 = { findings: {}, acknowledged: {} };
    const d1 = secNotify.diffFindings(st0, [f1, f2], { now: nowIso });
    ok("diffFindings: 初回は全部新規", d1.isNew.length === 2 && d1.repeating.length === 0);

    // 通知が成功した前提（lastNotified が入る）で 2 回目を実行する
    secNotify.markNotified(d1.current, [f1.key, f2.key]);
    const st1 = { findings: d1.current, acknowledged: {} };
    const d2 = secNotify.diffFindings(st1, [f1, f2], { now: nowIso });
    ok("diffFindings: 2回目は新規なし", d2.isNew.length === 0 && d2.repeating.length === 0);

    // 8 日後に critical が残る → 継続として再通知
    const later = new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString();
    const d3 = secNotify.diffFindings(st1, [f1, f2], { now: later });
    ok("diffFindings: critical は 7 日超で再通知", d3.repeating.length === 1 && d3.repeating[0].key === f1.key);
    ok("diffFindings: warning は再通知しない", d3.repeating.every((f) => f.severity === "critical"));

    // 解消
    const d4 = secNotify.diffFindings(st1, [f1], { now: nowIso });
    ok("diffFindings: 解消を検出", d4.resolved.includes("npm:foo"));

    // 承認済みは通知対象外
    const st2 = { findings: d1.current, acknowledged: { "php:CVE-2026-0001": { note: "影響なし", at: nowIso } } };
    const d5 = secNotify.diffFindings(st2, [f1, f2], { now: nowIso });
    ok("diffFindings: 承認済みは new/repeating に出ない", d5.isNew.length === 0 && d5.repeating.length === 0);
    ok("diffFindings: 承認済みは acknowledged に残る", d5.acknowledged.length === 1);

    // 9-8. 公開サマリに詳細（CVE ID）を漏らさない
    const pub = secChecks.publicSummary([
      { source: "php", status: "degraded", summary: "要対応 3 件", findings: [{ severity: "critical", key: "php:CVE-2026-12184" }] },
      { source: "node", status: "ok", summary: "最新", findings: [] },
    ]);
    ok("publicSummary: CVE ID を含まない", !pub.includes("CVE-2026-12184"));
    ok("publicSummary: 件数だけ出す", pub.includes("要対応 1 件"));

    // 9-9. 報告先のポート解決（AGENTS.md §1 の事故対策）
    //   本番ツリーでは cwd 一致の最初の apps が worker(3002) になる。
    //   server.js の API アプリを名指しで選ばないと 3002 に POST して 404 になる。
    //   環境（作業ツリーのパス）に依存しないよう、純粋関数にフィクスチャで検証する。
    const watchMod = require(path.join(projectDir, "scripts", "security", "security-watch.js"));
    ok("resolveApiBase が export されている", typeof watchMod.resolveApiBase === "function");
    const fixtureApps = [
      { name: "mai-push-worker", script: "./main.js", cwd: "/repo", env: { PORT: "3002" } },
      { name: "discord-bot", script: "./discord-bot.js", cwd: "/repo", env: {} },
      { name: "mai-push-api", script: "./server.js", cwd: "/repo", env: { PORT: "8080" } },
      { name: "mai-push-api-test", script: "./server.js", cwd: "/repo-test", env: { PORT: "8081" } },
    ];
    ok("resolveApiBase: worker を先に並べても API ポートを返す",
      watchMod.resolveApiBase(fixtureApps, "/repo") === "http://127.0.0.1:8080");
    ok("resolveApiBase: cwd が違えば選ばない",
      watchMod.resolveApiBase(fixtureApps, "/repo-test") === "http://127.0.0.1:8081");
    ok("resolveApiBase: 一致する API アプリが無い場合は null（fail-closed）",
      watchMod.resolveApiBase(fixtureApps, "/other") === null);
    ok("resolveApiBase: worker のポート(3002/3003)を返さない",
      !/300[23]$/.test(String(watchMod.resolveApiBase(fixtureApps, "/repo"))));

    // 9-10. npm audit のエラー出力を「問題なし」にしない（fail-closed）
    let auditErr = null;
    try { secChecks.parseNpmAudit(JSON.stringify({ error: { code: "ENOLOCK", summary: "lockfile not found" } })); } catch (e) { auditErr = e; }
    ok("parseNpmAudit: error JSON は例外になる（正常扱いしない）", auditErr !== null);
    let auditErr2 = null;
    try { secChecks.parseNpmAudit(JSON.stringify({ vulnerabilities: {} })); } catch (e) { auditErr2 = e; }
    ok("parseNpmAudit: metadata 無しも例外になる", auditErr2 !== null);

    // 9-11. 指摘 key の粒度（同じ key のままだと新しいバージョンが通知されない）
    ok("key に Node のバージョンが含まれる: node:update:24:v24.23.0",
      /node:update:24:v24\.23\.0/.test("node:update:24:v24.23.0"));

    // 9-12. 深刻度が上がった finding は新規として通知される
    const nowIso2 = new Date().toISOString();
    const sevLow = { key: "npm:foo:GHSA-1", severity: "info", source: "npm", title: "A" };
    const sevHigh = { key: "npm:foo:GHSA-1", severity: "critical", source: "npm", title: "A" };
    const stSev = { findings: { "npm:foo:GHSA-1": { firstSeen: nowIso2, lastNotified: nowIso2, severity: "info", title: "A" } }, acknowledged: {} };
    const dSev = secNotify.diffFindings(stSev, [sevHigh], { now: nowIso2 });
    ok("diffFindings: 深刻度上昇は新規扱い", dSev.isNew.length === 1 && dSev.repeating.length === 0);

    // 9-13. 通知に失敗した指摘は lastNotified を更新しない（次回も通知される）
    const stFail = { findings: { "npm:bar:GHSA-2": { firstSeen: nowIso2, lastNotified: null, severity: "warning", title: "B" } }, acknowledged: {} };
    const dFail = secNotify.diffFindings(stFail, [{ key: "npm:bar:GHSA-2", severity: "warning", source: "npm", title: "B" }], { now: nowIso2 });
    ok("diffFindings: lastNotified=null は通知対象になる（再送される）", dFail.isNew.length === 1);
    ok("diffFindings: lastNotified は diff だけでは更新されない", dFail.current["npm:bar:GHSA-2"].lastNotified === null);
    secNotify.markNotified(dFail.current, ["npm:bar:GHSA-2"]);
    ok("markNotified: 通知成功時だけ lastNotified が入る", typeof dFail.current["npm:bar:GHSA-2"].lastNotified === "string");

    // 9-14. Discord の本文が上限を超えない（超えると通知が丸ごと落ちる）
    const many = [];
    for (let i = 0; i < 60; i++) {
      many.push({ key: `npm:pkg${i}:GHSA-${i}`, severity: i === 0 ? "critical" : "warning", source: "npm", title: `パッケージ pkg${i} に脆弱性`, detail: "x".repeat(200) });
    }
    const desc = secNotify.formatFindings(many, { hostname: "test-host" });
    ok(`formatFindings: 上限以内（実際 ${desc.length} / 上限 ${secNotify.DISCORD_DESCRIPTION_LIMIT}）`, desc.length <= secNotify.DISCORD_DESCRIPTION_LIMIT);
    ok("formatFindings: 重大の項目は残す", desc.includes("pkg0"));

    // 9-15. PHP の fail-closed（upstream が読めても解析結果が空なら「正常」にしない）
    const phpEmpty = await secChecks.checkPhp({
      pkgVersion: "8.3.6-0ubuntu0.24.04.12",
      debianChangelog: path.join(projectDir, "webui", "updatelogs.php"), // CVE を含まないファイルを渡す
    });
    ok("checkPhp: CVE 記載が無い changelog は error（大量誤検出を防ぐ）", phpEmpty.status === "error");
    ok("checkPhp: error 時は findings が空でない", phpEmpty.findings.length > 0);

    // 9-16. PHP: Ubuntu tracker による「対象外」判定（2026-10-23 追加）
    // upstream の changelog に CVE があっても、Ubuntu がそのリリースの php8.3 に
    // 影響しないと判定しているもの（not-affected / ignored）は critical にしない。
    const trackerFixture = {
      packages: [
        { name: "php8.3", statuses: [
          { release_codename: "noble", status: "not-affected", description: "" },
          { release_codename: "jammy", status: "DNE", description: "" },
        ] },
        { name: "php8.4", statuses: [
          { release_codename: "noble", status: "ignored", description: "windows only" },
        ] },
      ],
    };
    ok("ubuntuTrackerStatus: noble の状態を取り出す",
      secChecks.ubuntuTrackerStatus(trackerFixture, "php8.3", "noble").status === "not-affected");
    ok("ubuntuTrackerStatus: DNE もそのまま返す",
      secChecks.ubuntuTrackerStatus(trackerFixture, "php8.3", "jammy").status === "DNE");
    ok("ubuntuTrackerStatus: 記載の無いパッケージは status=null",
      secChecks.ubuntuTrackerStatus(trackerFixture, "php9.0", "noble").status === null);
    ok("isUbuntuNotAffected: not-affected は対象外", secChecks.isUbuntuNotAffected("not-affected") === true);
    ok("isUbuntuNotAffected: ignored windows only は対象外",
      secChecks.isUbuntuNotAffected("ignored windows only") === true);
    ok("isUbuntuNotAffected: needed は対象（要対応）", secChecks.isUbuntuNotAffected("needed") === false);
    ok("isUbuntuNotAffected: released は対象（要対応）", secChecks.isUbuntuNotAffected("released") === false);
    ok("isUbuntuNotAffected: 空/NULL は対象（fail-closed）",
      secChecks.isUbuntuNotAffected(null) === false && secChecks.isUbuntuNotAffected("") === false);

    const split = secChecks.splitPhpTrackerView(
      ["CVE-1", "CVE-2", "CVE-3", "CVE-4"],
      [
        { status: "fulfilled", value: { status: "not-affected" } },
        { status: "fulfilled", value: { status: "ignored windows only" } },
        { status: "fulfilled", value: { status: "needed" } },
        { status: "rejected", reason: new Error("network") },
      ],
    );
    ok("splitPhpTrackerView: 対象外 2 件・要対応 2 件に分かれる",
      split.excluded.length === 2 && split.actionable.length === 2);
    ok("splitPhpTrackerView: tracker 失敗は要対応（fail-closed）",
      split.actionable.some((a) => a.cve === "CVE-4" && /network/.test(a.error || "")));
    ok("splitPhpTrackerView: 対象外の key が正しい",
      split.excluded.map((e) => e.cve).join(",") === "CVE-1,CVE-2");

    // 9-17. checkPhp 本体の統合（changelogHtml / trackerStatus を注入してネットワーク非依存に）
    // 純関数だけでは「summary / status / findings の分岐」が壊れても検出できない。
    // php.net と ubuntu.com を注入で差し替え、判定ロジックそのものを固定する。
    const phpLogFixture = path.join(os.tmpdir(), `mai-php-changelog-${process.pid}.gz`);
    fs.writeFileSync(phpLogFixture, require("zlib").gzipSync(Buffer.from(
      "php8.3 (1:8.3.6-0ubuntu0.24.04.13) noble-security; urgency=medium\n\n" +
      "  * SECURITY UPDATE: CVE-2020-1234（365日窓の外なので対象外）\n\n" +
      " -- Ubuntu <sec@ubuntu.com>  Mon, 21 Oct 2026 00:00:00 +0900\n")));
    const phpFixtureBase = {
      pkgVersion: "8.3.6-0ubuntu0.24.04.13",
      debianChangelog: phpLogFixture,
      changelogHtml: [
        "<h3>Version 8.3.32</h3><p datetime='2026-07-02'>CVE-2026-12184</p>",
        "<h3>Version 8.3.33</h3><p datetime='2026-07-30'>CVE-2026-9672</p>",
      ].join("\n"),
      ubuntuCodename: "noble",
    };
    const phpAllExcluded = await secChecks.checkPhp(Object.assign({}, phpFixtureBase, {
      trackerStatus: async () => ({ status: "not-affected" }),
    }));
    ok("checkPhp: tracker がすべて「対象外」なら ok", phpAllExcluded.status === "ok");
    ok("checkPhp: summary に「対象外 2 件」が出る（要対応は無い）",
      /対象外 2 件/.test(phpAllExcluded.summary) && !/要対応/.test(phpAllExcluded.summary));
    ok("checkPhp: findings はすべて info に落ちる",
      phpAllExcluded.findings.length === 2 && phpAllExcluded.findings.every((f) => f.severity === "info"));

    const phpTrackerDown = await secChecks.checkPhp(Object.assign({}, phpFixtureBase, {
      trackerStatus: async () => { throw new Error("tracker down"); },
    }));
    ok("checkPhp: tracker が全滅しても degraded（fail-closed）", phpTrackerDown.status === "degraded");
    ok("checkPhp: tracker 失敗の 2 件は critical のまま",
      phpTrackerDown.findings.filter((f) => f.severity === "critical").length === 2);
    ok("checkPhp: tracker の失敗理由が detail に入る",
      phpTrackerDown.findings.every((f) => /tracker down/.test(f.detail || "")));

    const phpMixed = await secChecks.checkPhp(Object.assign({}, phpFixtureBase, {
      trackerStatus: async (cve) => (
        cve === "CVE-2026-12184" ? { status: "not-affected" } : { status: "needed" }
      ),
    }));
    ok("checkPhp: 混在時は「要対応 1 件（対象外 1 件）」",
      phpMixed.status === "degraded" && /要対応 1 件（対象外 1 件）/.test(phpMixed.summary));
    fs.unlinkSync(phpLogFixture);
  },
};
