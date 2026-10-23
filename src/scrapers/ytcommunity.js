// ytcommunity.js
// SSD書き込み最小化 + RAMプロファイル + Page再利用 完全最適化版

const fs = require('fs');
const path = require('path');
const { getSharedBrowser, closeSharedBrowser } = require('../core/browser');

/* ytcommunity 専用の puppeteer-extra/Stealth は不要になったため削除 */

/* =============================
   Config
============================= */

const profileDir = '/var/lib/mai-push/puppeteer-profile';

const ICON_URL = '/icon.webp';

let sharedPage = null;

// 通知設定。init() は複数回呼ばれる（汎用notifyConfig注入→filePath設定）ため、
// 丸ごと代入すると後勝ちで notifyFn が消える。必ずマージで保持する。
let notifyConfig = {};

let stateCache = null;
let stateDirty = false;
let stateFilePath = path.join(__dirname, '..', '..', 'ytcommunity_state.json');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'ytcommunity.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeLog(level, ...args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(arg => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'object') return JSON.stringify(arg);
    return arg;
  }).join(' ');
  const logLine = `[${timestamp}] [${level}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, logLine); } catch (e) {}
}

const ytLogger = {
  log: (...args) => { console.log(...args); writeLog('INFO', ...args); },
  warn: (...args) => { console.warn(...args); writeLog('WARN', ...args); },
  error: (...args) => { console.error(...args); writeLog('ERROR', ...args); }
};


/* =============================
   Browser
============================= */

async function getBrowser() {
  return getSharedBrowser({
    userDataDir: process.platform === 'linux' 
        ? '/dev/shm/puppeteer-profile-shared' 
        : path.join(__dirname, '..', '..', 'tmp', 'puppeteer-shared'),
    ephemeral: true
  });
}


/* =============================
   Page (再利用)
============================= */

async function getPage() {
  const browser = await getBrowser();

  // ブラウザが切断されている場合、sharedPage参照をリセット
  if (!browser.connected) {
    sharedPage = null;
  }

  if (sharedPage && !sharedPage.isClosed()) {
    return sharedPage;
  }

  // 古いページのリスナーをクリーンアップ
  if (sharedPage) {
    try {
      sharedPage.removeAllListeners('request');
      sharedPage.removeAllListeners('response');
    } catch (_) {}
  }

  sharedPage = await browser.newPage();

  // 不要なリソースをブロックしてメモリと通信量を節約
  await sharedPage.setRequestInterception(true);
  sharedPage.on('request', (request) => {
    const resourceType = request.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
      request.abort();
    } else {
      request.continue();
    }
  });

  await sharedPage.setCacheEnabled(false);

  // ステータスコードとタイトルを追跡するためのリスナー
  sharedPage.on('response', response => {
    if (response.url().includes('youtube.com/@') && response.url().includes('/posts')) {
      ytLogger.log(`[YT] Response: ${response.status()} ${response.url()}`);
    }
  });

  await sharedPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
  );

  await sharedPage.setExtraHTTPHeaders({
    'Accept-Language': 'ja-JP,ja;q=0.9'
  });

  return sharedPage;
}


/* =============================
   Utils
============================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function safeWriteJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}


/* =============================
   State
============================= */

function loadState() {
  if (stateCache) return stateCache;

  if (!fs.existsSync(stateFilePath)) {
    stateCache = { initialized: false, known: {} };
    return stateCache;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(stateFilePath));
    if (Array.isArray(raw)) {
      // 古い配列形式のキャッシュ(別スクリプト等の名残)をオブジェクト形式にマイグレーション
      const known = {};
      raw.forEach(p => {
        if (p && p.postId) {
          known[p.postId] = new Date().toISOString();
        }
      });
      stateCache = { initialized: false, known };
    } else {
      stateCache = raw || { initialized: false, known: {} };
    }
  } catch (e) {
    stateCache = { initialized: false, known: {} };
  }
  
  return stateCache;
}

function markStateDirty() {
  stateDirty = true;
}

function flushState() {
  if (!stateDirty || !stateCache) return;
  safeWriteJson(stateFilePath, stateCache);
  stateDirty = false;
}

setInterval(() => {
  if (stateDirty) flushState();
}, 60000);


/* =============================
   DOM Extract
============================= */

async function extractPostsFromDom(page) {
  return page.evaluate(() => {
    const out = [];

    document.querySelectorAll('ytd-backstage-post-renderer').forEach(n => {
      const link = n.querySelector('a[href^="/post/"]');
      if (!link) return;

      const id = link.href.split('/post/')[1];

      const content =
        n.querySelector('#content-text')?.innerText?.trim() || '';

      out.push({
        postId: id,
        postUrl: `https://www.youtube.com/post/${id}`,
        content
      });
    });

    return out;
  });
}


/* =============================
   Fetch
============================= */

async function fetchPosts(handle) {
  const page = await getPage();

  const url = `https://www.youtube.com/@${handle.replace('@','')}/posts`;
  ytLogger.log(`[YT] Accessing: ${url}`);

  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // 「すべて同意」ボタンなど、YouTubeの同意/クッキーポップアップ対策
    try {
      const consentButtonSelector = 'button[aria-label="すべて同意"], button[aria-label="Accept all"]';
      const hasConsent = await page.$(consentButtonSelector);
      if (hasConsent) {
        ytLogger.log('[YT] Consent dialog detected. Clicking "Accept all"...');
        await hasConsent.click();
        await sleep(2000);
      }
    } catch (e) {
      // ポップアップがない、またはエラーなら無視
    }

    await sleep(2500);

    // 読み込み確認
    const title = await page.title();
    ytLogger.log(`[YT] Loaded page title: ${title}`);
    
    if (title.includes('ログイン') || title.includes('Sign in')) {
      ytLogger.warn('[YT] Blocked by login screen.');
      return [];
    }

    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1500);
    }

    const results = await extractPostsFromDom(page);
    ytLogger.log(`[YT] Extracted ${results.length} posts from ${handle}`);
    return results;
  } catch (err) {
    ytLogger.error(`[YT] fetchPosts error for ${handle}:`, err);
    return [];
  }
}


/* =============================
   Poll
============================= */

async function pollAndNotify(handle) {
  const state = loadState();

  const posts = await fetchPosts(handle);

  const known = state.known || {};
  const now = new Date().toISOString();

  const newPosts = posts.filter(p => !known[p.postId]);

  if (!state.initialized) {
    posts.forEach(p => known[p.postId] = now);
    state.initialized = true;
    state.known = known;
    markStateDirty();
    flushState();
    return;
  }

  if (newPosts.length > 0) {
    for (const p of newPosts) {
      if (notifyConfig?.notifyFn) {
        await notifyConfig.notifyFn({
          type: 'ytcommunity',
          // settingKey が無いと notify 側の設定チェック自体がスキップされ、
          // 「YouTubeコミュニティ OFF」が効かなくなる。設定の正規キーを渡すこと。
          settingKey: 'youtubeCommunity',
          data: {
            title: '【コミュニティ投稿】',
            body: p.content.slice(0, 200),
            url: p.postUrl,
            icon: ICON_URL
          }
        });
      }

      known[p.postId] = now;
    }

    state.known = known;
    markStateDirty();
    flushState();
  }

  console.log(`[YT] fetched=${posts.length} new=${newPosts.length}`);
  ytLogger.log(`[YT] polled handle=${handle} fetched=${posts.length} new=${newPosts.length}`);
}


/* =============================
   Init
============================= */

function init(cfg = {}) {
  // マージで保持（2回目以降の init で notifyFn を失わないように）
  notifyConfig = { ...notifyConfig, ...cfg };

  if (cfg.filePath) {
    stateFilePath = cfg.filePath;
    ytLogger.log(`[YT] State file path updated to: ${stateFilePath}`);
  }

  const stateDir = path.dirname(stateFilePath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  if (!fs.existsSync(profileDir)) {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
    } catch (e) {
      ytLogger.warn(`[YT] Failed to create profileDir ${profileDir}:`, e.message);
    }
  }
}

process.on('SIGINT', async () => {
  flushState();
  await closeSharedBrowser({ userDataDir: profileDir }).catch(() => {});
  process.exit(0);
});

process.on('SIGTERM', async () => {
  flushState();
  await closeSharedBrowser({ userDataDir: profileDir }).catch(() => {});
  process.exit(0);
});

module.exports = {
  init,
  pollAndNotify,
  flushState
};
