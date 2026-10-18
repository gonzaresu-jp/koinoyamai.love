// gipt.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getSharedBrowser, closeSharedBrowser } = require('../core/browser');

// ====== 固定設定 ======
const TARGET_URL = 'https://gi-pt.com/main/wishlist/fan-view/3a0fdc24-209e-d962-896b-cdd7d7828943';
const PLATFORM_ID = 'gipt';
const ICON_URL = '/icon.webp';

// 保存先（必要なら init() で上書き）
let stateFilePath = path.join(__dirname, 'gipt_state.json');
let debugDirDefault = path.join(__dirname, 'gipt_debug');

// 通知（initで注入）
let notifyConfig = null;

// 二重実行抑止
const inFlight = new Set();

// ====== util ======
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
async function pageSleep(page, ms) {
  if (page && typeof page.waitForTimeout === 'function') return page.waitForTimeout(ms);
  return sleep(ms);
}
function safeWriteJson(filePath, obj) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
  fs.renameSync(tmpPath, filePath);
}
function safeText(v) {
  return (v ?? '').toString().replace(/\s+/g, ' ').trim();
}
function mkdirp(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function nowIso() {
  return new Date().toISOString();
}

// 価格表記の揺れ対策（¥, ￥, カンマ, 空白など）
function normalizePrice(s) {
  const t = safeText(s);
  const n = t.replace(/[^\d]/g, '');
  return n || t;
}
// webホストの揺れ対策（http(s)やパスを落とす）
function normalizeWebHost(s) {
  const t = safeText(s).toLowerCase();
  return t.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}


// (プロセス終了時のクリーンアップ処理は main.js で一元管理するように変更しました)

// ====== init ======
function init(config) {
  notifyConfig = config || {};
  if (config && config.statePath) stateFilePath = path.resolve(config.statePath);
  if (config && config.debugDir) debugDirDefault = path.resolve(config.debugDir);

  mkdirp(path.dirname(stateFilePath));
  mkdirp(debugDirDefault);
}

// ====== state ======
function loadState() {
  try {
    if (!fs.existsSync(stateFilePath)) {
      return { initialized: false, knownKeys: {}, updatedAt: null };
    }
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const data = JSON.parse(raw);
    return {
      initialized: !!data.initialized,
      knownKeys: (data && typeof data.knownKeys === 'object' && data.knownKeys) ? data.knownKeys : {},
      updatedAt: data.updatedAt || null
    };
  } catch (e) {
    console.warn('[Gipt] loadState failed, resetting:', e.message);
    return { initialized: false, knownKeys: {}, updatedAt: null };
  }
}

function saveState(state) {
  const out = {
    initialized: !!state.initialized,
    knownKeys: state.knownKeys || {},
    updatedAt: nowIso(),
  };
  safeWriteJson(stateFilePath, out);
  return out;
}

// ====== dedupeKey ======
// 安定重視: img は署名付きや遅延ロードで揺れる可能性があるので、キー材料から外す。
// （必要なら後で img を追加しても良い）
function makeDedupeKey(item) {
  const title = safeText(item.title);
  const price = normalizePrice(item.price);
  const web = normalizeWebHost(item.web);

  const raw = [title, price, web].join('|');
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  return `${PLATFORM_ID}:${hash}`;
}

// ====== fetch (取得のみ) ======
async function fetchGipts(opts = {}) {
  const {
    debugDir = debugDirDefault,
    saveRawHtml = false, // 本番は false
    screenshot = false,  // 本番は false
    waitMs = 1200,
  } = opts;

  let page;
  let requestHandler;
  const now = Date.now();
  const outDir = path.resolve(debugDir);
  mkdirp(outDir);

  const report = {
    fetchedAt: new Date(now).toISOString(),
    url: TARGET_URL,
    finalUrl: null,
    httpStatus: null,
    pageTitle: null,
    count: 0,
    debug: { htmlPath: null, screenshotPath: null, notes: [] }
  };

  try {
    const browser = await getSharedBrowser({
      userDataDir: process.platform === 'linux'
        ? '/dev/shm/puppeteer-profile-shared'
        : path.join(__dirname, 'tmp', 'puppeteer-shared'),
      ephemeral: true
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });

    // 再現性
    try {
      await page.setUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      );
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6' });
    } catch {}

    // 軽量化：不要リソースブロック（JSは必要なのでブロックしない）
    await page.setRequestInterception(true);
    requestHandler = (req) => {
      const type = req.resourceType();
      // font/media は確実に不要。image は「DOMにsrcがある」前提なら不要なのでブロック。
      // img が空になるなら image ブロックを外す。
      if (type === 'font' || type === 'media' || type === 'image') return req.abort();
      return req.continue();
    };
    page.on('request', requestHandler);

    console.log(`[Gipt] Fetching: ${TARGET_URL}`);

    let res = null;
    try {
      res = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await pageSleep(page, waitMs);
    } catch (e) {
      report.debug.notes.push(`goto failed: ${e.message}`);
      return { gipts: [], report };
    }

    report.finalUrl = page.url();
    report.httpStatus = res ? res.status() : null;
    try { report.pageTitle = await page.title(); } catch {}

    // SPA想定：要素待ち
    try {
      await page.waitForSelector('.col.item', { timeout: 20000 });
    } catch (e) {
      report.debug.notes.push(`selector wait failed: ${e.message}`);

      if (saveRawHtml) {
        const html = await page.content().catch(() => '');
        const htmlPath = path.join(outDir, `gipt_${now}.html`);
        fs.writeFileSync(htmlPath, html, 'utf8');
        report.debug.htmlPath = htmlPath;
      }
      if (screenshot) {
        const pngPath = path.join(outDir, `gipt_${now}.png`);
        try {
          await page.screenshot({ path: pngPath, fullPage: true });
          report.debug.screenshotPath = pngPath;
        } catch (e2) {
          report.debug.notes.push(`screenshot failed: ${e2.message}`);
        }
      }

      return { gipts: [], report };
    }

    // 軽くスクロール（遅延描画対策）
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await pageSleep(page, 500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await pageSleep(page, 250);

    // 抜き出し
    const giptsRaw = await page.$$eval('.col.item', (nodes) => {
      const pick = (root, sel) => root.querySelector(sel);

      return nodes.map((root) => {
        const imgEl = pick(root, 'img.intro');
        const titleEl = pick(root, 'span[id="title"]'); // id重複でも局所探索で拾う
        const priceEl = pick(root, 'p[id="price"]');
        const webEl = pick(root, 'p[id="web"]');

        return {
          title: titleEl ? titleEl.textContent : '',
          price: priceEl ? priceEl.textContent : '',
          web: webEl ? webEl.textContent : '',
          img: imgEl ? imgEl.getAttribute('src') : '',
        };
      });
    });

    const normalized = (Array.isArray(giptsRaw) ? giptsRaw : [])
      .map((x) => ({
        title: safeText(x.title),
        price: safeText(x.price),
        web: safeText(x.web),
        img: safeText(x.img),
      }))
      // 空要素をより厳密に除外
      .filter((x) => {
        const t = safeText(x.title);
        const p = safeText(x.price);
        const w = safeText(x.web);
        // 最低限 title が取れていることを要求（imgはキーに使わないので必須にしない）
        return t.length >= 3 && (p.length > 0 || w.length > 0);
      });

    // dedupeKey でユニーク化（同じキーの重複を潰す）
    const uniqMap = new Map();
    for (const it of normalized) {
      const k = makeDedupeKey(it);
      if (!uniqMap.has(k)) uniqMap.set(k, it);
    }
    const uniqueItems = Array.from(uniqMap.values());

    report.count = uniqueItems.length;

    // デバッグ保存（任意）
    if (saveRawHtml) {
      const html = await page.content();
      const htmlPath = path.join(outDir, `gipt_${now}.html`);
      fs.writeFileSync(htmlPath, html, 'utf8');
      report.debug.htmlPath = htmlPath;
    }
    if (screenshot) {
      const pngPath = path.join(outDir, `gipt_${now}.png`);
      try {
        await page.screenshot({ path: pngPath, fullPage: true });
        report.debug.screenshotPath = pngPath;
      } catch (e) {
        report.debug.notes.push(`screenshot failed: ${e.message}`);
      }
    }

    return { gipts: uniqueItems, report };

  } finally {
    if (page) {
      try {
        if (typeof requestHandler === 'function') {
          page.off('request', requestHandler);
        }
        await page.close();
      } catch (e) {
        console.warn('[Gipt] Failed to close page:', e.message);
      }
    }
  }
}

// ====== 本番: 差分検出 + 初回抑止 + 通知 ======
async function pollAndNotify(opts = {}) {
  const key = 'giptwatch'; // URL固定なので固定キーでOK
  if (inFlight.has(key)) {
    console.log('[Gipt] pollAndNotify: already running, skip');
    return { ok: true, skipped: true, reason: 'inFlight' };
  }
  inFlight.add(key);

  try {
    const state = loadState();
    const { gipts, report } = await fetchGipts(opts);

    if (!gipts || gipts.length === 0) {
      const rp = path.join(debugDirDefault, `gipt_${Date.now()}.report.json`);
      safeWriteJson(rp, report);
      return { ok: false, error: 'no_items', reportPath: rp, report };
    }

    const known = state.knownKeys || {};
    const nowISO = nowIso();

    const newItems = [];
    for (const it of gipts) {
      const dedupeKey = makeDedupeKey(it);
      if (!known[dedupeKey]) newItems.push({ ...it, dedupeKey });
    }

    // 初回は通知しない：既知登録のみ
    if (!state.initialized) {
      for (const it of gipts) {
        const k = makeDedupeKey(it);
        if (!known[k]) known[k] = nowISO;
      }
      state.knownKeys = known;
      state.initialized = true;
      saveState(state);

      console.log(`[Gipt] First run: registered ${Object.keys(known).length} items, NO notify`);
      return { ok: true, firstRun: true, fetched: gipts.length, newCount: newItems.length, notified: 0, report };
    }

    const notifyFn = (notifyConfig && typeof notifyConfig.notifyFn === 'function') ? notifyConfig.notifyFn : null;

    let notified = 0;
    for (const it of newItems) {
      if (!notifyFn) break;

      try {
        const title = '【プレゼント追加】';
        const body =
          (it.title || '').slice(0, 200) +
          (it.price ? ` / ${it.price}` : '');

        await notifyFn({
          type: PLATFORM_ID,
          settingKey: PLATFORM_ID,
          data: {
            title,
            body,
            url: TARGET_URL, // 個別URLが取れるなら差し替え
            icon: ICON_URL
          }
        });

        notified++;
        known[it.dedupeKey] = nowISO; // 成功分だけ反映（失敗したら次回再通知）
      } catch (e) {
        console.warn('[Gipt] notify failed:', e.message);
        continue;
      }
    }

    state.knownKeys = known;
    saveState(state);

    console.log(`[Gipt] fetched=${gipts.length} new=${newItems.length} notified=${notified}`);
    return { ok: true, firstRun: false, fetched: gipts.length, newCount: newItems.length, notified, report };

  } finally {
    inFlight.delete(key);
  }
}

// 互換: 取得だけ（通知しない）
async function fetchOnly(opts = {}) {
  return await fetchGipts(opts);
}

module.exports = {
  init,
  fetchOnly,
  pollAndNotify,
  closeSharedBrowser,
};

// ====== 単体テスト実行 ======
if (require.main === module) {
  (async () => {
    init({
      statePath: path.join(__dirname, 'gipt_state.json'),
      debugDir: path.join(__dirname, 'gipt_debug'),
      notifyFn: async (payload) => {
  const title = payload?.data?.title ?? '';
  const body  = payload?.data?.body  ?? '';
  const url   = payload?.data?.url   ?? '';

  console.log('==============================');
  console.log('[Gipt][TEST notify]');
  console.log('title:', title);
  console.log('body :', body);
  console.log('url  :', url);
  console.log('==============================\n');
}

    });

    const r = await pollAndNotify({
      saveRawHtml: false,
      screenshot: false,
      waitMs: 1200
    });

    console.log('[Gipt] result:', r);
    await closeSharedBrowser();
  })().catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
  });
}
