"use strict";
// 回帰テスト [11]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 11,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 11. ハニーポットの不変条件（2026-10-22 追加） ---
    // 偽物の置き場・配信ルール・監視が「安全側の既定」を保っているかを固定する。
    console.log("[11] ハニーポットの不変条件");
    const hpSetup = fs.readFileSync(path.join(projectDir, "scripts", "security", "honeypot-setup.sh"), "utf8");
    const hpWatch = fs.readFileSync(path.join(projectDir, "scripts", "security", "honeypot-watch.js"), "utf8");
    // 旧 apply-honeypot.js は scripts/archive/nginx-apply/ へ退避済み。
    // パッチャの代わりに、適用結果である nginx テンプレートを検査する。
    const hpTemplate = fs.readFileSync(path.join(projectDir, "scripts", "nginx", "templates", "nginx.conf.tmpl"), "utf8");

    // 11-1. 偽物は Web 公開ツリーの外（/var/www/html 配下には置かない）
    ok("honeypot: 置き場が Web 公開ツリーの外",
      /HONEY_DIR="\$\{HONEY_DIR:-\/var\/lib\/mai-push\/honeypot\}"/.test(hpSetup) &&
      !/\/var\/www\/html/.test(hpSetup.replace(/^#.*$/gm, "")));

    // 11-2. 実物の .env を読み込まない・実在中身を複製しない
    ok("honeypot: 実物の .env を参照していない（偽物だけを作る）",
      !/cat\s+\/var\/www\/html\/koinoyamai\.love\/\.env/.test(hpSetup) &&
      !/cp\s+.*\.env\s+\/var\/www/.test(hpSetup));

    // 11-3. 監視が canary token を Doc で見ない（ログの token だけが手掛かり）
    ok("honeypot-watch: canary パスで判定している",
      /canaryPath/.test(hpWatch) && /kind:\s*"canary_used"/.test(hpWatch));
    ok("honeypot-watch: 取得（stolen）と偵察（probe）を区別している",
      /kind:\s*"stolen"/.test(hpWatch) && /kind:\s*"probe"/.test(hpWatch));

    // 11-4. ハニー location は 1717 の vhost だけに入っている
    const hpHoneyIdx = hpTemplate.indexOf("location ~* ^/(?:");
    const hpVhostIdx = hpTemplate.indexOf("listen 1717;");
    ok("nginx テンプレート: ハニーポットは 1717 + koinoyamai.love の vhost のみ対象",
      hpVhostIdx >= 0 && hpHoneyIdx > hpVhostIdx &&
      hpTemplate.slice(hpVhostIdx, hpHoneyIdx).includes("server_name koinoyamai.love;") &&
      (hpTemplate.match(/location ~\* \^\/\(\?:/g) || []).length === 1);
    // 11-5. 正規表現 location は出現順で評価される → PHP location より前にないと機能しない
    ok("nginx テンプレート: ハニー location は PHP location より前にある",
      hpHoneyIdx >= 0 && hpTemplate.indexOf("location ~ \\.php$", hpVhostIdx) > hpHoneyIdx);
    // 11-6. 機密拡張子の deny ルールがある（.zip はアプリの配布物なので除外されている）
    const hpDenyIdx = hpTemplate.indexOf("location ~* ", hpHoneyIdx + 10);
    const hpDenyLine = hpDenyIdx >= 0 ? hpTemplate.slice(hpDenyIdx, hpTemplate.indexOf("\n", hpDenyIdx)) : "";
    ok("nginx テンプレート: 機密拡張子を deny する（.zip は対象外）",
      hpDenyLine.includes("(?:env|") && !/zip/.test(hpDenyLine) &&
      hpTemplate.slice(hpDenyIdx, hpDenyIdx + 400).includes("deny all;"));
    // 11-7. 状態ファイルが setup と watcher で分離されている（同じだと offset 消滅→全件再通知）
    const hpSetupState = /honeypot-canary\.json/.test(hpSetup) ? "honeypot-canary.json" : "";
    const hpWatchState = /honeypot-watch-state\.json/.test(hpWatch) ? "honeypot-watch-state.json" : "";
    ok("honeypot: 状態ファイルが setup と watcher で分離されている",
      hpSetupState !== "" && hpWatchState !== "" && hpSetupState !== hpWatchState);
    // 11-8. `.env` の変種（アンダースコア区切りを含む）も偽物として生成・分類できること
    ok("honeypot-setup: .env の変種（.env.bak 等）を生成する",
      /ENV_VARIANTS=/.test(hpSetup) && /\.env\.\$v/.test(hpSetup) || /\.env\.\{v\}/.test(hpSetup) || /\.env\.\$/.test(hpSetup));
    ok("honeypot-setup: .env_xxx（アンダースコア区切り）の変種も生成する",
      /ENV_VARIANTS_UNDERSCORE=/.test(hpSetup) && /\.env_\$v/.test(hpSetup));
    // パターンは**共有ファイル 1 つ**から読む（3 か所に二重管理しない）
    const hpPatternFile = path.join(projectDir, "scripts", "nginx", "honey-path-pattern.txt");
    const hpPattern = fs.existsSync(hpPatternFile) ? fs.readFileSync(hpPatternFile, "utf8").trim() : "";
    ok("ハニーパターンは共有ファイル 1 つに集約されている", hpPattern.length > 0);
    ok("nginx テンプレート: ハニー location に共有パターンがそのまま入っている",
      hpPattern.length > 0 && hpTemplate.includes(hpPattern));
    ok("honeypot-watch: 共有パターンファイルを読む",
      hpWatch.includes("honey-path-pattern.txt"));
    ok("nginx テンプレート: ハニー location は honeypot 専用ディレクトリから配信する",
      /root \/var\/lib\/mai-push\/honeypot;/.test(hpTemplate) &&
      /access_log \/var\/log\/nginx\/honey\.log honeyfmt;/.test(hpTemplate));
    // 共有パターンで実際の判定が正しいこと（挙動テスト）
    if (hpPattern) {
      const hpRe = new RegExp("/(?:[\\w.\\-]+/)*(?:" + hpPattern + ")(?![.\\w\\-])", "i");
      const shouldMatch = ["/.env", "/.env.bak", "/.env_secret", "/.env_sendgrid",
        "/.env.docker", "/.env.bak.gz", "/workspace/.env", "/var/.env", "/webui/.env"];
      const shouldNotMatch = ["/index.php", "/admin.html", "/api/history",
        "/dl/android.json", "/css/header.css", "/main.js", "/.envx"];
      ok("共有パターン: ハニーパスにマッチする",
        shouldMatch.every((p) => hpRe.test(p)),
        shouldMatch.filter((p) => !hpRe.test(p)).join(", "));
      ok("共有パターン: 通常パスにマッチしない",
        shouldNotMatch.every((p) => !hpRe.test(p)),
        shouldNotMatch.filter((p) => hpRe.test(p)).join(", "));
    }
    // 11-9b. 通知の分割・重複抑制（2026-10-23 追加）
    //    Discord の embed description は 4096 文字上限。超えると**通知全体が 400 で落ちる**。
    //    実事故: 37 件の窃取を 1 通に詰めて落ち、窃取の通知が届かないうえ
    //    失敗ループで偵察が 5 分おきに再送された（「新規ないのに毎回通知」）。
    const chunkMod = require(path.join(projectDir, "scripts", "security", "discord-chunk.js"));
    const longUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const ev37 = Array.from({ length: 37 }, (_, i) => ({
      time: "2026-10-23T05:58:21+09:00", ip: "203.0.113.5", path: `/.env.test${i}`, bytes: 1040, ua: longUa,
    }));
    const stealFmt = (e) => `• \`${e.time}\` **${e.ip}** が \`${e.path}\`（${e.bytes} bytes）を取得\n  UA: \`${e.ua}\``;
    const oneShot = ev37.map(stealFmt).join("\n");
    const chunks37 = chunkMod.chunkLines(ev37, stealFmt);
    ok("discord-chunk: 大きい通知を 4096 文字以内の複数メッセージへ分割する",
      oneShot.length > chunkMod.DISCORD_DESCRIPTION_LIMIT &&
      chunks37.length > 1 &&
      chunks37.every((c) => c.text.length <= chunkMod.BODY_LIMIT));
    ok("discord-chunk: 分割してもイベントを落とさない",
      chunks37.reduce((n, c) => n + c.items.length, 0) === ev37.length);
    ok("discord-chunk: 1 行が上限を超える場合は行を切り詰める",
      chunkMod.chunkLines([{ ua: "u".repeat(9000) }], (e) => `• ${e.ua}`)[0].text.length
        <= chunkMod.BODY_LIMIT);
    ok("discord-chunk: truncate は embed 上限以内に収める",
      chunkMod.truncate("x".repeat(9000), chunkMod.DISCORD_DESCRIPTION_LIMIT - 20).length
        <= chunkMod.DISCORD_DESCRIPTION_LIMIT - 20);
    ok("honeypot-watch: 通知を分割する（1 通に詰め込まない）",
      /chunkLines/.test(hpWatch) && !/probes\.slice\(-10\)/.test(hpWatch));
    ok("honeypot-watch: イベント単位で配送を追跡する（失敗分だけ再送）",
      /e\.notified\s*=\s*!!ok/.test(hpWatch) && /filter\(\(e\)\s*=>\s*!e\.notified\)/.test(hpWatch));
    ok("honeypot-watch: 同じイベントを一定期間は再通知しない（state.recent）",
      /function eventKey/.test(hpWatch) && /state\.recent/.test(hpWatch) && /DEDUPE_HOURS/.test(hpWatch));
    ok("honeypot-watch: canary_used は重複抑制しない（最も重要な証拠）",
      /e\.kind !== "canary_used"/.test(hpWatch));
    // 11-9c. 通数の上限・UA 長・state のアトミック性（独立レビュー B-1 / N-1 / N-4 の恒久化）
    ok("honeypot-watch: 1 カテゴリの送信通数に上限がある（UA 長での通知爆発を防ぐ）",
      /MAX_CHUNKS_PER_CATEGORY\s*=\s*\d+/.test(hpWatch) &&
      /\.slice\(0,\s*MAX_CHUNKS_PER_CATEGORY\)/.test(hpWatch) &&
      /e\.summarized\s*=\s*true/.test(hpWatch));
    ok("honeypot-watch: 通知に載せる UA を切り詰める",
      /MAX_UA_CHARS\s*=\s*\d+/.test(hpWatch) && /clip\(e\.ua, MAX_UA_CHARS\)/.test(hpWatch));
    ok("honeypot-watch: state をアトミックに書く（壊れると全件再通知になる）",
      /renameSync\(tmp, file\)/.test(hpWatch));
    ok("honeypot-watch: 重複キーからクエリ文字列を落とす",
      /split\("\?"\)\[0\]/.test(hpWatch));
    ok("honeypot-watch: HONEY_DEDUPE_HOURS の不正値は既定 24h に倒す",
      /Number\.isFinite\(DEDUPE_HOURS_RAW\)/.test(hpWatch));
    ok("honeypot-watch: --dry-run は状態報告もしない",
      /if \(DRY_RUN\) \{\s*\n\s*log\("\(dry-run\) 状態報告はスキップします/.test(hpWatch));
    ok("notify.sendDiscord: description を上限で切り詰める（安全網）",
      /truncate\(payload\.description/.test(
        fs.readFileSync(path.join(projectDir, "scripts", "security", "notify.js"), "utf8")));

    // 11-9. 自機リクエストを通知しない仕組み（ノイズ防止）があること
    ok("honeypot-watch: 自機リクエストを判定して通知対象から外す",
      /isLocalSelfTest/.test(hpWatch) && /include-local/.test(hpWatch));
    // 11-9. 404（偵察）も honey.log に残る仕組みが入っていること
    ok("nginx テンプレート: 404 を named location へ逃がす（error_page）",
      /error_page 404 = @honey_not_found/.test(hpTemplate) && /location @honey_not_found/.test(hpTemplate));
    // 11-10. 生成の冪等性（render を 2 回実行して差分ゼロ）
    //   宣言的生成では「同じテンプレート + 同じ .env → 同じ出力」が冪等性の本体。
    //   envsubst が無い環境（CI 等）では従来の upload テストと同様にスキップ扱いにする。
    {
      const hpTmp = fs.mkdtempSync(path.join(os.tmpdir(), "honeypot-render-"));
      const dummyEnv = path.join(hpTmp, "dummy.env");
      fs.writeFileSync(dummyEnv, "TAILNET_ADMIN_SECRET=dummy-secret-for-render-test\n");
      const renderSh = path.join(projectDir, "scripts", "nginx", "render.sh");
      const outA = path.join(hpTmp, "a");
      const outB = path.join(hpTmp, "b");
      const runR = (out) => require("child_process").spawnSync(
        "bash", [renderSh, out], { encoding: "utf8", env: { ...process.env, ENV_FILE: dummyEnv } });
      const rA = runR(outA);
      const rB = runR(outB);
      const renderSkipped = rA.status !== 0 && /envsubst/.test(`${rA.stderr || ""}${rA.stdout || ""}`);
      let renderIdem = false;
      try {
        if (rA.status === 0 && rB.status === 0) {
          const listA = require("child_process").spawnSync("diff", ["-r", outA, outB], { encoding: "utf8" });
          renderIdem = listA.status === 0;
        }
      } catch (e) { renderIdem = false; }
      ok("render.sh: 2 回生成しても差分ゼロ（冪等）※envsubst 不在の環境ではスキップ",
        renderSkipped || renderIdem,
        renderSkipped ? "envsubst not available" : `runA=${rA.status} runB=${rB.status}`);
      try { fs.rmSync(hpTmp, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    }
    // 11-11. 挙動テスト（状態管理の不変条件。文字列検査では検出できない）
    const hpSelftest = require("child_process").spawnSync(
      process.execPath,
      [path.join(projectDir, "scripts", "security", "honeypot-watch.js"), "--selftest"],
      { encoding: "utf8", timeout: 30000 }
    );
    const hpSelftestOut = `${hpSelftest.stdout || ""}${hpSelftest.stderr || ""}`;
    const hpFail = (hpSelftestOut.match(/FAIL/g) || []).length;
    ok("honeypot-watch --selftest: 状態管理の不変条件がすべて通る",
      hpSelftest.status === 0 && hpFail === 0,
      `status=${hpSelftest.status} fail=${hpFail} ${hpSelftestOut.slice(-200)}`);

    // 11-12. ハニーポット可視化（管理画面、2026-10-23 追加）
    //   攻撃元の IP・UA・国は**公開に出さない**（§5.3）。集計は services/ に分離してテスト可能に。
    const hpReportPath = path.join(projectDir, "services", "honeypot-report.js");
    const hpReport = require(hpReportPath);
    const hpRouteSrc = fs.readFileSync(path.join(projectDir, "routes", "admin-honeypot.js"), "utf8");
    ok("admin-honeypot: /api/admin/ 配下 + requireAuth（公開エリアに出さない）",
      /app\.get\("\/api\/admin\/honeypot",\s*adminAuth\.requireAuth/.test(hpRouteSrc));
    ok("admin-honeypot: server.js に登録されている",
      /require\("\.\/routes\/admin-honeypot"\)\.register\(app\)/.test(
        fs.readFileSync(path.join(projectDir, "server.js"), "utf8")));
    ok("admin-honeypot: 集計が lib/admin を巻き込まない（HTTP 非依存＝テストが終了する）",
      !/require\("\.\.\/lib\/admin"\)/.test(fs.readFileSync(hpReportPath, "utf8")));
    const hpUnauth = await request("GET", "/api/admin/honeypot?days=7");
    ok("admin-honeypot: 未認証では 401（集計を返さない）",
      hpUnauth.status === 401 && !(hpUnauth.json && hpUnauth.json.totals), `status=${hpUnauth.status}`);
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "honeypot-report-"));
      const logFile = path.join(tmp, "honey.log");
      const canaryFile = path.join(tmp, "canary.json");
      const now = Date.parse("2026-10-23T12:00:00+09:00");
      const line = (iso, ip, cf, xff, st, uri, ua) =>
        `${iso} ip=${ip} cf=${cf} xff="${xff}" st=${st} uri=${uri} bytes=10 req="GET ${uri} HTTP/1.1" ref="-" ua="${ua}"`;
      fs.writeFileSync(canaryFile, JSON.stringify({ token: "abc123", canaryPath: "/_canary/abc123" }));
      fs.writeFileSync(logFile, [
        line("2026-10-23T11:00:00+09:00", "127.0.0.1", "-", "-", 200, "/.env", "curl/8.5.0"), // 自機（除外）
        line("2026-10-23T10:00:00+09:00", "127.0.0.1", "203.0.113.5", "203.0.113.5", 200, "/.env", "Scanner/1.0"), // 窃取
        line("2026-10-23T10:01:00+09:00", "127.0.0.1", "203.0.113.5", "203.0.113.5", 404, "/secrets.json", "Scanner/1.0"), // 偵察
        line("2026-10-23T10:02:00+09:00", "127.0.0.1", "203.0.113.6", "203.0.113.6", 200, "/_canary/abc123", "curl/8.0"), // canary 使用
        line("2026-10-23T10:03:00+09:00", "127.0.0.1", "203.0.113.7", "203.0.113.7", 204, "/_canary/", "curl/8.0"), // canary 探査
        line("2026-10-23T10:04:00+09:00", "127.0.0.1", "203.0.113.8", "203.0.113.8", 404, "/db.sql",
          "Mozilla/5.0 st=200 uri=/.env"), // UA 偽装（実体は 404）
        line("2026-10-15T10:00:00+09:00", "127.0.0.1", "203.0.113.9", "203.0.113.9", 200, "/.env", "old"), // 期間外
      ].join("\n") + "\n");

      const fakeGeo = async (ips) => new Map([...new Set(ips)].map((ip) => [ip, {
        cc: ip === "203.0.113.6" ? "HU" : "US",
        country: ip === "203.0.113.6" ? "ハンガリー" : "アメリカ合衆国",
        asn: "AS64500", org: "TEST-ORG - Example, US", ok: true,
      }]));
      const d = await hpReport.collect({ days: 7, logPath: logFile, canaryStatePath: canaryFile, now, geoLookup: fakeGeo });

      ok("honeypot-report: 自機テストと期間外を除外する",
        d.source.selfTests === 1 && d.totals.events === 5,
        `self=${d.source.selfTests} events=${d.totals.events}`);
      ok("honeypot-report: 窃取 / canary 使用 / 偵察を分類する",
        d.totals.stolen === 1 && d.totals.canaryUsed === 1 && d.totals.probe === 3 &&
        d.totals.canaryScans === 1,
        JSON.stringify(d.totals));
      ok("honeypot-report: UA に紛れ込ませた st= / uri= に騙されない",
        d.recent.filter((r) => r.ua.includes("st=200")).every((r) => r.kind === "probe" && r.status === 404),
        JSON.stringify(d.recent.filter((r) => r.ua.includes("st=200")).map((r) => [r.kind, r.status])));
      ok("honeypot-report: 国別に集計する（IP は重複しない）",
        d.byCountry.length === 2 && d.byCountry[0].cc === "US" && d.byCountry[0].events === 4 &&
        d.totals.ips === 4 && d.totals.countries === 2,
        JSON.stringify(d.byCountry.map((c) => [c.cc, c.events, c.ips])));
      ok("honeypot-report: canary の token を UI に出さない（マスクする）",
        d.recent.every((r) => !r.path.includes("abc123")) &&
        d.topPaths.every((p) => !p.path.includes("abc123")),
        d.recent.map((r) => r.path).join(","));
      ok("honeypot-report: 日別を期間の全日で 0 埋めする（データを隠さない）",
        (d.byDay.length === 7 || d.byDay.length === 8) &&
        d.byDay.every((x) => typeof x.events === "number" && /^\d{4}-\d{2}-\d{2}$/.test(x.date)) &&
        d.byDay[d.byDay.length - 1].date === "2026-10-23",
        `${d.byDay.length} 日: ${d.byDay.map((x) => x.date).join(",")}`);

      // 7 日窓の境界（カレンダー上は 8 日目）のイベントも落とさない
      fs.writeFileSync(logFile, line("2026-10-16T13:00:00+09:00", "127.0.0.1", "203.0.113.30",
        "203.0.113.30", 200, "/.env", "BOUNDARY") + "\n");
      const dB = await hpReport.collect({ days: 7, logPath: logFile, canaryStatePath: canaryFile, now, geoLookup: fakeGeo });
      ok("honeypot-report: 7 日窓の境界（8 日目）のイベントも集計から落とさない",
        dB.totals.events === 1 && dB.byDay.length === 8 && dB.byDay[0].date === "2026-10-16",
        `events=${dB.totals.events} byDay=${dB.byDay.length} first=${dB.byDay[0] && dB.byDay[0].date}`);

      // ローテート前の canary token も watcher と同じく「使用」と判定する
      fs.writeFileSync(canaryFile, JSON.stringify({
        token: "newtok", canaryPath: "/_canary/newtok", previousCanaryPaths: ["/_canary/oldtok"],
      }));
      fs.writeFileSync(logFile, line("2026-10-23T10:05:00+09:00", "127.0.0.1", "203.0.113.31",
        "203.0.113.31", 204, "/_canary/oldtok", "curl/8.0") + "\n");
      const dOld = await hpReport.collect({ days: 7, logPath: logFile, canaryStatePath: canaryFile, now, geoLookup: fakeGeo });
      ok("honeypot-report: ローテート前の canary token も canary_used（watcher と揃える）",
        dOld.totals.canaryUsed === 1 && dOld.totals.canaryScans === 0 && dOld.totals.stolen === 0,
        JSON.stringify(dOld.totals));

      // ローテート済みログ（.1 / .2.gz）も読む（日次ローテートで 7/30/90 日が実質 1 日にならない）
      const rotDir = path.join(tmp, "rot");
      fs.mkdirSync(rotDir, { recursive: true });
      const rot = path.join(rotDir, "honey.log");
      fs.writeFileSync(`${rot}.2.gz`, require("zlib").gzipSync(
        line("2026-10-21T10:00:00+09:00", "127.0.0.1", "203.0.113.40", "203.0.113.40", 200, "/.env", "Z") + "\n"));
      fs.writeFileSync(`${rot}.1`,
        line("2026-10-22T10:00:00+09:00", "127.0.0.1", "203.0.113.41", "203.0.113.41", 200, "/.env", "Y") + "\n");
      fs.writeFileSync(rot,
        line("2026-10-23T10:00:00+09:00", "127.0.0.1", "203.0.113.42", "203.0.113.42", 200, "/.env", "X") + "\n");
      const dRot = await hpReport.collect({ days: 7, logPath: rot, canaryStatePath: canaryFile, now, geoLookup: fakeGeo });
      ok("honeypot-report: ローテート済みログ（.1 / .2.gz）も読む",
        dRot.totals.events === 3 && dRot.byDay.slice(-3).map((x) => x.events).join(",") === "1,1,1",
        `events=${dRot.totals.events} byDay=${dRot.byDay.map((x) => x.events).join(",")}`);

      // パース: uri の実空白・UA の \xHH エスケープ
      const spaced = hpReport.parseLine('2026-10-23T10:00:00+09:00 ip=127.0.0.1 cf=203.0.113.5 xff="203.0.113.5" st=404 uri=/a b bytes=10 req="GET /a%20b HTTP/1.1" ref="-" ua="x"');
      ok("honeypot-report: uri に実空白があってもパースできる（攻撃者が記録を落とせない）",
        !!spaced && spaced.path === "/a b" && spaced.status === 404 && spaced.ua === "x",
        JSON.stringify(spaced));
      const escLine = hpReport.parseLine('2026-10-23T10:00:00+09:00 ip=127.0.0.1 cf=203.0.113.5 xff="-" st=200 uri=/.env bytes=10 req="GET /.env HTTP/1.1" ref="-" ua="Mozilla \\x22q\\x22 end"');
      ok('honeypot-report: nginx の \\x22 エスケープを戻す（UA を正しく表示）',
        !!escLine && escLine.ua === 'Mozilla "q" end', escLine && escLine.ua);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    }

    // 11-12b. 管理画面 JS（時刻の TZ・XSS・異常時の表示）
    const hpJs = fs.readFileSync(path.join(projectDir, "webui", "js", "admin-honeypot.js"), "utf8");
    ok("admin-honeypot.js: 時刻は JST 固定（端末の TZ に依存させない）",
      /timeZone:\s*"Asia\/Tokyo"/.test(hpJs) && /hourCycle:\s*"h23"/.test(hpJs));
    ok("admin-honeypot.js: 攻撃者が制御できる値は esc() を通す（XSS 防止）",
      /function esc\(/.test(hpJs) && /esc\(r\.path\)/.test(hpJs) &&
      /esc\(r\.ua\)/.test(hpJs) && /esc\(r\.ip\)/.test(hpJs));
    ok("admin-honeypot.js: ログが読めない時に黙って「アクセスなし」にしない",
      /logPresent/.test(hpJs) && /canaryConfigured/.test(hpJs) && /skipped/.test(hpJs));

    // 11-12c. スタブ DOM で実際に描画し、例外・XSS・TZ を挙動で確認する（文字列検査だけでは不十分）
    {
      const hpJsPath = path.join(projectDir, "webui", "js", "admin-honeypot.js");
      const fixture = {
        ok: true, days: 7, generatedAt: "2026-10-23T01:00:00.000Z",
        source: {
          logPresent: true, logLines: 1, selfTests: 0, skipped: 0, events: 1,
          firstSeen: "2026-10-22T03:58:43.000Z", lastSeen: "2026-10-23T01:00:39.000Z",
        },
        totals: { events: 1, stolen: 1, canaryUsed: 0, probe: 0, canaryScans: 0, ips: 1, countries: 1, canaryConfigured: true },
        byCountry: [{ cc: "US", country: "アメリカ合衆国<img src=x>", events: 1, stolen: 1, canaryUsed: 0, probe: 0, ips: 1, orgs: [{ org: "<b>x</b>", n: 1 }] }],
        byDay: [
          { date: "2026-10-22", events: 1, stolen: 1, canaryUsed: 0, probe: 0 },
          { date: "2026-10-23", events: 0, stolen: 0, canaryUsed: 0, probe: 0 },
        ],
        topIps: [], topPaths: [{ path: "/.env<img src=x>", events: 1, stolen: 1, canaryUsed: 0, probe: 0 }],
        recent: [{
          time: "2026-10-23T10:00:00+09:00", ip: "<img src=x>", cc: "US", country: "<img>",
          asn: "AS1", org: "<b>", kind: "stolen", status: 200, path: "/.env<img src=x>",
          ua: "<script>alert(1)</script>",
        }],
        note: "note",
      };
      const el = { innerHTML: "", querySelectorAll: () => [], addEventListener: () => {} };
      const saved = { document: global.document, fetch: global.fetch, setInterval: global.setInterval, set: null };
      global.document = {
        getElementById: () => el,
        querySelectorAll: () => [],
        querySelector: () => ({ classList: { contains: () => false } }),
        hidden: false,
      };
      global.fetch = async () => ({ ok: true, status: 200, json: async () => fixture });
      global.setInterval = () => 0;
      let renderError = null;
      try {
        delete require.cache[require.resolve(hpJsPath)];
        require(hpJsPath);
        await sleep(50);
      } catch (e) {
        renderError = e;
      } finally {
        const out = el.innerHTML;
        global.document = saved.document;
        global.fetch = saved.fetch;
        global.setInterval = saved.setInterval;
        try { delete require.cache[require.resolve(hpJsPath)]; } catch (e) { /* best-effort */ }
        ok("admin-honeypot.js: スタブ DOM で例外なく描画し、攻撃者の文字列を esc する",
          !renderError && out.length > 500 &&
          !/<\/?img\b/i.test(out) && !/<script/i.test(out) && out.includes("&lt;img"),
          renderError ? renderError.message : `len=${out.length}`);
        // firstSeen は UTC ISO（03:58Z）→ JST 12:58 で出る（端末 TZ 非依存）
        ok("admin-honeypot.js: 期間表示が JST になる（UTC のまま出さない）",
          /期間内 10\/22 12:58/.test(out), (out.match(/期間内 [^<]{6,40}/) || ["none"])[0]);
      }
    }

    // 11-13. geoip（DNS 方式・外部 DB 不要）の不変条件
    const geoipMod = require(path.join(projectDir, "services", "geoip.js"));
    ok("geoip: IPv4 の問い合わせ名（逆順オクテット）",
      geoipMod.originName("207.175.199.227") === "227.199.175.207.origin.asn.cymru.com");
    ok("geoip: IPv6 の問い合わせ名（nibble 逆順 + origin6）",
      geoipMod.originName("2001:db8::1") ===
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.origin6.asn.cymru.com");
    ok("geoip: 私有/ループバックは問い合わせない（Tailscale 100.64/10 含む）",
      geoipMod.isPrivateIp("100.65.152.57") && geoipMod.isPrivateIp("192.168.1.10") &&
      geoipMod.isPrivateIp("::ffff:127.0.0.1") && !geoipMod.isPrivateIp("8.8.8.8"));
    ok("geoip: 不正な IP は null（DNS を引かない）", geoipMod.originName("not-an-ip") === null);
  },
};
