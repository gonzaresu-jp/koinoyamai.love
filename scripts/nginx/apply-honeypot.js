#!/usr/bin/env node
/**
 * apply-honeypot.js — nginx.conf に「ハニーポット（偽物の秘密ファイル）」の配信設定を入れる
 *
 * 入れるもの（`listen 1717` + `server_name koinoyamai.love` の vhost のみ）:
 *   1. `location ~* <機密ファイル名パターン>` → `/var/lib/mai-push/honeypot/` から配信
 *      ・**他の場所の実ファイルは一切公開しない**（この location が先にマッチするため）
 *      ・専用の access_log（時刻・UA 入り）へ記録
 *   2. `location ^~ /_canary/` → 204 を返し honey.log に記録
 *      （偽物の中身を「使った」証拠。窃取の確定判定に使う）
 *   3. 機密拡張子の deny ルール（上記パターン以外の .env/.sql/.pem 等）
 *   4. `log_format honeyfmt`（http ブロック。時刻・UA・クライアント IP 入り）
 *
 * 入れないもの:
 *   - staging vhost（/etc/nginx/mai-test.conf）… 別ファイルなので触らない
 *   - elza vhost（tailnet 専用・既に deny ルールあり）
 *
 * 方針（apply-php-exec-guard.js と共通）:
 *   - 冪等（マーカーがあれば exit 0）
 *   - fail-closed（アンカーが 0 件 or 複数なら **何も書かず** exit 1）
 *   - コメント・引用符をマスクした文字列で brace 深さを数える
 *
 * 使い方:
 *   node apply-honeypot.js <nginx.conf> [outfile]
 */
const fs = require("fs");

const [confPath, outPath] = process.argv.slice(2);
if (!confPath) {
  console.error("usage: node apply-honeypot.js <nginx.conf> [outfile]");
  process.exit(2);
}

let conf = fs.readFileSync(confPath, "utf8");
const MARK = "honeypot-guard";
const HONEY_DIR = "/var/lib/mai-push/honeypot";

/** コメント・引用符を空白にマスクする（長さ不変） */
function maskNoise(text) {
  const out = text.split("");
  const n = text.length;
  let i = 0;
  let inQuote = null;
  while (i < n) {
    const ch = text[i];
    if (inQuote) {
      if (ch === "\\") { out[i] = " "; if (i + 1 < n) out[i + 1] = " "; i += 2; continue; }
      if (ch === inQuote) { inQuote = null; out[i] = " "; i++; continue; }
      out[i] = " ";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; out[i] = " "; i++; continue; }
    if (ch === "#") {
      while (i < n && text[i] !== "\n") { out[i] = " "; i++ }
      continue;
    }
    i++;
  }
  return out.join("");
}

function matchBrace(m, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < m.length; i++) {
    if (m[i] === "{") depth++
    else if (m[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// 1) log_format honeyfmt を http ブロックへ追加（未適用なら）
// ---------------------------------------------------------------------------
const HONEY_FORMAT = `    # ${MARK}: ハニーポット用のログ（時刻・UA・クライアントIP 入り）
    log_format honeyfmt '$time_iso8601 ip=$remote_addr cf=$http_cf_connecting_ip xff="$http_x_forwarded_for" ua="$http_user_agent" req="$request" status=$status bytes=$body_bytes_sent ref="$http_referer"';
`;

if (conf.includes("log_format honeyfmt")) {
  console.log("SKIP: log_format honeyfmt は適用済み");
} else {
  const anchor = "    log_format withff ";
  const idx = conf.indexOf(anchor);
  if (idx === -1) {
    console.error("ABORT: `log_format withff` が見つかりません（何も書き換えません）");
    process.exit(1);
  }
  const lineEnd = conf.indexOf("\n", idx);
  if (lineEnd === -1) {
    console.error("ABORT: log_format withff の行末が見つかりません");
    process.exit(1)
  }
  conf = conf.slice(0, lineEnd + 1) + HONEY_FORMAT + conf.slice(lineEnd + 1);
  console.log("OK: log_format honeyfmt を追加しました");
}

// ---------------------------------------------------------------------------
// 2) 1717 vhost へハニー location を挿入
// ---------------------------------------------------------------------------
const masked = maskNoise(conf);
const serverRe = /server\s*\{/g;
let mt;
let target = null;
while ((mt = serverRe.exec(masked)) !== null) {
  const openIdx = mt.index + mt[0].length - 1;
  const endIdx = matchBrace(masked, openIdx);
  if (endIdx === -1) continue;
  const body = masked.slice(openIdx, endIdx);
  if (!/listen\s+1717\s*;/.test(body)) continue;
  if (!/server_name\s+[^;]*koinoyamai\.love/.test(body)) continue;
  if (target) {
    console.error("ABORT: 対象 server ブロックが複数あります");
    process.exit(1);
  }
  target = { openIdx, endIdx };
}
if (!target) {
  console.error("ABORT: `listen 1717` + `server_name koinoyamai.love` の server ブロックが見つかりません");
  process.exit(1);
}

if (conf.slice(target.openIdx, target.endIdx).includes(MARK)) {
  console.log(`SKIP: 適用済み（${MARK} マーカーが存在）`);
  process.exit(0);
}

const HONEY_LOCATION = `        # ---- ハニーポット（${MARK}）: 機密ファイル名っぽいパスは
        #      偽物ディレクトリからのみ配信する（実ファイルは絶対に公開しない）----
        #  * 取得されたら honey.log に記録され honeypot-watch.js が通知する
        #  * 中身は偽物。canary URL を含み「使われた」= 窃取確定
        location ~* ^/(?:[\\w.\\-]+/)*(?:\\.env(?:\\.[\\w.\\-]+)?|\\.git/(?:config|HEAD)|\\.aws/credentials|\\.ssh/id_\\w+|id_rsa(?:\\.pub)?|backup\\.(?:zip|tar|gz|7z)|(?:database|db|app|prod|main|site|dump)\\.(?:sqlite3?|sql)|config\\.(?:php|json|ya?ml)|wp-config\\.php|(?:credentials|secret|secrets|passwords?)\\.(?:txt|json|ya?ml|db)|dump\\.sql)$ {
            root ${HONEY_DIR};
            try_files $uri =404;
            access_log /var/log/nginx/honey.log honeyfmt;
            add_header X-Honey-Pot "1" always;
        }

        # ---- 偽物の中身(canary)へのアクセス = 「盗んだ情報を使った」証拠 ----
        location ^~ /_canary/ {
            access_log /var/log/nginx/honey.log honeyfmt;
            add_header X-Honey-Pot "1" always;
            return 204;
        }

        # ---- その他の機密拡張子はDENY（ハニーパターンに該当するものは上で処理）----
        location ~* \\.(?:env|bak|old|orig|save|swp|swo|sql|sqlite3?|db|db3|log|key|pem|p12|pfx|jks|keystore|asc|gpg|pgp|ovpn|tar|tgz|gz|bz2|7z|rar)$ {
            deny all;
        }

`;

// 挿入位置 = vhost 内の **最初の** location の直前。
// nginx は正規表現 location を出現順に評価して最初にマッチしたものを実行するため、
// ここに入れておかないと `location ~ \.php$`（config.php 等）が先にマッチして偽物が配信されない。
const locRe = /[ \t]*location\s+[^\n{]*\{/g;
locRe.lastIndex = target.openIdx;
const lm = locRe.exec(masked);
if (!lm) {
  console.error("ABORT: vhost 内に location が見つかりません（挿入位置が決められない）");
  process.exit(1);
}
const lineStart = conf.lastIndexOf("\n", lm.index) + 1;
const out = conf.slice(0, lineStart) + HONEY_LOCATION + conf.slice(lineStart);

const dest = outPath || confPath;
fs.writeFileSync(dest, out, "utf8");
console.log(`OK: ハニーポットの location を追加しました（${MARK}）`);
console.log(`   挿入位置: vhost 内の最初の location の直前（正規表現 location より前）`);
console.log(`   配信元  : ${HONEY_DIR}`);
if (dest !== confPath) console.log(`   書き出し先: ${dest}（atomic install は呼び出し側）`);
