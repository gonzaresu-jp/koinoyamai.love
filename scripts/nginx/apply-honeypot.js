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
 *   - 冪等（同じ入力なら差分ゼロ。適用済みの場合は**グループを差し替える**）
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
    # ※ 判定に使う固定フィールド（ip/cf/xff/st/uri/bytes）は **UA より前**に並べる。
    #   UA は攻撃者が自由に入れられるので、後ろに置いて解析を騙されないようにする。
    log_format honeyfmt '$time_iso8601 ip=$remote_addr cf=$http_cf_connecting_ip xff="$http_x_forwarded_for" st=$status uri=$uri bytes=$body_bytes_sent req="$request" ref="$http_referer" ua="$http_user_agent"';
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

// 適用済み（マーカーあり）なら、既存のハニーブロックを**新しい内容に差し替える**。
// （中身の bug 修正などを反映できるようにする）
const alreadyApplied = conf.slice(target.openIdx, target.endIdx).includes(MARK);

const HONEY_LOCATION = `        # ---- ハニーポット（${MARK}）: 機密ファイル名っぽいパスは
        #      偽物ディレクトリからのみ配信する（実ファイルは絶対に公開しない）----
        #  * 取得されたら honey.log に記録され honeypot-watch.js が通知する
        #  * 中身は偽物。canary URL を含み「使われた」= 窃取確定
        location ~* ^/(?:[\\w.\\-]+/)*(?:\\.env(?:\\.[\\w.\\-]+)?|\\.git/(?:config|HEAD)|\\.aws/credentials|\\.ssh/id_\\w+|id_rsa(?:\\.pub)?|backup\\.(?:zip|tar|gz|7z)|(?:database|db|app|prod|main|site|dump)\\.(?:sqlite3?|sql)|config\\.(?:php|json|ya?ml)|wp-config\\.php|(?:credentials|secret|secrets|passwords?)\\.(?:txt|json|ya?ml|db)|dump\\.sql)$ {
            root ${HONEY_DIR};
            try_files $uri =404;
            access_log /var/log/nginx/honey.log honeyfmt;
            # vhost レベルの error_page 404 /404.html だと 404 が内部リダイレクトで
            # honey.log の外（access.log）へ逃げる → 偵察が見えない。
            # ここでのみ 404 を named location へ逃がす。
            error_page 404 = @honey_not_found;
        }

        # ---- ハニーパスに実ファイルが無い（= 偵察）の記録 ----
        location @honey_not_found {
            access_log /var/log/nginx/honey.log honeyfmt;
            return 404;
        }

        # ---- 偽物の中身(canary)へのアクセス = 「盗んだ情報を使った」証拠 ----
        location ^~ /_canary/ {
            access_log /var/log/nginx/honey.log honeyfmt;
            return 204;
        }

        # ---- その他の機密拡張子はDENY（ハニーパターンに該当するものは上で処理）----
        location ~* \\.(?:env|bak|old|orig|save|swp|swo|sql|sqlite3?|db|db3|log|key|pem|p12|pfx|jks|keystore|asc|gpg|pgp|ovpn|tar|tgz|gz|bz2|7z|rar)$ {
            access_log /var/log/nginx/honey.log honeyfmt;
            deny all;
        }

`;

// --- 適用済みの場合: 既存ブロック（マーカーコメント〜location 終端）を置換 ---
if (alreadyApplied) {
  const m2 = maskNoise(conf);
  const markIdx = conf.indexOf(MARK, target.openIdx);
  if (markIdx === -1 || markIdx > target.endIdx) {
    console.error("ABORT: マーカー位置が不正です");
    process.exit(1);
  }
  const blockStart = conf.lastIndexOf("\n", markIdx) + 1;
  // ハニーの location グループ（honey / named / canary / deny）を全部まとめて置換する。
  // 1 つだけ置換すると(canary や deny が)二重に残るため、**グループ全体**の範囲を取る。
  const groupRe = /[ \t]*location\s+[^\n{]*\{/g;
  groupRe.lastIndex = markIdx;
  let blockEnd = -1;
  let g;
  while ((g = groupRe.exec(m2)) !== null) {
    if (g.index >= target.endIdx) break;
    const open3 = g.index + g[0].length - 1;
    const close3 = matchBrace(m2, open3);
    if (close3 === -1) { console.error("ABORT: location ブロックの終端が見つかりません"); process.exit(1); }
    const body3 = conf.slice(g.index, close3 + 1);
    // honey.log を参照する location（＝ハニーグループ）はグループに含める
    if (!body3.includes("honey.log")) break;
    blockEnd = conf.indexOf("\n", close3) + 1;
  }
  // HONEY_LOCATION は末尾に空行を持つ。既存の空行を取り込まないと
  // 差し替えのたびに空行が 1 つ増えて**冪等性が壊れる**（差分がゼロにならない）。
  while (conf[blockEnd] === "\n") blockEnd++;
  if (blockEnd === -1) {
    console.error("ABORT: 既存のハニーブロックが見つかりません");
    process.exit(1);
  }
  const outUpdate = conf.slice(0, blockStart) + HONEY_LOCATION + conf.slice(blockEnd);
  // 検証: honey.log を参照する location が想定個数であること
  // （honey / @honey_not_found / _canary / deny の 4 個）。
  // 欠けている・重複しているなら**適用しない**（duplicate location で nginx -t が壊れる）。
  const honeyRefs = (outUpdate.match(/access_log\s+\/var\/log\/nginx\/honey\.log/g) || []).length;
  if (honeyRefs !== 4) {
    console.error(`ABORT: honey.log を参照する location が ${honeyRefs} 個あります（想定 4）。書き換えません`);
    process.exit(1);
  }
  const canaryRefs = (outUpdate.match(/location \^~ \/_canary\//g) || []).length;
  if (canaryRefs !== 1) {
    console.error(`ABORT: location ^~ /_canary/ が ${canaryRefs} 個あります（想定 1）。書き換えません`);
    process.exit(1);
  }
  const dest2 = outPath || confPath;
  fs.writeFileSync(dest2, outUpdate, "utf8");
  console.log(`OK: 既存のハニーブロックを更新しました（${MARK}）`);
  if (dest2 !== confPath) console.log(`   書き出し先: ${dest2}（atomic install は呼び出し側）`);
  process.exit(0);
}

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
