"use strict";
// 回帰テスト [10]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 10,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 10. PHP 実行時ハードニングの不変条件（2026-10-21 追加） ---
    // php-fpm は `enable_post_data_reading=Off` / `disable_functions` / `open_basedir` で
    // 実行時を制限する（scripts/php/apply-php-hardening.sh）。
    // その前提が壊れたまま放置されると、PHP コア RCE の被害が即座に拡大する。
    // そのため **アプリ側で守らなければならない前提**をここで固定する。
    console.log("[10] PHP ハードニングの不変条件");
    const phpFiles = fs.readdirSync(path.join(projectDir, "webui"))
      .filter((f) => f.endsWith(".php"))
      .map((f) => path.join(projectDir, "webui", f));

    /** PHP のコメントを除去して、コードだけを見る（行コメントとブロックコメント） */
    function stripPhpComments(src) {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
        .replace(/#[^\n]*/g, " ");
    }
    const phpCode = phpFiles.map((f) => ({ file: f, code: stripPhpComments(fs.readFileSync(f, "utf8")) }));

    // 10-1. POST/FILE を読まない（enable_post_data_reading=Off の前提）
    const postUsers = phpCode.filter((p) => /\$_(POST|FILES|REQUEST)\b/.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php は $_POST/$_FILES/$_REQUEST を読まない", postUsers.length === 0, postUsers.join(", "));

    // 10-2. POST するフォームがない
    const postForms = phpCode.filter((p) => /<form[^>]*method\s*=\s*["']?post/i.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php に method=post のフォームがない", postForms.length === 0, postForms.join(", "));

    // 10-3. mbstring を使わない（mbstring は未導入 → 呼ぶと 500 になる）
    const mbUsers = phpCode.filter((p) => /\bmb_[a-z_]+\s*\(/.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php は mb_* を呼ばない", mbUsers.length === 0, mbUsers.join(", "));

    // 10-4. 危険な実行系を使わない（RCE 後の到達点を作らない）
    const dangerRe = /\b(eval|assert|system|exec|shell_exec|passthru|popen|proc_open|pcntl_exec|dl|unserialize|create_function)\s*\(/;
    const dangerUsers = phpCode.filter((p) => dangerRe.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php に eval/system/exec/unserialize 等がない", dangerUsers.length === 0, dangerUsers.join(", "));

    // 10-5. 動的 include がない
    const dynInclude = phpCode.filter((p) => /(include|require)(_once)?\s*\(?\s*\$/.test(p.code)).map((p) => path.basename(p.file));
    ok("webui/*.php に動的 include/require がない", dynInclude.length === 0, dynInclude.join(", "));

    // 10-6. archive.php の $domain スコープ（関数内で global 宣言する）
    //      漏れるとサーバサイドSEOが空になる（2026-10-21 実測）
    const archiveCode = fs.readFileSync(path.join(projectDir, "webui", "archive.php"), "utf8");
    ok("archive.php: mai_archive_fetch が global $domain を持つ",
      /function\s+mai_archive_fetch[\s\S]*?global\s+\$domain\s*[;,]/.test(archiveCode));
    ok("archive.php: ローカル API（$apiBase）を先に叩く（往復滞后を避ける）",
      /global\s+\$domain\s*,\s*\$apiBase\s*;/.test(archiveCode) &&
      /file_get_contents\(\s*\$apiBase\s*\./.test(archiveCode));

    // 10-6b. _domain.php のローカル API ポート導出（本番 8080 / staging 8081）
    const domainCode = fs.readFileSync(path.join(projectDir, "webui", "_domain.php"), "utf8");
    ok("_domain.php: staging(test.) は 8081 / それ以外は 8080 を導出する",
      /8081/.test(domainCode) && /8080/.test(domainCode) && /strpos\(\s*\$host\s*,\s*'test\.'\s*\)/.test(domainCode));

    // 10-7. ハードニングの適用スクリプトが想定どおりの値を設定している
    const hardenSh = fs.readFileSync(path.join(projectDir, "scripts", "php", "apply-php-hardening.sh"), "utf8");
    ok("apply-php-hardening.sh: enable_post_data_reading=Off を設定する",
      /set_pool\s+"enable_post_data_reading"\s+"Off"/.test(hardenSh));
    ok("apply-php-hardening.sh: ffi.enable=preload を設定する",
      /set_pool\s+"ffi\.enable"\s+"preload"/.test(hardenSh));
    ok("apply-php-hardening.sh: disable_functions / open_basedir を設定する",
      /set_ini\s+"disable_functions"/.test(hardenSh) && /set_ini\s+"open_basedir"/.test(hardenSh));

    // 10-8. nginx の PHP 実行ガードが elza vhost に取り込まれている（テンプレート管理）
    //   旧 apply-php-exec-guard.js は scripts/archive/nginx-apply/ へ退避済み。
    //   ガードの結果（elza vhost 内の旧 PHP の 404 化）がテンプレートに残ることを固定する。
    const nginxTmpl = fs.readFileSync(path.join(projectDir, "scripts", "nginx", "templates", "nginx.conf.tmpl"), "utf8");
    const elzaStart = nginxTmpl.indexOf("server_name ${TAILNET_HOSTNAME};");
    const mainVhostStart = nginxTmpl.indexOf("listen 1717;");
    const henkanIdx = nginxTmpl.indexOf("location = /henkan/henkan.php");
    const statusIdx = nginxTmpl.indexOf("location = /status.php");
    ok("nginx テンプレート: PHP 実行ガードは elza vhost 内にある（1717 本番 vhost には入れない）",
      elzaStart >= 0 && henkanIdx > elzaStart && statusIdx > elzaStart &&
      (mainVhostStart === -1 || (henkanIdx < mainVhostStart && statusIdx < mainVhostStart)));
    ok("nginx テンプレート: 旧 PHP（henkan / status.php）を 404 にする（return 404）",
      /location = \/henkan\/henkan\.php \{\s*return 404;/.test(nginxTmpl) &&
      /location = \/status\.php \{\s*return 404;/.test(nginxTmpl));
  },
};
