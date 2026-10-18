// twitter.js（通知送信付き・設定キー対応版） - ブラウザ再利用・ディスク書き込み最適化版
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { getSharedBrowser, closeSharedBrowser } = require('../core/browser');
const fetch = require('node-fetch');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const fs = require('fs');
const { analyzeTweet, extractScheduleFromAnalysis, extractUrlsFromTweet } = require('./gemma-analyzer');
const { checkScheduleDrift } = require('../core/schedule-drift-monitor');
const twitterMediaSaver = require('./twitter-media-saver');
const { signNotifyPayload } = require('../core/notify-sign');

const PROFILE_PATH = '/var/lib/mai-push/puppeteer-profile';
const COOKIE_DB = path.join(PROFILE_PATH, 'cookies.sqlite');
const TMP_DB = path.join(os.tmpdir(), 'cookies_temp_twitter.sqlite');
const SEEN_PATH = path.join(__dirname, '..', '..', 'seen.json');
const HEADLESS = true;
const MAX_AGE_HOURS = 24;
const CHECK_INTERVAL_MS = 120 * 1000;
const NOTIFY_ENDPOINT = 'http://localhost:8080/api/notify';
const ICON_URL = '/icon.webp';
const NOTIFY_TOKEN = process.env.NOTIFY_API_TOKEN || process.env.LOCAL_API_TOKEN || null;

// 🔧 スケジュール自動作成関連
const SCHEDULE_ENDPOINT = 'http://localhost:8080/api/internal/events/create';
const SCHEDULE_TOKEN = process.env.INTERNAL_API_TOKEN || null;
const ENABLE_SCHEDULE_AUTO_CREATE = process.env.ENABLE_SCHEDULE_AUTO_CREATE !== 'false'; // デフォルト: 有効
const DEFAULT_SCHEDULE_USER_ID = process.env.SCHEDULE_USER_ID || 1; // デフォルト: user_id=1

// 🔧 HTTP Agent を再利用（リクエストごとの生成を防止）
const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 5 });
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 5 });

// 🔧 Cookie キャッシュ（メモリ上に保持）
let cachedCookies = null;
let lastCookieLoadTime = 0;
const COOKIE_CACHE_TTL = 10 * 60 * 1000; // 10分間キャッシュ

// (プロセス終了時のクリーンアップ処理は main.js で一元管理するように変更しました)

// --- seen.json の読み書き ---
function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSeen(state) {
  try {
    fs.writeFileSync(SEEN_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('seen.json write error:', e);
  }
}

// 🔧 改善: Cookie を直接 SQLite から読み込む（コピー不要）
async function getCookiesDirect() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(COOKIE_DB)) return resolve([]);
    
    // READ ONLY モードで直接開く（ロック回避）
    const db = new sqlite3.Database(COOKIE_DB, sqlite3.OPEN_READONLY, err => { 
      if(err) {
        console.warn('Cookie DB direct access failed, falling back to copy method:', err.message);
        return resolve(null); // フォールバック用に null を返す
      }
    });
    
    db.all("SELECT host, name, value, path, isSecure, expiry FROM moz_cookies WHERE host LIKE '%twitter%' OR host LIKE '%x.com%'", [], (err, rows) => {
      if(err){ 
        db.close(); 
        console.warn('Cookie query failed:', err.message);
        return resolve(null);
      }
      const cookies = rows.map(r => ({
        name: r.name,
        value: r.value,
        domain: r.host.startsWith('.') ? r.host.slice(1) : r.host,
        path: r.path,
        secure: r.isSecure === 1,
        httpOnly: false,
        expires: r.expiry
      }));
      db.close();
      resolve(cookies);
    });
  });
}

// 🔧 改善: Cookie キャッシュ機能付き取得（ディスク書き込みゼロ）
async function getCookiesCached() {
  const now = Date.now();
  
  // キャッシュが有効期限内なら再利用
  if (cachedCookies && (now - lastCookieLoadTime) < COOKIE_CACHE_TTL) {
    return cachedCookies;
  }

  // 直接読み込みを試行
  const cookies = await getCookiesDirect();
  
  if (cookies) {
    // 成功した場合はキャッシュに保存
    cachedCookies = cookies;
    lastCookieLoadTime = now;
    return cookies;
  }

  // 直接読み込み失敗時のみコピー方式にフォールバック
  console.warn('[Cookie] Direct access failed, using copy fallback (disk write will occur)');
  await copyCookieDb();
  return await getCookiesFromCopy();
}

// フォールバック用: 従来のコピー方式
async function copyCookieDb() {
  try {
    fs.copyFileSync(COOKIE_DB, TMP_DB);
  } catch (e) {
    console.error('cookie DB copy failed:', e.message || e);
  }
}

async function getCookiesFromCopy() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(TMP_DB)) return resolve([]);
    const db = new sqlite3.Database(TMP_DB, sqlite3.OPEN_READONLY, err => { if(err) reject(err); });
    db.all("SELECT host, name, value, path, isSecure, expiry FROM moz_cookies WHERE host LIKE '%twitter%' OR host LIKE '%x.com%'", [], (err, rows) => {
      if(err){ db.close(); return reject(err); }
      const cookies = rows.map(r => ({
        name: r.name,
        value: r.value,
        domain: r.host.startsWith('.') ? r.host.slice(1) : r.host,
        path: r.path,
        secure: r.isSecure === 1,
        httpOnly: false,
        expires: r.expiry
      }));
      db.close();
      resolve(cookies);
    });
  });
}

// --- 汎用 retry ヘルパ ---
async function retryAsync(fn, retries = 3, baseDelay = 300) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const m = (err && (err.message || String(err))) || '';
      const transient = /socket_not_connected|ERR_SOCKET_NOT_CONNECTED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTCONN|ECONNREFUSED|ENETUNREACH/i.test(m);
      if (i === retries - 1 || !transient) throw err;
      const delay = baseDelay * Math.pow(2, i);
      console.warn(`retryAsync: transient error (${m}). retry ${i+1}/${retries} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// --- ISO 日付パース ---
function parseISO(s) { try { return new Date(s); } catch { return null; } }

// --- ログ用ヘルパ（テキスト要約） ---
function summarizeText(s, max = 120) {
  if (!s) return '';
  const single = s.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return single.slice(0, max) + '…';
}

function summarizeTweetForLog(t) {
  const idShort = (t.id || '').toString().substring(0, 10) + (t.id ? '...' : '');
  const textPreview = summarizeText(t.text || '', 120).replace(/\n/g, ' ');
  return `${idShort} "${textPreview}"`;
}

// --- 通知送信 ---
async function sendNotify(username, tweet, settingKey, sendText) {
  const notificationBody = (sendText && tweet.text)
        ? tweet.text.replace(/\s+/g, ' ').trim().slice(0, 200) + (tweet.text.length > 200 ? '…' : '')
        : "クリックでツイートを開きます";

  const payload = {
    type: "twitter",
    settingKey: settingKey,
    data: {
      title: tweet.isRepost ? `リポスト (@${username})` : (tweet.isQuote ? `引用ツイート (@${username})` : `新着ツイート (@${username})`),
      body: notificationBody,
      url: `https://x.com/${username}/status/${tweet.id}`,
      icon: ICON_URL,
      image: (sendText && (tweet.thumbnail_url || (Array.isArray(tweet.media_urls) ? tweet.media_urls[0] : null))) || null,
      tweet_id: tweet.id
    }
  };

  const agent = (new URL(NOTIFY_ENDPOINT).protocol === 'https:') ? _httpsAgent : _httpAgent;
  const bodyString = JSON.stringify(payload);
  const sig = signNotifyPayload(process.env.NOTIFY_HMAC_SECRET || null, bodyString);

  try {
    const res = await retryAsync(() => fetch(NOTIFY_ENDPOINT, {
      method: 'POST',
        headers: {
        'Content-Type': 'application/json',
        'X-Notify-Token': NOTIFY_TOKEN,
        ...(sig ? { 'X-Notify-Hmac': sig.hmac, 'X-Notify-Timestamp': sig.timestamp } : {}),
      },
      body: bodyString,
      agent,
      timeout: 15000
    }), 3, 300);

    if (!res.ok) {
      const text = await res.text().catch(()=>'<no body>');
      console.error(`[${username}] notify failed:`, res.status, text);
    } else {
      console.log(`[${username}] notify sent for tweet ${tweet.id}`);
    }
  } catch (e) {
    console.error(`[${username}] notify error:`, e.stack || e);
  }
}

// --- スケジュール重複検索 ---
async function findDuplicateSchedule(username, scheduleInfo, tweetId, urls) {
  if (!scheduleInfo) return null;

  const agent = _httpAgent;

  try {
    const external_id = tweetId ? `gemma_${tweetId}` : '';
    const dedupUrl = scheduleInfo.url || (Array.isArray(urls) && urls[0]) || '';
    const queryParams = new URLSearchParams({
      external_id: external_id,
      scheduled_at: scheduleInfo.scheduled_at,
      title: scheduleInfo.title,
      url: dedupUrl,
      token: SCHEDULE_TOKEN
    });

    const res = await retryAsync(() => fetch(`http://localhost:8080/api/internal/events/find-duplicate?${queryParams}`, {
      method: 'GET',
      headers: {
        'X-Notify-Token': SCHEDULE_TOKEN
      },
      agent,
      timeout: 10000
    }), 2, 300);

    if (!res.ok) return null;

    const result = await res.json().catch(() => null);
    return result?.duplicates?.[0] || null;
  } catch (e) {
    console.warn(`[${username}] duplicate search error:`, e.message);
    return null;
  }
}

// --- スケジュール更新 ---
async function updateSchedule(username, scheduleId, scheduleInfo, urls) {
  const agent = _httpAgent;

  const payload = {
    schedule_id: scheduleId,
    title: scheduleInfo.title,
    scheduled_at: scheduleInfo.scheduled_at,
    note: `[Gemma再分析] 時刻更新`,
    url: scheduleInfo.url || urls[0] || null,
    thumbnail_url: scheduleInfo.thumbnail_url || null,
    platform: scheduleInfo.platform || 'twitter',
    // 具体時刻が確定すれば null を渡して時間帯ラベルを消す（実時刻表示へ）
    time_period: scheduleInfo.time_period || null
  };

  try {
    const res = await retryAsync(() => fetch('http://localhost:8080/api/internal/events/update', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Notify-Token': SCHEDULE_TOKEN
      },
      body: JSON.stringify(payload),
      agent,
      timeout: 10000
    }), 2, 300);

    if (!res.ok) {
      console.warn(`[${username}] schedule update failed:`, res.status);
      return false;
    }

    console.log(`[${username}] ✏️ schedule updated (id: ${scheduleId}) - ${scheduleInfo.title} at ${scheduleInfo.scheduled_at}`);
    return true;
  } catch (e) {
    console.error(`[${username}] schedule update error:`, e.message);
    return false;
  }
}

// --- スケジュール自動作成 ---
async function createScheduleFromTweet(username, tweet, analysis) {
  if (!ENABLE_SCHEDULE_AUTO_CREATE) return;
  if (!analysis) return;

  // 引用リツイート（コラボ告知等）はコメント＋引用元の本文を合わせて扱う。
  // 配信URLや時刻の大半は引用元（コラボ相手）のツイート側に含まれるため。
  const combinedText = (tweet.isQuote && tweet.quoted_text)
    ? `${tweet.text || ''}\n${tweet.quoted_text}`
    : (tweet.text || '');

  // URL抽出（引用時は複合テキストから。x.com のリンクは後段の選別で劣後する）
  const urls = extractUrlsFromTweet(combinedText);

  // コラボ（引用）元情報
  const quoteInfo = (tweet.isQuote && tweet.quoted_text)
    ? { user: tweet.quoted_user || null, url: tweet.quoted_url || null, id: tweet.quoted_id || null }
    : null;
  
  // スケジュール抽出
  // 基準日時はツイートの実投稿時刻を使う（new Date()=解析処理の実行時刻だと、
  // 取得・解析の遅延分だけ基準がずれ、日付繰り上げ判定を誤らせる原因になる）。
  const tweetPostedAt = tweet.datetime ? new Date(tweet.datetime) : new Date();
  const scheduleInfo = extractScheduleFromAnalysis(analysis, tweetPostedAt, urls, combinedText, quoteInfo);
  if (!scheduleInfo) {
    console.log(`[${username}] No schedule info extracted from analysis`);
    return;
  }
  
  // ツイートからの画像をサムネイルとして設定（あれば）
  if (tweet.thumbnail_url) {
    scheduleInfo.thumbnail_url = tweet.thumbnail_url;
  }

  // 重複スケジュール検索
  const duplicate = await findDuplicateSchedule(username, scheduleInfo, tweet.id, urls);
  
  if (duplicate) {
    // 既存スケジュールを更新
    // time_period は既存のものを維持（YouTube等で確定済みの場合、Gemmaの推定で上書きしない）
    console.log(`[${username}] Found duplicate: id=${duplicate.id}, updating...`);
    await updateSchedule(username, duplicate.id, { ...scheduleInfo, time_period: duplicate.time_period || scheduleInfo.time_period }, urls);
    return;
  }

  // 新規作成
  const agent = (new URL(SCHEDULE_ENDPOINT).protocol === 'https:') ? _httpsAgent : _httpAgent;

  const quoteNote = quoteInfo ? ` 引用元: @${quoteInfo.user || '?'} ${quoteInfo.url || ''}` : '';
  const payload = {
    title: scheduleInfo.title,
    scheduled_at: scheduleInfo.scheduled_at,
    note: `[Gemma分析${scheduleInfo.time_estimated ? '/時刻は時間帯から推定' : ''}] ツイート: ${tweet.text.substring(0, 100)}...${quoteNote}`,
    url: scheduleInfo.url || urls[0] || `https://x.com/${username}/status/${tweet.id}`,
    thumbnail_url: scheduleInfo.thumbnail_url || null,
    platform: scheduleInfo.platform || 'twitter',
    time_period: scheduleInfo.time_period || null,
    external_id: `gemma_${tweet.id}`
  };

  try {
    const res = await retryAsync(() => fetch(SCHEDULE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Notify-Token': SCHEDULE_TOKEN
      },
      body: JSON.stringify(payload),
      agent,
      timeout: 15000
    }), 2, 300);

    if (!res.ok) {
      const text = await res.text().catch(()=>'<no body>');
      console.error(`[${username}] schedule creation failed:`, res.status, text);
    } else {
      const result = await res.json().catch(()=>({}));
      console.log(`[${username}] ✅ schedule created (id: ${result.id}) - ${scheduleInfo.title} at ${scheduleInfo.scheduled_at}${urls.length ? ` [${urls.length} URL]` : ''}`);
    }
  } catch (e) {
    console.error(`[${username}] schedule creation error:`, e.stack || e);
  }
}

// --- 単一ユーザのチェック ---
async function checkOneUser(page, username, seenState) {
  try {
    // ページ遷移を retry でラップ（瞬断吸収）
    await retryAsync(async () => {
      await page.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // ログイン画面に飛ばされていないかチェック
      const isLogin = await page.evaluate(() => {
        return document.title.includes('ログイン') || 
               document.title.includes('Log in') || 
               location.href.includes('/login') ||
               !!document.querySelector('a[href="/login"]');
      });

      if (isLogin) {
        console.warn(`[${username}] ⚠️ ログイン画面が検出されました。セッションが切れている可能性があります。`);
      }

      // article 要素が出現するのを待つ（最大20秒）
      try {
        await page.waitForSelector('article', { timeout: 20000 });
      } catch {
        console.warn(`[${username}] ⚠️ article要素が見つかりません（エラーページ・レート制限の可能性）`);
      }
      
      // スクロールして追加読み込みを誘発
      await page.evaluate(() => {
        window.scrollBy(0, 2000);
      });
      await new Promise(r => setTimeout(r, 2000));

    }, 3, 500);

    const tweets = await page.evaluate(() => {
      const articles = Array.from(document.querySelectorAll('article'));
      const seen = new Set();
      const out = [];
      for (const article of articles) {
        const link = article.querySelector('a[href*="/status/"]');
        if (!link) continue;
        const href = link.getAttribute('href') || '';
        const id = href.split('/').filter(Boolean).pop();
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        const timeEl = article.querySelector('time');
        let datetime = timeEl ? timeEl.getAttribute('datetime') : null;

        // datetime が取れなかった場合、ツイートID (Snowflake) から逆算を試みる
        if (!datetime && id) {
          try {
            // Twitter Snowflake ID (2010年以降): (id >> 22) + 1288834974657
            const tweetIdBigInt = BigInt(id);
            const timestampMs = (tweetIdBigInt >> 22n) + 1288834974657n;
            datetime = new Date(Number(timestampMs)).toISOString();
          } catch (e) {
            console.warn(`[Twitter] Snowflake conversion failed for ${id}:`, e.message);
          }
        }
        let text = '';
        const tweetText = article.querySelector('div[lang]') || article;
        text = tweetText ? tweetText.innerText : article.innerText;
        
        // ツイート内の全画像URL（メディア画像）を取得（アイコンや絵文字等を除外）
        const mediaImages = Array.from(article.querySelectorAll('img'))
                              .map(img => img.src)
                              .filter(src => src && src.includes('pbs.twimg.com/media/'));
        
        // 動画の有無を判定（videoPlayer が存在するか）
        const hasVideo = !!article.querySelector('[data-testid="videoPlayer"]') ||
                         !!article.querySelector('video');

        // リポスト判定
        // 1) socialContext ラベルによる判定
        const socialContext = article.querySelector('[data-testid="socialContext"]');
        const isRepostByContext = socialContext ? (socialContext.innerText.includes('リポスト') || socialContext.innerText.includes('Reposted') || socialContext.innerText.toLowerCase().includes('reposted')) : false;

        // 2) 本文が "RT @" で始まる場合はリポスト確定（旧形式リツイート）
        const isRepostByText = /^\s*RT\s+@/.test(text || '');

        const isRepost = isRepostByContext || isRepostByText;

        // 引用リツイート判定: 記事内に div[lang] が複数あれば、2つ目が引用元ツイート本文
        // （引用元がDOMに埋め込まれる）。コラボ告知は引用での投稿が多いため、
        // 引用元の本文・URL・アカウントを取得してスケジュール生成に使う。
        let quotedText = null, quotedUser = null, quotedUrl = null, quotedId = null;
        const langDivs = Array.from(article.querySelectorAll('div[lang]'));
        if (langDivs.length >= 2) {
          quotedText = langDivs[1].innerText;
          // 引用元ツイートへのリンク（メインツイートと異なる status ID）を探す
          const anchors = Array.from(article.querySelectorAll('a[href*="/status/"]'));
          for (const a of anchors) {
            const h = a.getAttribute('href') || '';
            const m = h.match(/\/status\/(\d+)/);
            if (m && m[1] !== id) {
              quotedId = m[1];
              quotedUrl = 'https://x.com' + h.split(/[?#]/)[0];
              const um = h.match(/^\/([A-Za-z0-9_]+)\/status\//);
              if (um && um[1] !== 'i') quotedUser = um[1];
              break;
            }
          }
          // URLから取れない場合、引用本文中の @handle から補完
          if (!quotedUser && quotedText) {
            const hm = quotedText.match(/@([A-Za-z0-9_]{1,15})/);
            if (hm) quotedUser = hm[1];
          }
        }
        const isQuote = !!quotedText;

        out.push({ id, text, datetime, thumbnail_url: mediaImages[0] || null, media_urls: mediaImages, hasVideo, isRepost, isQuote, quoted_text: quotedText, quoted_user: quotedUser, quoted_url: quotedUrl, quoted_id: quotedId });
      }
      return out.filter(t => !t.text.includes('固定'));
    });

    const now = Date.now();
    const maxAgeMs = MAX_AGE_HOURS * 3600 * 1000;
    const seenIds = seenState.ids || [];
    const newTweets = [];

    for (const t of tweets) {
      if (seenIds.includes(t.id)) continue;
      const createdAt = t.datetime ? parseISO(t.datetime) : null;
      const ageOk = createdAt ? ((now - createdAt.getTime()) <= maxAgeMs) : true;
      if (ageOk) newTweets.push(t);
    }

    return { newTweets, normalTweets: tweets };

  } catch (err) {
    return { newTweets: [], normalTweets: [], error: err.message };
  }
}

// --- main check 関数（ブラウザ再利用・Cookie キャッシュ版） ---
async function check(username, isRetry = false) {
  const seenState = loadSeen();
  
  let page;
  let requestHandler;
  try {
    // 🔧 ブラウザを再利用（新しいページだけ開く）
    // ytcommunity等とのプロファイル競合(The browser is already running)を防ぐため独立したディレクトリを使用
    
    // 💡 起動前に古いロックファイルがあったら削除を試みる（ゾンビ防止）
    const lockPath = path.join(PROFILE_PATH, 'parent.lock');
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch(e) {}
    }

    const browser = await getSharedBrowser({
      product: 'chrome',
      headless: HEADLESS,
      userDataDir: PROFILE_PATH,
      extraArgs: [
        '--disable-blink-features=AutomationControlled',
      ]
    });
    page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

    // 不要なリソースをブロックしてメモリと通信量を節約
    // ★ stylesheet はブロックしない: X.com(React SPA) が正しくレンダリングされず
    // アンチボット判定やエラーページ表示の原因になるため。
    await page.setRequestInterception(true);
    requestHandler = (request) => {
      const resourceType = request.resourceType();
      if (['image', 'font', 'media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    };
    page.on('request', requestHandler);

    // (Cookieは userDataDir: PROFILE_PATH からネイティブに読み込まれ、自動更新されるため手動注入は削除)

    if (!seenState[username]) seenState[username] = { ids: [], firstRun: true };

    const { newTweets, normalTweets, error } = await checkOneUser(page, username, seenState[username]);

    // --- 追加ログ: 取得できた最新のツイートを要約してログに残す ---
    try {
      if (Array.isArray(normalTweets) && normalTweets.length > 0) {
        const samples = normalTweets.slice(0, 2).map(summarizeTweetForLog);
        console.log(`[${username}] fetched ${normalTweets.length} tweets. latest: ${samples.join(' | ')}`);
      } else {
        console.log(`[${username}] fetched 0 tweets.`);
        
        // ✅ 0件取得かつ初回チェックの場合、5秒後に再チェック
        if (!isRetry) {
          console.log(`[${username}] ⚠️ 0件取得のため5秒後に再チェックします...`);
          // リスナーを削除してからページを閉じる
          if (typeof requestHandler === 'function' && page && !page.isClosed()) {
            page.off('request', requestHandler);
          }
          if (page && !page.isClosed()) {
            try { await page.close(); } catch (e) {
              console.warn(`[${username}] Failed to close page before retry:`, e.message);
            }
          }
          page = null; // finally ブロックで二重クローズしないよう null 化
          await new Promise(r => setTimeout(r, 5000));
          return await check(username, true); // 再帰呼び出し（再チェック）
        } else {
          console.log(`[${username}] ⚠️ 再チェックでも0件でした。セッション切れ、またはアクセス制限の可能性があります。`);
          return { username, newTweets: [], error: '0件取得エラー（セッション切れ・制限の可能性あり）' };
        }
      }
    } catch (e) {
      console.warn(`[${username}] failed to log fetched tweets:`, e && e.message ? e.message : e);
    }

    if (seenState[username].firstRun) {
      seenState[username].ids = normalTweets.map(t => t.id);
      seenState[username].firstRun = false;
      saveSeen(seenState);
      console.log(`[${username}] 初回実行: ${normalTweets.length}件を既読として記録`);
    } else if (newTweets.length > 0) {
      const idsToAdd = normalTweets.map(t => t.id);
      seenState[username].ids = Array.from(new Set([...idsToAdd, ...seenState[username].ids])).slice(0, 200);
      saveSeen(seenState);

      let settingKey = null;
      let sendText = true;

      const lowerUsername = username.toLowerCase();
      if (lowerUsername === 'koinoya_mai') {
          settingKey = 'twitterMain';
          sendText = true;
      } else if (lowerUsername === 'koinoyamai17') {
          settingKey = 'twitterSub';
          sendText = false;
      } else {
          settingKey = 'twitterMain';
          sendText = false;
      }

      console.log(`[${username}] 新着ツイート ${newTweets.length}件 (settingKey: ${settingKey})`);

      for (const t of newTweets.slice().reverse()) {
        console.log(`[${username}] 新しいツイート: ${summarizeTweetForLog(t)}`);
        
        // 🤖 Gemma分析と 🔔 通知送信を並列（同時）に実行する
        const notifyPromise = sendNotify(username, t, settingKey, sendText)
          .catch(err => console.error(`[${username}] Notify error:`, err.message || err));

        const gemmaPromise = (async () => {
          if (!t.isRepost) {
            try {
              // 引用リツイート（コラボ告知等）はコメント＋引用元の両方を解析対象にする。
              // 引用元が配信予告の場合は REPOST ではなく LIVE として拾わせるヒントを付ける。
              const analysisInput = (t.isQuote && t.quoted_text)
                ? `【引用リツイート】投稿者のコメント:\n${t.text || ''}\n\n【引用元ツイート】@${t.quoted_user || 'unknown'}:\n${t.quoted_text}\n\n※引用元に配信予告（コラボ等・時刻や時間帯の記載あり）が含まれる場合は category=LIVE にすること。`
                : t.text;
              const analysis = await analyzeTweet(analysisInput);
              console.log(`[${username}] Gemma analysis: category=${analysis.category}, status=${analysis.status}, time=${analysis.start_time}${t.isQuote ? ' [quote]' : ''}`);
              // 💾 分析結果をnotifications.dataへ保存（ツイート統計用）
              try {
                const analysisBody = { tweet_id: t.id, platform: settingKey, analysis };
                const analysisPayload = JSON.stringify(analysisBody);
                const analysisSig = signNotifyPayload(process.env.NOTIFY_HMAC_SECRET || null, analysisPayload);
                // 分析APIは同一ホストの API プロセス宛。NOTIFY_API_URL の origin から組み立て
                // （localhost:8080 固定だと staging が本番へ誤送するため）。
                const analysisBase = (() => { try { return new URL(process.env.NOTIFY_API_URL || 'http://localhost:8080/api/notify').origin; } catch { return 'http://localhost:8080'; } })();
                await fetch(analysisBase + '/api/internal/twitter/analysis', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Notify-Token': NOTIFY_TOKEN,
                    ...(analysisSig ? { 'X-Notify-Hmac': analysisSig.hmac, 'X-Notify-Timestamp': analysisSig.timestamp } : {}),
                  },
                  body: analysisPayload,
                  agent: _httpAgent,
                  timeout: 10000,
                }).catch(() => {});
              } catch (saveErr) { console.warn(`[${username}] analysis save error:`, saveErr.message); }
              // 📅 分析結果からスケジュール作成
              if (analysis) {
                await createScheduleFromTweet(username, t, analysis);
                
                // ⏰ 配信予定の時刻差異（Twitter vs YouTube）をチェック
                if (analysis.category === 'LIVE' && !t.isRepost) {
                  await checkScheduleDrift(t).catch(err => console.error(`[${username}] Drift check error:`, err.message));
                }
              }
            } catch (err) {
              console.warn(`[${username}] Gemma analysis error:`, err.message);
            }
          } else {
            console.log(`[${username}] Gemma analysis skipped for repost.`);
          }
        })();

        // 両方の処理を待つ（通知のリクエスト自体は一瞬で飛ぶ）
        await Promise.all([notifyPromise, gemmaPromise]);
      }

      // 🖼️ メディア保存（リポスト以外の新着ツイート）
      try {
        await twitterMediaSaver.saveAllMedia(newTweets, username);
      } catch (mediaSaveErr) {
        console.error(`[${username}] メディア保存エラー:`, mediaSaveErr.message);
      }
    } else {
      if (Array.isArray(normalTweets) && normalTweets.length > 0) {
        console.log(`[${username}] 新着なし。直近取得: ${summarizeTweetForLog(normalTweets[0])}`);
      } else {
        console.log(`[${username}] 新着なし。取得ツイートなし`);
      }
    }

    return { username, newTweets, error };

  } catch (e) {
    console.error(`[${username}] check error:`, e.message);
    return { username, newTweets: [], error: e.message };
  } finally {
    // 🔧 ブラウザは閉じず、ページだけ閉じる
    if (page && !page.isClosed()) {
      try {
        // リスナーを削除してからページを閉じる（メモリリーク防止）
        if (typeof requestHandler === 'function') {
          page.off('request', requestHandler);
        }
        await page.close();
      } catch (e) {
        console.warn(`[${username}] Failed to close page:`, e.message);
      }
    }
  }
}

// --- startWatcher 関数 ---
function startWatcher(username, intervalMs = CHECK_INTERVAL_MS) {
  console.log(`[Twitter] ${username} の監視を開始 (間隔: ${intervalMs/1000}秒)`);

  setInterval(async () => {
    try {
      const result = await check(username);
      if (result.error) {
        console.error(`[${username}] check error:`, result.error);
      }
    } catch (e) {
      console.error(`[${username}] watcher error:`, e.message);
    }
  }, intervalMs);

  // 起動直後に一回チェックする
  (async () => {
    try {
      await check(username);
    } catch (e) {
      console.error(`[${username}] initial check error:`, e.message);
    }
  })();
}

// --- exports ---
module.exports = { check, startWatcher };
