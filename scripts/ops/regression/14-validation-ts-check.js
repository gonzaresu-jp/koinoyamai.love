"use strict";
// 回帰テスト [14]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 14,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 14. 境界バリデーションと型検査の部分導入（2026-10-23 追加） ---
    //  「JSON に型を書くだけでは検証していないのと同じ」。壊れる入力は 400 に倒して可視化する。
    //  型は TypeScript を入れず `// @ts-check` + JSDoc で持つ（ビルドステップを増やさないため）。
    console.log("\n[14] 境界バリデーションと型検査（@ts-check）");
    {
      // ⚠️ `lib/admin.js` をプロセス内で require すると sqlite3 のハンドルが開いたまま残る。
      //  **テスト終了時に DB ファイルを消すと**、起動時の CREATE TABLE が IOERR を起こして
      //  「テストは 190 pass なのにプロセスが非 0 で終了する」（pre-push が落ちる）になる。
      //  そのため固定パスを置き去りにし（/tmp は再起動で消える）、消さない。
      const adminLibDb = path.join(os.tmpdir(), "regression-admin-lib.db");
      const v = require(path.join(projectDir, "lib", "validate.js"));
      const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof v.ValidationError; } };
      ok("lib/validate.js: 文字列の型・長さ・トリムを検証する",
        v.str("x", { field: "a", min: 1, max: 5 }) === "x" && v.str("  x ", { field: "a", trim: true }) === "x");
      ok("lib/validate.js: 型が違う入力は ValidationError（数値・配列・null・boolean の混入）",
        throws(() => v.str(123, { field: "a" })) && throws(() => v.str(null, { field: "a" })) &&
        throws(() => v.num("10", { field: "a" })) && throws(() => v.bool("false", { field: "a" })) &&
        throws(() => v.arr("x", { field: "a" })) && throws(() => v.enumOf("z", { field: "a", values: ["a", "b"] })));
      ok("lib/validate.js: 長さ・範囲・整数・許可キー・http(s) のみ",
        throws(() => v.str("xxxxx", { field: "a", max: 4 })) && throws(() => v.num(11, { field: "a", max: 10 })) &&
        throws(() => v.num(1.5, { field: "a", int: true })) &&
        throws(() => v.objKeys({ evil: 1 }, { field: "a", allowed: ["good"] })) &&
        throws(() => v.httpUrl("javascript:alert(1)", { field: "u" })) &&
        v.httpUrl("https://example.com/x", { field: "u" }) === "https://example.com/x");
      ok("lib/validate.js: null 許容・既定値は指定どおり（送信側の仕様を変えないため）",
        v.str(null, { field: "a", allowNull: true }) === null &&
        v.num(undefined, { field: "a", default: 7 }) === 7 &&
        v.enumOf(undefined, { field: "a", values: ["x"], default: "x" }) === "x");

      // 14-2. /api/notify は HMAC 検証の**後**に型も検証する
      //   （型違いを「認証失敗」として数えると、キーが合っているのに原因不明の失敗になる）
      const sign = require(path.join(projectDir, "src", "core", "notify-sign.js")).signNotifyPayload;
      const postNotify = async (payload) => {
        const bodyStr = JSON.stringify(payload);
        const signed = sign(HMAC_SECRET, bodyStr);
        return request("POST", "/api/notify", {
          headers: {
            "x-notify-token": TOKEN,
            "x-notify-hmac": signed.hmac,
            "x-notify-timestamp": signed.timestamp,
          },
          body: bodyStr,
        });
      };
      const rOk = await postNotify({ type: "regression", data: { title: "テスト", body: "b", url: "/x", tweet_id: 123 } });
      ok("notify 検証: 整形済みペイロードは受理される（test env では抑制）",
        rOk.status === 200 && rOk.json && rOk.json.suppressed === true, `status=${rOk.status} body=${rOk.raw && rOk.raw.slice(0, 80)}`);
      const rExtra = await postNotify({ type: "regression", data: { title: "t", unknownNewField: "x" } });
      ok("notify 検証: 未知のフィールドは弾かない（新フィールド追加を壊さないため）",
        rExtra.status === 200, `status=${rExtra.status}`);
      const rTitle = await postNotify({ type: "regression", data: { title: 123 } });
      ok("notify 検証: title が文字列でなければ 400（DB バインドの静かな失敗を防ぐ）",
        rTitle.status === 400 && /data\.title/.test(rTitle.raw || ""), `status=${rTitle.status} body=${rTitle.raw}`);
      const rLong = await postNotify({ type: "regression", data: { title: "x".repeat(501) } });
      ok("notify 検証: title が上限超過なら 400", rLong.status === 400, `status=${rLong.status}`);
      const rType = await postNotify({ type: "x".repeat(51), data: { title: "t" } });
      ok("notify 検証: type が上限超過なら 400", rType.status === 400, `status=${rType.status}`);
      const rNullData = await postNotify({ type: "regression", data: null });
      ok("notify 検証: data が null なら 400", rNullData.status === 400, `status=${rNullData.status}`);
      const rStrData = await postNotify({ type: "regression", data: "x" });
      ok("notify 検証: data が文字列なら 400", rStrData.status === 400, `status=${rStrData.status}`);
      const rObjTweet = await postNotify({ type: "regression", data: { title: "t", tweet_id: { a: 1 } } });
      ok("notify 検証: tweet_id がオブジェクトなら 400", rObjTweet.status === 400, `status=${rObjTweet.status}`);
      const rArrSetting = await postNotify({ type: "regression", data: { title: "t" }, settingKey: ["x"] });
      ok("notify 検証: settingKey が配列なら 400", rArrSetting.status === 400, `status=${rArrSetting.status}`);
      const rNumType = await postNotify({ type: 123, data: { title: "t" } });
      ok("notify 検証: type が数値なら 400", rNumType.status === 400, `status=${rNumType.status}`);
      const rNoData = await postNotify({ type: "regression", data: [] });
      ok("notify 検証: data がオブジェクトでなければ 400",
        rNoData.status === 400 && /data must be an object/.test(rNoData.raw || ""), `status=${rNoData.status}`);
      const rUnsigned = await (async () => {
        const bodyStr = JSON.stringify({ type: "regression", data: { title: 123 } });
        return request("POST", "/api/notify", {
          headers: { "x-notify-token": TOKEN, "x-notify-hmac": "0".repeat(64), "x-notify-timestamp": String(Math.floor(Date.now() / 1000)) },
          body: bodyStr,
        });
      })();
      ok("notify 検証: HMAC 不一致は 401（検証の前後関係が保たれている）",
        rUnsigned.status === 401, `status=${rUnsigned.status}`);

      // 14-3. 管理ログインの入力（`req.body` は JSON 以外だと undefined）
      const lNoBody = await request("POST", "/api/admin/login");
      ok("admin login: ボディ無しは 500 ではなく 400",
        lNoBody.status === 400, `status=${lNoBody.status}`);
      const lBadType = await request("POST", "/api/admin/login", { body: { username: { $ne: "" }, password: "x" } });
      ok("admin login: 型が違うボディは 400（型違いを「認証失敗」として数えない）",
        lBadType.status === 400, `status=${lBadType.status}`);

      // 14-4. 同名ヘッダが複数（Node は配列で返す）来ても 500 にならない
      process.env.ADMIN_DB_PATH = adminLibDb;
      process.env.TRUST_PROXY = "true";
      const adminLib = require(path.join(projectDir, "lib", "admin.js"));
      ok("admin: X-Forwarded-For が配列でも壊れない（`.split()` で 500 にならない）",
        adminLib.getClientIP({ headers: { "x-forwarded-for": ["1.2.3.4", "5.6.7.8"] }, socket: { remoteAddress: "9.9.9.9" } }) === "1.2.3.4");
      ok("admin: ヘッダが無いときは remoteAddress に倒す",
        adminLib.getClientIP({ headers: {}, socket: { remoteAddress: "9.9.9.9" } }) === "9.9.9.9");

      // 14-5. 型検査は TypeScript を入れずに持つ（ビルド・デプロイ経路を変えない判断）
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
      const depNames = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
      ok("型検査: TypeScript / tsx を依存に入れていない（ビルドステップを増やす判断をしない）",
        !depNames.some((n) => ["typescript", "tsx", "ts-node", "ts-jest", "swc"].includes(n)),
        depNames.filter((n) => /typescript|tsx|swc/.test(n)).join(",") || "なし");
      for (const rel of ["lib/validate.js", "lib/admin.js", "src/core/notify-sign.js", "services/geoip.js"]) {
        const src = fs.readFileSync(path.join(projectDir, rel), "utf8");
        ok(`${rel}: @ts-check と JSDoc で型検査している`,
          /\/\/ @ts-check/.test(src) && /@param|@returns|@property/.test(src));
      }
      ok("notify-sign.js: 署名対象の型を JSDoc で固定（JSON を作り直さないことの明文化）",
        /SignedNotifyPayload/.test(fs.readFileSync(path.join(projectDir, "src", "core", "notify-sign.js"), "utf8")));
      // 14-6. SSRF 対策: push エンドポイントは「公開ホスト」しか登録・送信できない
      //   （web push はクライアントが指定した URL へサーバーが POST するため）
      const routable = (u) => v.isRoutableHost(new URL(u).hostname);
      ok("validate: 公開の push サービスは許可する",
        v.publicHttpUrl("https://fcm.googleapis.com/fcm/send", { field: "u" }) === "https://fcm.googleapis.com/fcm/send" &&
        routable("https://web.push.apple.com/x") && routable("https://updates.push.services.mozilla.com/x"));
      ok("validate: loopback / プライベート / メタデータ / Tailscale は拒否する",
        throws(() => v.publicHttpUrl("http://127.0.0.1:8080/api/notify", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://169.254.169.254/latest/meta-data/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://192.168.1.70:1700/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://10.0.0.5/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://172.16.0.9/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://100.65.152.57/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[::1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[fd00::1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://localhost/x", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://foo.local/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://224.0.0.1/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://255.255.255.255/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://0.0.0.0/", { field: "u" })));
      // IPv6 は `URL.hostname` が**角括弧付き**で返る。括弧を外して nibble 列で判定すること
      // （geoip.isPrivateIp は圧縮表記しか見ていないため、ここでは使わない）。
      ok("validate: IPv6 の loopback / unspecified / link-local / unique-local / multicast を拒否する",
        throws(() => v.publicHttpUrl("http://[::1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[0:0:0:0:0:0:0:1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[::]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[fe80:0:0:0:0:0:0:1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[fd00::1]/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://[ff02::1]/", { field: "u" })));
      ok("validate: IPv4-mapped の 16 進表記も IPv4 として判定する（メタデータ・loopback の迂回を塞ぐ）",
        throws(() => v.publicHttpUrl("http://[::ffff:a9fe:a9fe]/", { field: "u" })) && // 169.254.169.254
        throws(() => v.publicHttpUrl("http://[::ffff:7f00:1]/", { field: "u" })) &&     // 127.0.0.1
        throws(() => v.publicHttpUrl("http://[::ffff:a01:1]/", { field: "u" })) &&      // 10.0.0.1
        v.publicHttpUrl("http://[2606:4700::1111]/", { field: "u" }) === "http://[2606:4700::1111]/");
      // WHATWG パーサの正規化に頼っていることを明示的に固定（hex/8進/10進/短縮表記）
      ok("validate: WHATWG URL パーサが IPv4 の変則表記を正規化する前提を確認",
        new URL("http://0x7f000001/").hostname === "127.0.0.1" &&
        new URL("http://2130706433/").hostname === "127.0.0.1" &&
        new URL("http://0177.0.0.1/").hostname === "127.0.0.1" &&
        throws(() => v.publicHttpUrl("http://0x7f000001/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://2130706433/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://0177.0.0.1/", { field: "u" })) &&
        throws(() => v.publicHttpUrl("http://127.1/", { field: "u" })));

      ok("validate: 非 http（デスクトップアプリの偽エンドポイント）は httpUrl で拒否される",
        throws(() => v.publicHttpUrl("webview2://fake", { field: "u" })) &&
        v.isRoutableHost("100.128.0.1") === true); // CGNAT の外側は通す

      // 14-7. 実サーバーでの挙動（登録時の SSRF 拒否 / デスクトップ用の非 http は通す）
      const subPrivate = await request("POST", "/api/save-platform-settings", {
        body: { clientId: "regression-ssrf", subscription: { endpoint: "http://127.0.0.1:8080/api/notify", keys: {} } },
      });
      ok("save-platform-settings: 内部 URL のエンドポイントは 400（SSRF）",
        subPrivate.status === 400 && /public http/.test(subPrivate.raw || ""), `status=${subPrivate.status} body=${subPrivate.raw}`);
      const subMeta = await request("POST", "/api/save-platform-settings", {
        body: { clientId: "regression-ssrf", subscription: { endpoint: "http://169.254.169.254/latest/meta-data/", keys: {} } },
      });
      ok("save-platform-settings: クラウドメタデータ宛も 400（SSRF）", subMeta.status === 400, `status=${subMeta.status}`);
      const subDesktop = await request("POST", "/api/save-platform-settings", {
        body: { clientId: "regression-desktop", subscription: { endpoint: "webview2://regression", keys: {} } },
      });
      ok("save-platform-settings: デスクトップアプリの非 http エンドポイントは従来どおり受理する",
        subDesktop.status === 200, `status=${subDesktop.status} body=${subDesktop.raw}`);
      const subPublic = await request("POST", "/api/save-platform-settings", {
        body: { clientId: "regression-public", subscription: { endpoint: "https://fcm.googleapis.com/fcm/regression", keys: {} } },
      });
      ok("save-platform-settings: 公開の push サービスは受理する", subPublic.status === 200, `status=${subPublic.status}`);

      // 14-8. OAuth のエラー応答を HTML として返さない（無認証で到達できる）
      const oauthErr = await request("GET", "/auth/discord/callback?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C/script%3E");
      ok("user-auth: OAuth エラーは text/plain で、クエリを HTML にしない",
        oauthErr.status === 400 &&
        String(oauthErr.headers["content-type"] || "").startsWith("text/plain") &&
        !/<script>/i.test(oauthErr.raw || ""),
        `status=${oauthErr.status} ct=${oauthErr.headers["content-type"]} body=${(oauthErr.raw || "").slice(0, 60)}`);

      // 14-9. 無認証の FCM リレー化を防ぐ（send-test にレート制限）
      const sendTestPath = path.join(projectDir, "routes", "android.js");
      ok("android: /api/android/send-test にレート制限がある",
        /app\.post\("\/api\/android\/send-test",\s*androidSendTestLimiter/.test(fs.readFileSync(sendTestPath, "utf8")));
      ok("android: deviceName を型と上限で検証している",
        /str\(deviceName, \{ field: "deviceName", max: 100/.test(fs.readFileSync(sendTestPath, "utf8")));

      // 14-10. その他の境界（ソースの不変条件）
      ok("youtube webhook: 不正な published（Invalid Date）を 24時間フィルタで受けない",
        /Number\.isNaN\(publishedDate\.getTime\(\)\)/.test(
          fs.readFileSync(path.join(projectDir, "src", "scrapers", "youtube.js"), "utf8")));
      ok("rag: transcript 取得の video_id を書式検証 + encodeURIComponent する（他ルートと整合）",
        (() => {
          const src = fs.readFileSync(path.join(projectDir, "routes", "rag.js"), "utf8");
          return /VIDEO_ID_RE\.test\(String\(vid\)\)/.test(src) && /encodeURIComponent\(String\(vid\)\)/.test(src);
        })());
      ok("notification: 送信直前にも公開ホストを検証する（登録後の迂回を塞ぐ）",
        /publicHttpUrl\(subscription\.endpoint/.test(
          fs.readFileSync(path.join(projectDir, "services", "notification.js"), "utf8")));

      ok("型を書いたファイルが実際に型エラーを検出すること（構造の確認）",
        fs.readFileSync(path.join(projectDir, "src", "core", "notify-sign.js"), "utf8").includes("@param {string|null|undefined} secret"));

      // 14-11. ヘッダーのアバターが「壊れた画像」にならない
      // （Google アカウントにプロフィール写真が無いと avatar_url が空になり、
      //   フォールバック先のファイルが無いと 404 の破損アイコンが出ていた / 2026-10-23）
      ok("webui: デフォルトアバター画像が実在する（未設定ユーザーが壊れたアイコンにならない）",
        fs.existsSync(path.join(projectDir, "webui", "default-avatar.webp")));
      ok("webui: アバター読込失敗時のフォールバックがある（外部ホスト不通・欠品）",
        (() => {
          const src = fs.readFileSync(path.join(projectDir, "webui", "js", "header-auth.js"), "utf8");
          return /addEventListener\(['"]error['"]/.test(src) && /default-avatar\.webp/.test(src);
        })());

      // 14-12. Windows アプリの Google ログインは「システムブラウザ＋ループバック」
      // （Google は埋め込みブラウザでのサインインをポリシーで止める＝WebView2 内では
      //   戻ってこない。2026-10-24 実測: アプリからの開始7回・コールバック0回）
      ok("winui: OAuth はシステムブラウザへ委譲する実装がある（DesktopLogin）",
        (() => {
          const p = path.join(projectDir, "Windows", "mai-push-winui", "DesktopLogin.cs");
          if (!fs.existsSync(p)) return false;
          const src = fs.readFileSync(p, "utf8");
          // サーバーが loopback の returnTo に載せる単発コードを /auth/token-exchange に送る
          return src.includes("/auth/token-exchange") && src.includes("127.0.0.1");
        })());
      ok("winui: NavigationStarting が /auth/google をアプリ内遷移させない",
        (() => {
          const src = fs.readFileSync(
            path.join(projectDir, "Windows", "mai-push-winui", "MainWindow.xaml.cs"), "utf8");
          return src.includes('uri.AbsolutePath != "/auth/google"') &&
                 src.includes('uri.AbsolutePath != "/auth/discord"') &&
                 src.includes("TryStartDesktopOAuth");
        })());
    }
  },
};
