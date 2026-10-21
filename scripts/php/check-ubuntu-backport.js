#!/usr/bin/env node
/**
 * check-ubuntu-backport.js — Canonical の PHP バックポートが利用可能になったか検知する
 *
 * なぜ必要か（2026-10-21 夜の実運用から）:
 *   PHP コアの緊急 RCE（CVE-2026-109618 / 109619）で、upstream の修正版（8.3.36）が
 *   Canonical のバックポートより先にが出たため、**sury PPA で upstream 版を入れる**判断をした。
 *   この状態で待つ間、**security-watch の PHP チェックは「適用済み」と判定してしまう**
 *   （インストール済み changelog に CVE ID があるためmissing に出ない）。
 *   つまり「Ubuntu 版へ戻す」合図が自動で来ない。
 *   → Ubuntu の CVE トラッカーが示す修正版と、noble-security の実在版を突き合わせ、
 *     戻せるになったら通知する。
 *
 * 判定:
 *   1. Ubuntu CVE トラッカーから 2 CVE の「修正版」（例: 8.3.6-0ubuntu0.24.04.13）を取得
 *   2. apt が持つ noble-security の php8.3-fpm 版と一致するか
 *      → 一致なら「Ubuntu 版へ戻せる」
 *   3. sury PPA が未導入なら判定不要（skip）
 *
 * 通知: Discord（security/notify.js の sendDiscord を再利用）＋ logs/php-backport-check.log
 * 終了コード: 0 = 平常/検知済み（通知は行う）/ 1 = 監視自体が失敗（fail-closed）
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CVE_LIST = ['CVE-2026-109618', 'CVE-2026-109619'];
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'php-backport-check.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* ログは best-effort */ }
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mai-push-php-backport-check/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

/** Ubuntu の CVE トラッカーから「修正版」（例 8.3.6-0ubuntu0.24.04.13）を取り出す */
async function fixedVersionFromTracker(cve) {
  const res = await fetch(`https://ubuntu.com/security/${cve}`);
  if (res.status !== 200) throw new Error(`${cve}: HTTP ${res.status}`);
  const text = res.body.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = text.match(/8\.3\.6-0ubuntu0\.24\.04\.\d+/g);
  if (!m || m.length === 0) return null;
  return m.sort()[m.length - 1];
}

/** apt が持つ noble-security の php8.3-fpm 版 */
function nobleSecurityVersion() {
  const out = run('apt-cache', ['madison', 'php8.3-fpm']);
  for (const line of out.split('\n')) {
    if (!/noble-security/.test(line)) continue;
    const m = line.match(/\|\s*([^\s|]+)\s*\|/);
    if (m) return m[1];
  }
  return null;
}

/**
 * iumsury 版（= upstream ビルド）_FLAG が入っているか。
 * ※ sources.list は既に外されている場合でも **インストール済み版は sury 版**なので、
 *   判定は「インストール済み版の文字列」で行う。
 */
function usingUpstreamBuild() {
  const v = run('dpkg-query', ['-W', '-f=${Version}', 'php8.3-fpm']);
  if (!v) return false;
  // Ubuntu 公式ビルドは "8.3.6-0ubuntu0.24.04.NN"、upstream ビルドは "8.3.36-1+0~...gbp..." 等
  return /\+0~|\.gbp|\+1[0-9]?~|~[0-9]+\./.test(v);
}

(async () => {
  log('--- PHP バックポート監視 開始 ---');
  if (!usingUpstreamBuild()) {
    log('Ubuntu 標準版で運用中（upstream 版は不要）→ 判定不要、スキップ');
    return;
  }
  let fixed = [];
  for (const cve of CVE_LIST) {
    try {
      const v = await fixedVersionFromTracker(cve);
      if (v) fixed.push(v);
    } catch (e) {
      log(`[ERR] ${cve} の取得に失敗: ${e.message}`);
    }
  }
  if (fixed.length === 0) {
    log('[ERR] 修正版を特定できませんでした（監視失敗）');
    process.exit(1);
  }
  const want = fixed.sort()[fixed.length - 1];
  const have = nobleSecurityVersion();
  log(`トラッカーの修正版: ${want} / noble-security の実在版: ${have || '不明'}`);
  if (!have) {
    log('[ERR] noble-security の版を特定できませんでした（監視失敗）');
    process.exit(1);
  }
  if (have !== want) {
    log(`まだ: Ubuntu 版（${have}）には修正が含まれていない → sury のまま待つ`);
    return;
  }
  const msg = `PHP: Canonical のバックポート（${want}）が利用可能になりました。sury PPA を外して Ubuntu 版へ戻せます。`;
  log(`[OK] ${msg}`);
  // Discord 通知（失敗しても監視自体は失敗扱いにしない）
  try {
    const notify = require(path.join(__dirname, '..', 'security', 'notify.js'));
    const hook = process.env.DISCORD_WEBHOOK_URL || '';
    if (hook && notify.sendDiscord) {
      await notify.sendDiscord(hook, { title: 'PHP バックポート検知', description: msg, color: 5793266 });
      log('Discord に通知しました');
    } else {
      log('（Discord webhook 未設定のため通知はスキップ）');
    }
  } catch (e) {
    log(`[WARN] Discord 通知に失敗: ${e.message}`);
  }
})().catch((e) => {
  log(`[ERR] 監視スクリプトが例外: ${e.stack || e.message}`);
  process.exit(1);
});
