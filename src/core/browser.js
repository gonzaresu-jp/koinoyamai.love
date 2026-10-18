// browser.js - プール管理版
// userDataDir をキーにして、同じプロファイルは同じブラウザを共有する。
// ゾンビプロセス防止のため、定期的に切断済みブラウザをクリーンアップする。

const puppeteer = require('puppeteer');

// ── プール: Map<cacheKey, { browser, initPromise, idleTimer }> ─────────────
const _pool = new Map();

// アイドル自動クローズ: 最後の利用から IDLE_MS 経過し、かつ開いているページが
// 無ければブラウザを閉じてメモリを解放する（次回 getSharedBrowser で自動再起動）。
// 0 を指定すると無効。環境変数 BROWSER_IDLE_MS で調整可能（既定 3分）。
const IDLE_MS = parseInt(process.env.BROWSER_IDLE_MS || '180000', 10);

/**
 * 指定キーのアイドルタイマーを張り直す（利用のたびに呼ぶ）。
 * タイマー発火時、ページが残っていれば閉じずに再スケジュールする。
 */
function scheduleIdleClose(key) {
  if (!IDLE_MS) return;
  const entry = _pool.get(key);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);

  entry.idleTimer = setTimeout(async () => {
    const e = _pool.get(key);
    if (!e || !e.browser || !e.browser.isConnected()) {
      // ブラウザが既に切れているならプールから削除だけする
      if (e) {
        if (e.idleTimer) clearTimeout(e.idleTimer);
        _pool.delete(key);
      }
      return;
    }
    try {
      // Puppeteer は起動時に空白ページを1枚持つため、>1 を「利用中」とみなす
      const pages = await e.browser.pages();
      const openPages = pages.filter(p => !(p.isClosed && p.isClosed())).length;
      if (openPages > 1) {
        // まだページが開いている → 閉じずに再スケジュール
        scheduleIdleClose(key);
        return;
      }
      console.log(`[browser.js] idle ${IDLE_MS}ms, closing browser to free memory: ${key}`);
      // close() を await してプロセスが確実に終了してからプールを削除する
      await e.browser.close().catch(() => {});
      // disconnected イベントで既に削除されている可能性があるので念のため
      if (_pool.has(key)) {
        const current = _pool.get(key);
        if (current && current.idleTimer) clearTimeout(current.idleTimer);
        _pool.delete(key);
      }
    } catch (err) {
      console.warn('[browser.js] idle close failed:', err && err.message ? err.message : err);
      // エラー時もプールから削除（ゾンビ防止）
      if (_pool.has(key)) {
        const current = _pool.get(key);
        if (current && current.idleTimer) clearTimeout(current.idleTimer);
        _pool.delete(key);
      }
    }
  }, IDLE_MS);

  if (entry.idleTimer && typeof entry.idleTimer.unref === 'function') {
    entry.idleTimer.unref();
  }
}

const DEFAULT_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--disk-cache-size=0',
  '--media-cache-size=0',
  '--disable-application-cache',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--disable-extensions',
  '--disable-popup-blocking',
  '--mute-audio',
  '--blink-settings=imagesEnabled=false',
  '--disable-remote-fonts',
  '--disable-site-isolation-trials', // プロセス分離を無効化
  '--disable-features=IsolateOrigins,site-per-process' // 同上
];

/**
 * オプションからキャッシュキーを生成する。
 * product と userDataDir の組み合わせが同じなら同じブラウザを返す。
 */
function makeCacheKey(options) {
  const product     = options.product     || 'chrome';
  const userDataDir = options.userDataDir || '__default__';
  return `${product}::${userDataDir}`;
}

/**
 * 指定オプションに対応するブラウザを取得する（なければ起動）。
 * 同じ cacheKey のブラウザは1プロセスだけに保たれる。
 */
async function getSharedBrowser(options = {}) {
  const key   = makeCacheKey(options);
  const entry = _pool.get(key);

  // 接続済みのブラウザがあればそのまま返す
  if (entry && entry.browser && entry.browser.isConnected()) {
    scheduleIdleClose(key); // 利用したのでアイドルタイマーを延長
    return entry.browser;
  }

  // 起動中（initPromise がある）なら待つ
  if (entry && entry.initPromise) {
    return await entry.initPromise;
  }

  // 新規起動
  const initPromise = (async () => {
    const {
      executablePath,
      product,
      headless = true,
      userDataDir,
      extraArgs = [],
      extraPrefs = {}, // 🔧 Firefox 向けの設定を追加
      defaultViewport = null,
    } = options;

    const launchOptions = {
      headless,
      defaultViewport,
      args: [...DEFAULT_ARGS, ...extraArgs]
    };

    if (executablePath) launchOptions.executablePath = executablePath;
    if (product)        launchOptions.product        = product;
    if (userDataDir) {
      launchOptions.userDataDir = userDataDir;
      // 💡 `ephemeral` が true の場合、起動前にプロファイルを完全消去してゴミをクリアする
      if (options.ephemeral) {
        try {
          const fs = require('fs');
          if (fs.existsSync(userDataDir)) {
            fs.rmSync(userDataDir, { recursive: true, force: true });
            console.log(`[browser.js] Wiped ephemeral profile: ${userDataDir}`);
          }
        } catch(e) {
          console.warn(`[browser.js] Failed to wipe ephemeral profile:`, e.message);
        }
      }
    }

    // 🔧 Firefox 用の追加設定（セッション維持と検知回避）
    if (product === 'firefox') {
      launchOptions.firefoxUserPrefs = {
        'dom.webdriver.enabled': false,
        'usePrivacyResistFingerprinting': false,
        'privacy.resistFingerprinting': false,
        'network.cookie.cookieBehavior': 0, // すべてのクッキーを許可
        'browser.sessionstore.resume_from_crash': true,
        ...extraPrefs
      };
    }

    let browser;
    try {
      browser = await puppeteer.launch(launchOptions);
    } catch (e) {
      _pool.delete(key);
      throw e;
    }

    browser.on('disconnected', () => {
      const current = _pool.get(key);
      // まだ同じインスタンスがプールにあれば削除
      if (current && current.browser === browser) {
        if (current.idleTimer) clearTimeout(current.idleTimer);
        _pool.delete(key);
        console.warn(`[browser.js] Browser disconnected, removed from pool: ${key}`);
      }
    });

    _pool.set(key, { browser, initPromise: null });
    scheduleIdleClose(key); // 起動直後からアイドル監視を開始
    return browser;
  })();

  _pool.set(key, { browser: null, initPromise });

  const browser = await initPromise;
  return browser;
}

/**
 * 指定オプションに対応するブラウザを閉じる。
 * 引数なしの場合はデフォルトキー（後方互換）。
 */
async function closeSharedBrowser(options = {}) {
  const key   = makeCacheKey(options);
  const entry = _pool.get(key);

  if (entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.browser) {
      try {
        await entry.browser.close();
      } catch (e) {
        // ignore
      }
    }
  }
  // disconnected イベントで既に削除されている可能性があるので has チェック
  if (_pool.has(key)) {
    const current = _pool.get(key);
    if (current && current.idleTimer) clearTimeout(current.idleTimer);
    _pool.delete(key);
  }
}

/**
 * プール内の全ブラウザを閉じる（プロセス終了時用）。
 */
async function closeAllBrowsers() {
  const keys = [..._pool.keys()];
  await Promise.allSettled(
    keys.map(key => {
      const entry = _pool.get(key);
      _pool.delete(key);
      if (entry) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (entry.browser) {
          return entry.browser.close().catch(() => {});
        }
      }
    })
  );
  console.log(`[browser.js] closeAllBrowsers: closed ${keys.length} browser(s)`);
}

/**
 * 切断済みブラウザをプールから掃除する（ゾンビ防止）。
 */
function cleanupDisconnected() {
  let removed = 0;
  for (const [key, entry] of _pool.entries()) {
    if (entry.browser && !entry.browser.isConnected()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      _pool.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[browser.js] cleanup: removed ${removed} disconnected browser(s). pool size: ${_pool.size}`);
  }
}

// 30秒ごとにゾンビチェック
setInterval(cleanupDisconnected, 30_000).unref();

/**
 * 現在のプール状態を返す（デバッグ・監視用）。
 */
function getPoolStatus() {
  const entries = [];
  for (const [key, entry] of _pool.entries()) {
    entries.push({
      key,
      connected: entry.browser ? entry.browser.isConnected() : false,
      pending:   !entry.browser && !!entry.initPromise
    });
  }
  return { size: _pool.size, entries };
}

module.exports = {
  getSharedBrowser,
  closeSharedBrowser,
  closeAllBrowsers,
  getPoolStatus,
};
