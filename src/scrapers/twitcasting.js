const http = require('http');
const https = require('https');
const { URL } = require('url');
const { getSharedBrowser, closeSharedBrowser } = require('../core/browser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { signNotifyPayload } = require('../core/notify-sign');
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || null;

const SEEN_PATH = path.join(__dirname, 'twicas_seen.json');
const LOGS_DIR = path.join(__dirname, 'logs');

const API_BASE_URL = 'https://apiv2.twitcasting.tv';
const CLIENT_ID = process.env.TWITCASTING_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCASTING_CLIENT_SECRET;

const DISABLE_NOTIFICATIONS = process.env.DISABLE_NOTIFICATIONS === '1' || process.env.DISABLE_NOTIFICATIONS === 'true';
if (DISABLE_NOTIFICATIONS) console.log('TwitCasting: notifications disabled via DISABLE_NOTIFICATIONS');

const SCHEDULE_ENDPOINT = process.env.SCHEDULE_ENDPOINT || 'http://localhost:8080/api/internal/events/create';
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || null;
const NOTIFY_TOKEN = process.env.NOTIFY_API_TOKEN || null;
const NOTIFY_ENDPOINT = process.env.NOTIFY_API_URL || 'http://localhost:8080/api/notify';
const CHECK_INTERVAL_MS = 5000;
const MAX_AGE_HOURS = 24;

// プライベートライブの Puppeteer チェックは重い（フルChromeページ読込）。
// API 監視は CHECK_INTERVAL_MS のまま、ブラウザを使う private チェックだけ間引く。
// 既定60秒に1回。環境変数 TC_PRIVATE_CHECK_MS で調整可（0でAPI同期＝従来動作）。
const PRIVATE_CHECK_INTERVAL_MS = parseInt(process.env.TC_PRIVATE_CHECK_MS || '60000', 10);
const lastPrivateCheckAt = new Map();   // screenId -> timestamp(ms)
const lastPrivateResult  = new Map();   // screenId -> boolean

const lastLiveStatus = new Map();

function loadSeen() {
    try { return JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')); } catch { return {}; }
}
function saveSeen(state) {
    try { fs.writeFileSync(SEEN_PATH, JSON.stringify(state, null, 2)); } catch(e){ console.error('seen.json write error:', e); }
}

async function retryAsync(fn, retries=3, baseDelay=300) {
    for(let i=0;i<retries;i++){
        try{ return await fn(); } catch(err){
            const m = (err && (err.message || String(err))) || '';
            const transient = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|ERR_NETWORK_CHANGED/i.test(m);
            if(i === retries-1 || !transient) throw err;
            const delay = baseDelay * Math.pow(2,i);
            console.warn(`retryAsync transient error (${m}), retry ${i+1}/${retries} after ${delay}ms in ${fn.name || 'anonymous function'}`);
            await new Promise(r=>setTimeout(r,delay));
        }
    }
}

async function sendNotify(screenId, movieId, title = '【ツイキャス】ライブ配信', body = '', image = null) {
    if (DISABLE_NOTIFICATIONS) {
        console.log(`[${screenId}] notify suppressed (DISABLE_NOTIFICATIONS) - movie ${movieId}`);
        return;
    }
    
    if (!NOTIFY_TOKEN || !NOTIFY_ENDPOINT) {
        console.log(`[${screenId}] notify skipped (missing token or endpoint) - movie ${movieId}`);
        return;
    }

    const payload = {
        data: {
            title: title,
            body: body,
            url: `https://twitcasting.tv/${screenId}/movie/${movieId}`,
            icon: 'https://twitcasting.tv/favicon.ico',
            image: image || null
        },
        type: 'twitcasting',
        // settingKey は購読者の通知ON/OFF設定・履歴のplatform列・カスタムリンク変換の
        // キーになる。screenId を入れると settings['c:koinoya_mai'] を見に行ってしまい
        // ツイキャスのOFF設定が一切効かなくなるため、固定キーを渡す。
        settingKey: 'twitcasting'
    };

    let agent;
    try {
        const parsed = new URL(NOTIFY_ENDPOINT);
        agent = parsed.protocol === 'https:' 
            ? new https.Agent({keepAlive: false}) 
            : new http.Agent({keepAlive: false});
    } catch(e) { 
        agent = undefined; 
    }

    try {
        const bodyString = JSON.stringify(payload);
        const sig = signNotifyPayload(process.env.NOTIFY_HMAC_SECRET || null, bodyString);
        const res = await retryAsync(() => fetch(NOTIFY_ENDPOINT, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'X-Notify-Token': NOTIFY_TOKEN,
                ...(sig ? { 'X-Notify-Hmac': sig.hmac, 'X-Notify-Timestamp': sig.timestamp } : {})
            },
            body: bodyString,
            agent,
            timeout: 15000
        }), 3, 300);
        
        if (!res.ok) {
            const text = await res.text().catch(() => '<no body>');
            console.error(`[${screenId}] notify failed:`, res.status, text);
        } else {
            console.log(`[${screenId}] notify sent for movie ${movieId}`);
        }
    } catch(e) { 
        console.error(`[${screenId}] notify error:`, e.stack || e); 
    }
}

// スケジュール同期は即時には失敗しうる。特に 409(duplicate) は相手側イベントの
// status が次第で数時間後に解消するため、1回だけで諦めると二度と取り込まれない
// （＝配信が始まったのにスケジュールに入らない事故の元）。4xx で 409 以外は
// 再試行しても無駄なので打ち切る。
const SYNC_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

function retryDelay(ms) {
    return new Promise(resolve => {
        const t = setTimeout(resolve, ms);
        if (t && typeof t.unref === 'function') t.unref();
    });
}

async function syncEventToSchedule(screenId, movieId, title, thumbnailUrl, attempt = 0) {
    if (!SCHEDULE_ENDPOINT || !INTERNAL_TOKEN) return;
    const tag = attempt === 0 ? '' : ` (retry ${attempt}/${SYNC_RETRY_DELAYS_MS.length})`;
    try {
        const payload = {
            title: title || 'ツイキャス配信',
            scheduled_at: new Date().toISOString(),
            url: `https://twitcasting.tv/${screenId}/movie/${movieId}`,
            thumbnail_url: thumbnailUrl || null,
            platform: 'twitcasting',
            external_id: `twitcasting_${movieId}`
        };
        const res = await fetch(SCHEDULE_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Notify-Token': INTERNAL_TOKEN
            },
            body: JSON.stringify(payload),
            timeout: 10000
        });
        if (res.ok) {
            const result = await res.json().catch(() => ({}));
            console.log(`[${screenId}] schedule event created (id: ${result.id}) for movie ${movieId}${tag}`);
            return;
        }
        const status = res.status;
        const retryable = status === 409 || status >= 500;
        if (!retryable || attempt >= SYNC_RETRY_DELAYS_MS.length) {
            console.warn(`[${screenId}] schedule event creation failed: ${status}${tag}`);
            return;
        }
        const waitMs = SYNC_RETRY_DELAYS_MS[attempt];
        console.warn(`[${screenId}] schedule event creation failed: ${status}${tag} → retry in ${waitMs / 1000}s`);
        await retryDelay(waitMs);
        return syncEventToSchedule(screenId, movieId, title, thumbnailUrl, attempt + 1);
    } catch (e) {
        if (attempt >= SYNC_RETRY_DELAYS_MS.length) {
            console.error(`[${screenId}] schedule event error:`, e.message, tag);
            return;
        }
        const waitMs = SYNC_RETRY_DELAYS_MS[attempt];
        console.warn(`[${screenId}] schedule event error: ${e.message}${tag} → retry in ${waitMs / 1000}s`);
        await retryDelay(waitMs);
        return syncEventToSchedule(screenId, movieId, title, thumbnailUrl, attempt + 1);
    }
}

// 🔧 修正: ブラウザを再利用し、新しいページを開いて使い回す
async function checkPrivateLive(screenId){
    const url = `https://twitcasting.tv/${screenId}/movie/latest`;
    let page;
    let requestHandler;
    try{
const browser = await getSharedBrowser({
      userDataDir: process.platform === 'linux'
        ? '/dev/shm/puppeteer-profile-shared'
        : path.join(__dirname, 'tmp', 'puppeteer-shared'),
      ephemeral: true
    });
        page = await browser.newPage();
        
        // 🔧 ディスク書き込みを最小限に抑える設定
        await page.setCacheEnabled(false);
        
        // リクエストをフィルタリング（不要なリソースをブロック）
        await page.setRequestInterception(true);
        requestHandler = (req) => {
            const resourceType = req.resourceType();
            // 画像、CSS、フォント、メディアをブロック（HTMLとJSのみ許可）
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        };
        page.on('request', requestHandler);
        
        await retryAsync(async()=>{ 
            await page.goto(url, {waitUntil:'domcontentloaded', timeout:60000}); 
            await new Promise(r=>setTimeout(r,2000)); 
        }, 3, 500);
        
        const isPrivate = await page.$eval('.tw-empty-state-text', el=>el.textContent.includes('合言葉')).catch(()=>false);
        const isLiveBadge = await page.$eval('.tw-movie-thumbnail2-badge[data-status="live"]', ()=>true).catch(()=>false);
        
        return isPrivate && isLiveBadge;
    } catch(e) { 
        console.error(`[${screenId}] checkPrivateLive error:`, e.stack || e); 
        throw e; 
    } finally { 
        // ブラウザは閉じず、ページだけ閉じる
        if (page) {
            try {
                if (typeof requestHandler === 'function') {
                    page.off('request', requestHandler);
                }
                await page.close();
            } catch (e) {
                console.warn(`[${screenId}] Failed to close page:`, e.message);
            }
        }
    }
}

function startWatcher(screenId, intervalMs=CHECK_INTERVAL_MS, onError = null, onRecovery = null){
    if (!screenId) {
        console.warn('[TwitCasting] startWatcher called with empty screenId — skipping');
        return;
    }

    console.log(`[TwitCasting] ${screenId} の監視開始 (間隔: ${intervalMs/1000}秒)`);

    let running = false;

    const loop = async () => {
        if (running) return;
        running = true;
        try {
            await checkLiveStatus(screenId);
            if (typeof onRecovery === 'function') onRecovery();
        } catch (e) {
            const msg = e && (e.stack || e.message) ? (e.stack || e.message) : String(e);
            console.error(`[${screenId}] watcher error:`, msg);
            if (typeof onError === 'function') {
                onError(msg);
            }
        } finally {
            running = false;
        }

        const t = setTimeout(loop, intervalMs);
        if (t && typeof t.unref === 'function') t.unref();
    };

    loop();
}

async function checkLiveStatus(screenId){
    if (!screenId) {
        console.warn('[checkLiveStatus] empty screenId provided');
        return null;
    }

    let currentLiveId = lastLiveStatus.get(screenId) || null;
    const prevLiveId = currentLiveId;

    try{
        if(!CLIENT_ID || !CLIENT_SECRET) throw new Error('TWITCASTING_CLIENT_ID / TWITCASTING_CLIENT_SECRET 未設定 (環境変数で設定してください)');

        const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const res = await axios.get(`${API_BASE_URL}/users/${screenId}/movies?limit=1&status=live`, {
            headers: { 'Authorization': `Basic ${basicAuth}`, 'X-Api-Version':'2.0' },
            validateStatus:()=>true,
            timeout: 15000
        });

        if (!(res.status >= 200 && res.status < 300)) {
            console.warn(`[${screenId}] TwitCasting API returned status ${res.status}`);
        }

        const movie = Array.isArray(res.data?.movies) ? res.data.movies[0] : null;

        if (movie) {
            const isLiveFlag = movie.status === 'live' || movie.is_live === true;
            let startedOk = true;
            if (movie.started_at) {
                const started = new Date(movie.started_at).getTime();
                const now = Date.now();
                const ageMs = now - started;
                const maxAcceptMs = (MAX_AGE_HOURS || 24) * 60 * 60 * 1000;
                if (isNaN(started) || ageMs > maxAcceptMs) {
                    startedOk = false;
                    console.warn(`[${screenId}] movie.started_at too old or invalid: ${movie.started_at}`);
                }
            }

            if (isLiveFlag && startedOk) {
                const observedTitle = movie.title || 'タイトル不明';
                console.log(
                  `[${screenId}] Polling Result: 🟢 Live (ID: ${movie.id}, Title: "${observedTitle}", status=${movie.status}, is_live=${movie.is_live})`
                );

                if (movie.id !== prevLiveId) {
                    currentLiveId = movie.id;
                    lastLiveStatus.set(screenId, currentLiveId);
                    console.log(`🔴 Live started! movie_id: ${currentLiveId}`);

                    const notifyTitle = '【ツイキャス】ライブ開始';
                    const notifyBody  = observedTitle;

                    console.log(`[Notify Preview] screenId=${screenId}, movieId=${currentLiveId}, title="${notifyTitle}", body="${notifyBody}"`);

                    // ツイキャスのサムネは http 配信だが、CSP(img-src) は https のみ許可する。
                    // imagegw*.twitcasting.tv は https 対応済みのため、保存前に正規化する。
                    let thumbUrl = movie.large_thumbnail || movie.thumbnail || null;
                    if (thumbUrl && /^http:\/\/(?:[\w-]+\.)*twitcasting\.tv\//i.test(thumbUrl)) {
                        thumbUrl = 'https://' + thumbUrl.slice(7);
                    }
                    try {
                        await sendNotify(screenId, currentLiveId, notifyTitle, notifyBody, thumbUrl);
                    } catch (e) {
                        console.error(`[${screenId}] sendNotify error:`, e && (e.stack || e.message) ? (e.stack || e.message) : e);
                    }
                    syncEventToSchedule(screenId, currentLiveId, observedTitle, thumbUrl)
                        .catch(e => console.error(`[${screenId}] syncEventToSchedule error:`, e.message));
                } else {
                    lastLiveStatus.set(screenId, movie.id);
                }
                return movie.id;
            } else {
                console.log(`[${screenId}] API returned movie but not confirmed live (status=${movie.status}, is_live=${movie.is_live}, started_ok=${startedOk})`);
            }
        } else {
            console.log(`[${screenId}] API returned no movies`);
        }

        // ブラウザを使う private チェックは間引く（直近の結果を再利用）。
        let isPrivate;
        const now = Date.now();
        const sinceLast = now - (lastPrivateCheckAt.get(screenId) || 0);
        if (PRIVATE_CHECK_INTERVAL_MS <= 0 || sinceLast >= PRIVATE_CHECK_INTERVAL_MS) {
            isPrivate = await checkPrivateLive(screenId);
            lastPrivateCheckAt.set(screenId, now);
            lastPrivateResult.set(screenId, isPrivate);
        } else {
            isPrivate = lastPrivateResult.get(screenId) || false;
        }
        if (isPrivate) {
            console.log(`[${screenId}] Polling Result: 🔒 Private Live detected (via Puppeteer)`);
            if (prevLiveId !== 'private') {
                currentLiveId = 'private';
                lastLiveStatus.set(screenId, 'private');
                console.log('🔒 プライベートライブ中！');

                const notifyTitle = '【ツイキャス】プライベートライブ';
                const notifyBody  = '(合言葉あり)';

                console.log(`[Notify Preview] screenId=${screenId}, movieId=private, title="${notifyTitle}", body="${notifyBody}"`);

                try {
                    await sendNotify(screenId, 'private', notifyTitle, notifyBody);
                } catch (e) {
                    console.error(`[${screenId}] sendNotify error:`, e && (e.stack || e.message) ? (e.stack || e.message) : e);
                }
                syncEventToSchedule(screenId, 'private', '(プライベートライブ)', null)
                    .catch(e => console.error(`[${screenId}] syncEventToSchedule error:`, e.message));
            }
            return 'private';
        }

        if (prevLiveId !== null) {
            console.log(`[${screenId}] Polling Result: ⚪ Offline (No public or private live detected). previous=${prevLiveId}`);
        } else {
            console.log(`[${screenId}] Polling Result: ⚪ Offline (No public or private live detected)`);
        }
        lastLiveStatus.set(screenId, null);
        return null;

    } catch (e) {
        const msg = e && (e.message || e.stack) || String(e);
        console.error(`[${screenId}] checkLiveStatus error:`, msg);
        console.log(`[${screenId}] Polling Result: ⚠️ Error occurred`);
        throw e;
    }
}

module.exports = { checkLiveStatus, startWatcher, sendNotify, checkPrivateLive, syncEventToSchedule };


