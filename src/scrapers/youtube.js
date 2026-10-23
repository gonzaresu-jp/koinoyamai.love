// youtube-webhook.js
const express = require('express');
const bodyParser = require('body-parser');
const xml2js = require('xml2js');
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { parseStringPromise } = require('xml2js');
const { deriveUploadsPlaylistId, parseRssEntries, parsePlaylistItems, decideDetectionState } = require('../core/youtube-feed');
const { sendDiscordAlert } = require('../core/discord-alert');
const { upsertEvent } = require('../../weekly');

const CHANNEL_IDS = [
    'UCElHA6-5CBmgWODVWNxS8VA',
    'UCgttI8QfdWhvd3SRtCYcJzw'
];
// ==== PubSubHubbub 契約 ====
// hub（pubsubhubbub.appspot.com）はインターネットから callback に到達する
// 必要がある。tailnet 専用 URL（elza.poitou-mora.ts.net）は hub から到達できず、
// 購読リクエストが 409（Response Body: Bad response code 504）で失敗する。
// 結果として webhook 経路が死に、検知は RSS/プレイリスト経路だけに依存する
// 状態になっていた（2026-10-20 実測: 最終配信 2026-10-02、購読は恒久失敗）。
//
// よって callback は公開 URL を使い、共有シークレットで保護する。
// hub は callback URL に hub.mode / hub.challenge 等を**追記**するため、
// クエリの token はそのまま維持される。
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://koinoyamai.love').replace(/\/+$/, '');
const WEBHOOK_TOKEN = process.env.YOUTUBE_WEBHOOK_TOKEN || '';
// 1リクエストで処理する entry の上限（不正 POST での大量処理防止）
const WEBHOOK_MAX_ENTRIES = 20;
const CALLBACK_URL = `${PUBLIC_URL}/youtube-webhook${WEBHOOK_TOKEN ? `?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : ''}`;
// ログに出す用の callback URL（トークンは伏せる）
const CALLBACK_URL_LOG = CALLBACK_URL.replace(/([?&]token=)[^&]*/i, '$1***');
const PUBSUBHUBBUB_HUB = 'https://pubsubhubbub.appspot.com/subscribe';

let NOTIFY_CONFIG = {
    token: null,
    apiUrl: 'http://localhost:8080/api/notify',
    hmacSecret: null
};

const ICON_URL = '/icon.webp';

// 閾値（使用箇所あり）
const RECENT_VIDEO_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours (既存値を維持)
// PubSubHubbub配信遅延を考慮して10分に緩和
const PLANNED_ASSUMPTION_THRESHOLD_MS = 10 * 60 * 1000; 

const API_KEY = process.env.YOUTUBE_API_KEY || ''; // 必ず環境変数で提供する事

// staging（DISABLE_NOTIFICATIONS=1）では nassy への実DL通知(POST /)を送らない。
// ここで false を返すと呼び出し側が「未送信」とみなして毎ポーリングで再送してしまうため、
// 送信は行わず「成功扱い(true)」にして sent_records に記録だけ残す（prod は影響なし）。
const DISABLE_INTERNAL_NOTIFY =
    process.env.DISABLE_NOTIFICATIONS === '1' || process.env.DISABLE_NOTIFICATIONS === 'true';

const SENT_RECORDS_FILE = path.join(__dirname, '..', '..', 'sent_records.json');

function loadSentRecords() {
    try {
        if (fs.existsSync(SENT_RECORDS_FILE)) {
            const raw = fs.readFileSync(SENT_RECORDS_FILE, 'utf8');
            return JSON.parse(raw || '{}');
        }
    } catch (e) {
        console.error('Failed to load sent records:', e);
    }
    return {};
}

function saveSentRecords(records) {
    try {
        fs.writeFileSync(SENT_RECORDS_FILE, JSON.stringify(records, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save sent records:', e);
    }
}

/** YouTube Data API で動画情報を取得 */
async function fetchVideoStatus(videoId) {
    if (!API_KEY) throw new Error('YOUTUBE_API_KEY not set in environment');
    const url = 'https://www.googleapis.com/youtube/v3/videos';
    try {
        const resp = await axios.get(url, {
            params: {
                id: videoId,
                part: 'snippet,liveStreamingDetails,status',
                key: API_KEY
            },
            timeout: 10_000
        });
        if (resp.data && resp.data.items && resp.data.items.length > 0) {
            return resp.data.items[0];
        }
        return null;
    } catch (err) {
        console.error(`fetchVideoStatus error for ${videoId}:`, err.message || err);
        return null;
    }
}

function buildEventFromVideoItem(item, fallbackTitle) {
    if (!item || !item.id) return null;

    const live = item.liveStreamingDetails || null;
    const status = item.status || {};
    const snippet = item.snippet || {};

    const title = fallbackTitle || snippet.title || 'YouTube動画';
    const description = snippet.description || null;
    const thumbnail =
        snippet.thumbnails?.high?.url ||
        snippet.thumbnails?.medium?.url ||
        null;

    let eventType = 'video';
    let eventStatus = 'ended';
    let startTime = snippet.publishedAt || null;
    let endTime = null;

    if (live && live.scheduledStartTime && !live.actualStartTime) {
        eventType = 'live';
        eventStatus = 'scheduled';
        startTime = live.scheduledStartTime;
    } else if (live && live.actualStartTime && !live.actualEndTime) {
        eventType = 'live';
        eventStatus = 'live';
        startTime = live.actualStartTime;
    } else if (live && live.actualStartTime && live.actualEndTime) {
        eventType = 'live';
        eventStatus = 'ended';
        startTime = live.actualStartTime;
        endTime = live.actualEndTime;
    } else if (status.uploadStatus && status.uploadStatus !== 'rejected') {
        eventType = 'video';
        eventStatus = 'ended';
        startTime = snippet.publishedAt || startTime;
    }

    if (!startTime) return null;

    return {
        title,
        start_time: startTime,
        end_time: endTime,
        url: `https://www.youtube.com/watch?v=${item.id}`,
        thumbnail_url: thumbnail,
        platform: 'youtube',
        event_type: eventType,
        description,
        status: eventStatus,
        external_id: item.id
    };
}

/** 内部通知サーバ（NOTIFY_CONFIG.apiUrl）へ送る汎用関数 */
async function sendNotifyApi(payload) {
    try {
        const bodyString = JSON.stringify(payload);
        const sig = require('../core/notify-sign').signNotifyPayload(NOTIFY_CONFIG.hmacSecret || null, bodyString);
        await axios.post(NOTIFY_CONFIG.apiUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Notify-Token': NOTIFY_CONFIG.token || '',
                ...(sig ? { 'X-Notify-Hmac': sig.hmac, 'X-Notify-Timestamp': sig.timestamp } : {})
            },
            timeout: 8000
        });
        return true;
    } catch (e) {
        console.error('sendNotifyApi failed:', e.message || e);
        return false;
    }
}

// ========= 検知経路の監視（2026-10-21 追加） =========
// 2026-10-20 に「PubSubHubbub の webhook が 18 日間死んでいた」ことを知った。
// 壊れていることに誰も気づけなかったのは、**検知経路が壊れていることを示す仕組みが無い**ため。
// そこで RSS フォールバックスキャンと購読の状態を内部 API（scraper-status）へ報告し、
// 検知経路が両方失敗した状態が続いたら Discord へアラートを飛ばす。
const DETECTION_STATUS_ID = 'youtube_detection';
const WEBHOOK_STATUS_ID = 'youtube_webhook';
// 検知経路が両方失敗した状態が続いたらアラート（5分間隔 × 3 = 15分）
const DETECTION_ALERT_AFTER_SCANS = 3;
let _detectionFailStreak = 0;

/** 検知経路の状態を内部 API（scraper-status）へ報告する（失敗しても検知処理は止めない） */
let _statusReportWarnAt = 0;
async function reportScraperStatus(id, name, status, message) {
    try {
        if (!NOTIFY_CONFIG.token) {
            warnStatusReportOnce('token-missing', 'NOTIFY_API_TOKEN 未設定のため状態を報告できません');
            return;
        }
        // 通知APIのURLから origin を取り出す（パス付きでも壊れないように正規表現ではなく URL で解く）
        const base = new URL(NOTIFY_CONFIG.apiUrl).origin;
        await axios.post(`${base}/api/internal/scraper-status`,
            { id, name, status, message: message || null },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notify-Token': NOTIFY_CONFIG.token
                },
                timeout: 3000
            });
    } catch (e) {
        // 状態報告の失敗は検知自体には影響させない（ここで例外は投げない）。
        // ただし「黙って失敗する」と「仕組みが動いていない」ことが分からないので
        // 10分に1回だけ警告を残す。
        warnStatusReportOnce('request-failed', `状態報告に失敗しました: ${e.message || e}`);
    }
}

/** 状態報告の失敗を10分に1回だけ警告する（黙って失敗するのを防ぐ） */
function warnStatusReportOnce(key, message) {
    const now = Date.now();
    if (now - _statusReportWarnAt < 10 * 60 * 1000) return;
    _statusReportWarnAt = now;
    console.warn(`[YouTube Status] ${message}`);
}

/** 指定の内部エンドポイントに URL を送りつける（新規動画用）。
 *  extraPayload で { source: 'collab', title } 等を付加できる（nassy側は未知キーを無視するため後方互換）。 */
async function sendInternalUrl(urlToSend, extraPayload = {}) {
    if (DISABLE_INTERNAL_NOTIFY) {
        console.log(`sendInternalUrl suppressed (DISABLE_NOTIFICATIONS): ${urlToSend}`);
        return true;
    }
    try {
        await axios.post('http://192.168.1.70:1700/', { url: urlToSend, ...extraPayload }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 8000
        });
        return true;
    } catch (e) {
        console.error('sendInternalUrl failed:', e.message || e);
        return false;
    }
}

// ========= コラボ相手チャンネルの配信終了ポーリング =========
// YouTube URL を持つコラボ予定イベントを監視し、
// 相手チャンネルの配信が終了したら nassy へ DL 通知を送る（本人チャンネルは既存フローで処理済み）。
// ※ 引用ツイート由来の予定は platform='twitter'、external_id は 'gemma_<tweetId>' か
//    空文字（既存イベントの更新時）になる。platform / external_id で絞ると常に0件になるため、
//    絞り込みは「YouTube URL の有無」と本人ch除外（下の channelId チェック）で行う。
const COLLAB_POLL_WINDOW_DAYS = 3;

let _collabDb = null;
function getCollabDb() {
    if (!_collabDb) {
        const dbPath = path.join(__dirname, '..', '..', process.env.DB_FILE_NAME || 'data.db');
        _collabDb = new sqlite3.Database(dbPath);
    // 書き込みロック競合を待つ（AGENTS.md §11）
    _collabDb.configure("busyTimeout", 5000);
    // コールバックなしの文のエラーでプロセスを落とさない
    _collabDb.on("error", (err) => console.error("[db:collab] error:", err.message));
    }
    return _collabDb;
}
function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        getCollabDb().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

/** YouTube URL から video_id を抽出（nassy download.py と同じ正則） */
function extractYouTubeVideoId(u) {
    try {
        const parsed = new URL(u);
        const v = parsed.searchParams.get('v');
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    } catch { /* fallthrough */ }
    const m = String(u || '').match(/(?:v=|\/watch\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

async function pollForEndedCollabs() {
    let rows;
    try {
        rows = await dbAllAsync(
            `SELECT id, title, url, start_time FROM events
             WHERE url IS NOT NULL AND url != ''
               AND start_time >= datetime('now', ?)
               AND status != 'cancelled'`,
            [`-${COLLAB_POLL_WINDOW_DAYS} day`]
        );
    } catch (e) {
        console.error('[CollabPoll] events query error:', e.message || e);
        return;
    }
    if (!rows || rows.length === 0) return;

    const records = loadSentRecords();
    let changed = false;
    for (const ev of rows) {
        const videoId = extractYouTubeVideoId(ev.url);
        if (!videoId) continue;
        const rec = records[videoId] || {};
        if (rec.collabSent) continue;

        const item = await fetchVideoStatus(videoId);
        if (!item) continue; // 削除・非公開。イベントは3日で窓から抜けるため無限ポーリングにはならない
        const channelId = item.snippet && item.snippet.channelId;
        if (channelId && CHANNEL_IDS.includes(channelId)) continue; // 本人チャンネル → 既存フローが担当
        const live = item.liveStreamingDetails;
        if (live && live.scheduledStartTime && !live.actualStartTime) continue; // 未開始（待機枠）
        if (live && live.actualStartTime && !live.actualEndTime) continue; // 配信中

        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const title = (item.snippet && item.snippet.title) || ev.title || 'コラボ動画';
        console.log(`[CollabPoll] Ended collab detected: ${videoId} (${title})`);

        const ok = await sendInternalUrl(url, { source: 'collab', title, event_id: ev.id });
        if (ok) {
            records[videoId] = {
                ...rec,
                collabSent: true,
                collabAt: new Date().toISOString(),
                collabEventId: ev.id
            };
            changed = true;
            console.log(`[CollabPoll] POST sent for ${videoId}`);
            await new Promise(r => setTimeout(r, POLL_SEND_GAP_MS));
        } else {
            console.error(`[CollabPoll] Failed to POST for ${videoId}`);
        }
    }
    if (changed) saveSentRecords(records);
}

function init(config) {
    NOTIFY_CONFIG = { ...NOTIFY_CONFIG, ...config };
    console.log('[YouTube] Notification config loaded.');
}

/** Subscribe helper (既存) */
async function subscribeToChannel(channelId) {
    const topicUrl = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
    const data = querystring.stringify({
        'hub.mode': 'subscribe',
        'hub.topic': topicUrl,
        'hub.callback': CALLBACK_URL,
        'hub.verify': 'sync',
        'hub.lease_seconds': 432000
    });
    try {
        const response = await axios.post(PUBSUBHUBBUB_HUB, data, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000
        });
        if (response.status === 204 || response.status === 202) {
            console.log(`[YouTube Sub] ✅ 購読リクエスト成功: ${channelId}.`);
            return true;
        }
        console.error(`[YouTube Sub] ❌ 購読リクエスト失敗 (${channelId}). Status: ${response.status}`);
        return false;
    } catch (error) {
        console.error(`[YouTube Sub] エラー (${channelId}):`, error.message || error);
        if (error.response) console.error('  Response Body:', error.response.data);
        return false;
    }
}

// 購読の成否状態（再購読の判断に使う）
let _lastSubscribeOkAt = 0;      // 最後に購読成功した時刻
let _lastSubscribeTryAt = 0;     // 最後に購読を試した時刻

async function subscribeAllChannels() {
    if (!WEBHOOK_TOKEN) {
        // トークン未設定では callback が 403 になり、購読しても无效になる。
        // （staging などトークンを設定しない環境で「成功しない購読」を作らない）
        console.error('[YouTube Sub] YOUTUBE_WEBHOOK_TOKEN 未設定のため購読しません（callback は 403 になります）');
        return 0;
    }
    console.log(`[YouTube Sub] 全チャンネルの購読リクエスト/更新を開始（callback: ${CALLBACK_URL_LOG}）`);
    const results = await Promise.allSettled(CHANNEL_IDS.map(c => subscribeToChannel(c)));
    const okCount = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
    console.log(`[YouTube Sub] 完了（成功 ${okCount}/${CHANNEL_IDS.length}）`);
    _lastSubscribeTryAt = Date.now();
    if (okCount > 0) _lastSubscribeOkAt = Date.now();
    if (okCount === 0) {
        // 以前はこの失敗がログに埋もれて 18 日 unnoticed だった。
        // 明示的に警告し、検知が RSS/プレイリスト経路に依存している点を tudorえる。
        console.error(
            '[YouTube Sub] ⚠️ 全チャンネルの購読に失敗。' +
            ' hub 側の callback 検証が通っていない可能性があります' +
            '（callback URL がインターネットから到達可能か / トークン不一致 / hub 障害）。' +
            ' この間 YouTube の検知は RSS・プレイリスト経路に依存します。'
        );
    }
    // 購読状態も報告する（webhook が死んでいることが管理画面と Discord で分かるように）
    await reportScraperStatus(
        WEBHOOK_STATUS_ID,
        'YouTube Webhook 購読',
        okCount === CHANNEL_IDS.length ? 'success' : 'error',
        `購読 ${okCount}/${CHANNEL_IDS.length}`
    );
    // 全滅した場合は Discord へアラート（報告だけだと Discord には残らないため）。
    // 2026-10-20 に 18 日間 unnoticed だったのと同じ状態を再発させない。
    if (okCount === 0) {
        await sendDiscordAlert(
            '🚨 YouTube Webhook の購読ができません',
            `PubSubHubbub への購読リクエストが全滅しました。\n` +
            `この間、配信開始・配信予定の検知は RSS・プレイリスト経路に依存します。\n\n` +
            `**詳細:**\n\`\`\`\ncallback の検証が通っていない可能性があります\n` +
            `（callback URL がインターネットから到達可能か / トークン不一致 / hub 障害）\n\`\`\``,
            'ERROR',
            'youtube_webhook_subscribe_failed'
        );
    }
    return okCount;
}

// 購読の更新周期:
//   - 通常: 12時間（hub のリース5日に対し十分短い。hub への負荷も 1日4回と少ない）
//   - 前回失敗した場合: 30分後に再試行（自己修復を速くする）
// 以前は 3日周期で、hub の一時障害や callback 到達不能が最長3日そのまま続き、
// 検知が RSS/プレイリスト経路だけに依存する期間が長くなっていた（2026-10-20 実測）。
const RESUBSCRIBE_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12時間（通常）
const RESUBSCRIBE_RETRY_MS = 30 * 60 * 1000;         // 30分（前回の購読が失敗した場合）
const RESUBSCRIBE_TICK_MS = 5 * 60 * 1000;            // 判断周期（5分ごとに条件判定）


function startAutomaticResubscribe() {
    setInterval(async () => {
        const now = Date.now();
        const sinceOk = now - _lastSubscribeOkAt;
        const sinceTry = now - _lastSubscribeTryAt;
        // 成功から12時間未満なら何もしない。失敗していれば30分後に再試行
        const needRetry = (_lastSubscribeOkAt === 0 || sinceOk >= RESUBSCRIBE_INTERVAL_MS);
        if (!needRetry) return;
        if (_lastSubscribeTryAt && sinceTry < RESUBSCRIBE_RETRY_MS) return;
        try {
            await subscribeAllChannels();   // 状態変数は subscribeAllChannels 側で更新する
        } catch (e) {
            _lastSubscribeTryAt = Date.now();
            console.error('[YouTube Sub] 定期再購読エラー:', e.message || e);
        }
    }, RESUBSCRIBE_TICK_MS);
    console.log(`[YouTube Sub] 定期再購読を開始（通常 ${RESUBSCRIBE_INTERVAL_MS / 60000}分ごと / 失敗時は ${RESUBSCRIBE_RETRY_MS / 60000}分後に再試行）`);
}

/** Webhook server start */
/**
 * Webhook の Express アプリを作る（テストからも使えるよう分離している）。
 * @param {Object} opts
 * @param {string} [opts.rawLogPath] 受信 XML の生ログ先（既定 logs/youtube-webhook-raw.log）
 * @param {string} [opts.token]       共有シークレット（既定 process.env.YOUTUBE_WEBHOOK_TOKEN）
 */
function createWebhookApp(opts = {}) {
    const app = express();
    // 公開ルートなのでフレームワークの指紋は出さない
    app.disable('x-powered-by');

    const token = opts.token !== undefined ? opts.token : WEBHOOK_TOKEN;
    const rawFile = opts.rawLogPath || path.join(__dirname, '..', '..', 'logs', 'youtube-webhook-raw.log');
    const rawLogDir = path.dirname(rawFile);
    if (!fs.existsSync(rawLogDir)) fs.mkdirSync(rawLogDir, { recursive: true });

    // 拒否ログはサンプリングする（公開ルートに晒したため、1リクエスト1行は避ける）
    let rejectCount = 0;
    const logWebhookReject = (reason) => {
        rejectCount++;
        if (rejectCount === 1 || rejectCount % 100 === 0) {
            console.warn(`[YouTube Webhook] 拒否 (${reason}) 累計 ${rejectCount} 件`);
        }
    };

    // 共有シークレット検証（callback は公開 URL にして；第三者に通知を撃たせない）
    // 比較は timingSafeEqual（AGENTS.md §3/§11: 自前の === 比較は禁止）
    // hub は callback URL のクエリを引き継ぐがヘッダは付けられないため、クエリのみ受理する
    const checkWebhookToken = (req, res, next) => {
        if (!token) {
            logWebhookReject('token-unset');
            return res.sendStatus(403);
        }
        const provided = typeof req.query?.token === 'string' ? req.query.token : '';
        const a = Buffer.from(provided);
        const b = Buffer.from(token);
        const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!ok) {
            logWebhookReject('token-mismatch');
            return res.sendStatus(403);
        }
        next();
    };

    // POST handler
    app.post('/youtube-webhook', checkWebhookToken, bodyParser.text({ type: '*/*' }), async (req, res) => {
        const xml = req.body;
        const nowIso = new Date().toISOString();
        fs.appendFile(rawFile, `\n--- ${nowIso} ---\n${xml}\n`, (err) => {
            if (err) console.error('Failed to write raw webhook:', err);
        });

        if (!xml || typeof xml !== 'string' || xml.trim().length === 0) {
            console.error('Received empty or invalid XML body. 400.');
            return res.sendStatus(400);
        }

        let parsed;
        try {
            parsed = await parseStringPromise(xml);
        } catch (err) {
            console.error('XML parse error:', err);
            return res.sendStatus(400);
        }

        const entries = (parsed && parsed.feed && parsed.feed.entry)
            ? (Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry])
            : [];

        if (entries.length === 0) {
            console.log('No entries in feed (possible deletion). 200 OK.');
            return res.sendStatus(200);
        }

        const records = loadSentRecords();

        // 1リクエストで処理する entry は上限を設ける（不正な POST での大量処理を防ぐ）
        for (const entry of entries.slice(0, WEBHOOK_MAX_ENTRIES)) {
            const videoId = entry['yt:videoId'] && entry['yt:videoId'][0];
            let title = entry.title && entry.title[0];
            const publishedStr = entry.published && entry.published[0];

            // 動画IDは YouTube の形式（11文字の [A-Za-z0-9_-]）のみ受理する
            if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(String(videoId))) {
                console.warn('Entry missing or invalid videoId, skip.');
                continue;
            }

            const publishedDate = publishedStr ? new Date(publishedStr) : null;
            // `new Date("不正な文字列")` は truthy な Invalid Date になる。
            // そのまま比較すると diffMs が NaN になり「24時間以内」フィルタを素通りする。
            if (!publishedDate || Number.isNaN(publishedDate.getTime())) {
                console.warn(`No published date for video ${videoId}, skip.`);
                continue;
            }

            const nowUtc = new Date();
            const diffMs = nowUtc.getTime() - publishedDate.getTime();

            if (diffMs > RECENT_VIDEO_THRESHOLD_MS) {
                console.log(`Skip ${videoId}: published older than threshold.`);
                continue;
            }

            // データ取得
            const item = await fetchVideoStatus(videoId);
            if (!item) {
                console.warn(`No data from YouTube Data API for ${videoId}, skip.`);
                continue;
            }

            const live = item.liveStreamingDetails || null;
            const status = item.status || {};
            const url = `https://www.youtube.com/watch?v=${videoId}`;
            title = title || 'YouTube動画';
            const thumbnail =
                item.snippet?.thumbnails?.maxres?.url ||
                item.snippet?.thumbnails?.high?.url ||
                item.snippet?.thumbnails?.medium?.url ||
                (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);

            // 判定フラグ
            // 既存の isUpcoming は使用しません
            // const isUpcoming = live && live.scheduledStartTime && !live.actualStartTime;
            const isLive = live && live.actualStartTime && !live.actualEndTime;
            const isArchivedFromLive = live && live.actualEndTime; // ライブ終了してアーカイブ化済み or 処理中
            const isNonLiveVideo = !live && (status.uploadStatus === 'processed' || status.uploadStatus === 'uploaded' || status.uploadStatus === 'completed');

            const rec = records[videoId] || {};
            const recIsEmpty = Object.keys(rec).length === 0;

            // Publishedから5分以内かどうかの判定 (新しいロジックで使用)
            const isVeryRecent = diffMs <= PLANNED_ASSUMPTION_THRESHOLD_MS;

            // 1) 予定 (Upcoming) -> タイトルに【予定】付与して notify。一度だけ送る（plannedSent）
            // 判定ロジックを緩和: ライブ情報があり、かつPublishedから5分以内で、ライブ中でなければ【予定】として扱う
            if (live && isVeryRecent && !isLive) {
                if (!rec.plannedSent) {
                    const payload = {
                        type: 'youtube',
                        settingKey: 'youtube',
                        data: {
                            title: `【予定】`,
                            body: `${title}`,
                            url,
                            icon: ICON_URL,
                            image: thumbnail,
                            published: publishedStr || null
                        }
                    };
                    const ok = await sendNotifyApi(payload);
                    if (ok) {
                        const ev = buildEventFromVideoItem(item, title);
                        if (ev) {
                            try { await upsertEvent(ev); } catch (e) { console.error('upsertEvent(planned) failed:', e.message || e); }
                        }
                        records[videoId] = { ...rec, plannedSent: true, plannedAt: new Date().toISOString(), plannedStart: (live && live.scheduledStartTime) || null };
                        console.log(`Planned notify (using 5min-threshold) sent for ${videoId}`);
                    } else {
                        console.error(`Failed to send planned notify for ${videoId}`);
                    }
                    saveSentRecords(records);
                } else {
                    console.log(`Planned notify already sent for ${videoId}, ignored.`);
                }
                continue;
            }

            // 2) ライブ中 (Live) -> 【ライブ】付けて通知。基本的に一度だけ（liveSent）
            if (isLive) {
                if (!rec.liveSent) {
                    const payload = {
                        type: 'youtube',
                        settingKey: 'youtube',
                        data: {
                            title: `【ライブ】`,
                            body: `${title}`,
                            url,
                            icon: ICON_URL,
                            image: thumbnail,
                            published: publishedStr || null
                        }
                    };
                    const ok = await sendNotifyApi(payload);
                    if (ok) {
                        const ev = buildEventFromVideoItem(item, title);
                        if (ev) {
                            try { await upsertEvent(ev); } catch (e) { console.error('upsertEvent(live) failed:', e.message || e); }
                        }
                        records[videoId] = { ...rec, liveSent: true, liveAt: new Date().toISOString() };
                        console.log(`Live notify sent for ${videoId}`);
                    } else {
                        console.error(`Failed to send live notify for ${videoId}`);
                    }
                    saveSentRecords(records);
                } else {
                    console.log(`Live notify already sent for ${videoId}, ignored.`);
                }
                continue;
            }

            // 4) 新規で動画になった場合の処理
            // - ライブ終了アーカイブ (isArchivedFromLive): 通知は送らず内部URLへPOSTのみ送信（重複防止）
            // - 非ライブの新規動画 (isNonLiveVideo): ログにない（recIsEmpty）の場合は内部URLへPOST + 通知を送る
            if (isArchivedFromLive) {
                if (!rec.newVideoSent) {
                    const ok = await sendInternalUrl(url);
                    if (ok) {
                        records[videoId] = { ...rec, newVideoSent: true, newVideoAt: new Date().toISOString(), archivedFromLive: true };
                        console.log(`Archived-from-live POST sent for ${videoId}`);
                    } else {
                        console.error(`Failed to POST archived-from-live for ${videoId}`);
                    }
                    saveSentRecords(records);
                } else {
                    console.log(`Archived-from-live already POSTed for ${videoId}, ignored.`);
                }
                continue;
            }

            if (isNonLiveVideo) {
                // 非ライブの通常動画は「ログにないもの」は通知 + 内部POST
                if (!rec.newVideoSent) {
                    // If rec is empty => new/newly detected (ログにない)
                    if (recIsEmpty) {
                        // 1) send notify
                        const notifyPayload = {
                            type: 'youtube',
                            settingKey: 'youtube',
                            data: {
                                title: `【動画】`,
                                body: `${title}`,
                                url,
                                icon: ICON_URL,
                                image: thumbnail,
                                published: publishedStr || null
                            }
                        };
                        const notified = await sendNotifyApi(notifyPayload);
                        if (notified) {
                            const ev = buildEventFromVideoItem(item, title);
                            if (ev) {
                                try { await upsertEvent(ev); } catch (e) { console.error('upsertEvent(video) failed:', e.message || e); }
                            }
                            records[videoId] = { ...rec, notifiedAt: new Date().toISOString() };
                            console.log(`Notify sent for new non-live video ${videoId}`);
                        } else {
                            console.error(`Failed to send notify for new non-live video ${videoId}`);
                        }
                    }

                    // 2) always send internal URL POST once (for new video)
                    const ok = await sendInternalUrl(url);
                    if (ok) {
                        records[videoId] = { ...records[videoId], newVideoSent: true, newVideoAt: new Date().toISOString(), nonLive: true };
                        console.log(`New non-live video POST sent for ${videoId}`);
                    } else {
                        console.error(`Failed to POST new non-live video for ${videoId}`);
                    }
                    saveSentRecords(records);
                } else {
                    console.log(`New-video already processed for ${videoId}, ignored.`);
                }
                continue;
            }

            // それ以外のケース（processing中など）はログに残してスキップ
            console.log(`No action for ${videoId}. status.uploadStatus=${status.uploadStatus}, live present=${!!live}`);
        }

        // 常に200で応答
        res.sendStatus(200);
    });

    // GET verification
    app.get('/youtube-webhook', checkWebhookToken, (req, res) => {
        // 購読解除通知（hub.mode=denied）にも 2xx で返す（PubSubHubbub 仕様）
        if (req.query['hub.mode'] === 'denied') {
            console.log('[YouTube Webhook] hub.mode=denied（購読解除通知）');
            return res.sendStatus(200);
        }
        const hubChallenge = req.query['hub.challenge'];
        if (hubChallenge) return res.send(hubChallenge);
        res.sendStatus(400);
    });

    return app;
}

/** Webhook サーバを起動する（createWebhookApp のラッパ） */
function startWebhook(port = 3001) {
    console.log('Starting YouTube Webhook server...');
    const app = createWebhookApp();
    return new Promise((resolve) => {
        app.listen(port, () => {
            console.log(`Webhook listening on port ${port}`);
            resolve();
        });
    });
}

if (require.main === module) {
    startWebhook(3001).catch(err => console.error('Failed to start webhook:', err));
}



// ========= ライブ終了ポーリング =========
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10分おき
// nassy 側は受信1件ごとにスレッドを立てて YouTube API を叩く。バックログを
// 一斉に流すと同時API呼び出しが重なり、相手プロセスが SEGV で落ちた実例がある。
// 送信間隔を空けて背負わせる（通常の候補は1件なので体感差は無い）。
const POLL_SEND_GAP_MS = 4 * 1000;
// 以前は「直近24時間のライブ」だけを対象にしていたが、worker 停止中に
// 配信終了を逃した動画が永久にポーリング対象外になる欠陥があった
// （実際8件が滞留した）。取得できない動画（削除・非公開）は YouTube API の
// 応答に現れないため、そこで候補から外すことで無限ポーリングを防ぐ。

async function pollForEndedLives() {
    const records = loadSentRecords();

    // liveSent があり newVideoSent がない videoId を抽出（期間制限なし）
    const candidates = [];
    for (const [videoId, rec] of Object.entries(records)) {
        if (rec.liveSent && !rec.newVideoSent && rec.liveAt) {
            candidates.push(videoId);
        }
    }

    if (candidates.length === 0) return;

    // バッチ処理（最大50件ずつ）
    for (let i = 0; i < candidates.length; i += 50) {
        const batch = candidates.slice(i, i + 50);
        try {
            const resp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
                params: {
                    id: batch.join(','),
                    part: 'liveStreamingDetails,snippet',
                    key: API_KEY
                },
                timeout: 10000
            });

            const items = resp.data?.items || [];
            for (const item of items) {
                const videoId = item.id;
                const live = item.liveStreamingDetails;
                if (!live || !live.actualEndTime) continue;

                // ライブ終了済み → ダウンロード通知を送信
                const rec = records[videoId] || {};
                if (rec.newVideoSent) continue;

                const url = `https://www.youtube.com/watch?v=${videoId}`;
                const title = item.snippet?.title || 'YouTube動画';
                console.log(`[POLL] Detected ended live: ${videoId} (${title})`);

                const ok = await sendInternalUrl(url);
                if (ok) {
                    records[videoId] = {
                        ...rec,
                        newVideoSent: true,
                        newVideoAt: new Date().toISOString(),
                        archivedFromLive: true,
                        polledAt: new Date().toISOString()
                    };
                    console.log(`[POLL] POST sent for ${videoId}`);
                    await new Promise(r => setTimeout(r, POLL_SEND_GAP_MS));
                } else {
                    console.error(`[POLL] Failed to POST for ${videoId}`);
                }
            }

            // 削除・非公開などで API 応答に現れなかった videoId は、
            // どのポーリングでも候補から外れないのでここで記録して対象外にする
            const returned = new Set(items.map(it => it.id));
            for (const videoId of batch) {
                if (returned.has(videoId)) continue;
                const rec = records[videoId];
                if (!rec || rec.newVideoSent) continue;
                console.log(`[POLL] ${videoId} unavailable on API (deleted/private), dropping from poll`);
                records[videoId] = {
                    ...rec,
                    newVideoSent: true,
                    newVideoAt: new Date().toISOString(),
                    unavailable: true,
                    polledAt: new Date().toISOString()
                };
            }
            saveSentRecords(records);
        } catch (e) {
            console.error(`[POLL] API error:`, e.message || e);
        }
    }
}

// ========= RSSポーリング（PubSubHubbub障害時の検知冗長化） =========
// Webhook配信が遅延・停止した場合でも、配信枠（予定）と配信開始（ライブ）を通知するためのフォールバック。
// RSSフィードは無料（クォータ消費なし）、videos API はバッチ化して1フェッチ=1unitに抑える。
//
// 2026-10-20 改修: YouTube 側の RSS エンドポイントが**一時的に 404 を返す**ことが
// 観測された（同一 URL が直後に 200 になる= YouTube 側の不稳定。IP ブロックではない）。
// そのままではその窓の間、PubSubHubbub webhook も止まっていた場合に配信開始を取りこぼす。
// そこで (1) 取得のリトライ、(2) 失敗時の Data API アップロードプレイリストへの切替、
// (3) エラーログの連発抑制 を入れた。
const RSS_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const RSS_MAX_ITEMS = 15;
const RSS_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5分おき
// 予定枠の通知は「publishedから90分以内」に限る（再起動直後のバックフィルで過去分を通知しないため）
const RSS_PLANNED_FRESH_MS = 90 * 60 * 1000;
// ライブ開始チェックは予定時刻の15分前から開始する
const RSS_LIVE_CHECK_AHEAD_MS = 15 * 60 * 1000;
// RSS 取得のリトライ回数（1回目失敗後に 2回まで再試行）
const RSS_FETCH_ATTEMPTS = 3;
const RSS_RETRY_DELAY_MS = 2000;
// 同じチャンネルの RSS エラーログはこの間隔以上で1回だけ（連発抑制）
const RSS_ERROR_LOG_INTERVAL_MS = 10 * 60 * 1000;
const _rssErrorLogAt = new Map();      // key -> 最後にログした時刻
const _rssErrorSuppressed = new Map(); // key -> 抑制した件数

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** RSS 取得エラーのログ（同一キーは10分に1回＋抑制件数を併記） */
function logRssError(key, err) {
    const now = Date.now();
    const last = _rssErrorLogAt.get(key) || 0;
    if (now - last < RSS_ERROR_LOG_INTERVAL_MS) {
        _rssErrorSuppressed.set(key, (_rssErrorSuppressed.get(key) || 0) + 1);
        return;
    }
    const suppressed = _rssErrorSuppressed.get(key) || 0;
    _rssErrorSuppressed.set(key, 0);
    _rssErrorLogAt.set(key, now);
    const suffix = suppressed > 0 ? `（前回ログ以降に${suppressed}件抑制）` : '';
    console.error(`[YouTube RSS] Error for ${key}（${RSS_FETCH_ATTEMPTS}回試行後）: ${err.message || err}${suffix}`);
}

/**
 * RSS フィードから直近の videoId を取得する。
 * 成功時: 配列（空でも成功）／失敗時: null（「空フィード」と区別するため）
 */
async function fetchRssVideoIds(channelId) {
    for (let attempt = 1; attempt <= RSS_FETCH_ATTEMPTS; attempt++) {
        try {
            const resp = await axios.get(`${RSS_URL}${channelId}`, { timeout: 10000 });
            return await parseRssEntries(resp.data, RSS_MAX_ITEMS);
        } catch (err) {
            if (attempt < RSS_FETCH_ATTEMPTS) {
                await sleep(RSS_RETRY_DELAY_MS * attempt);
                continue;
            }
            logRssError(channelId, err);
            return null;
        }
    }
    return null;
}

/**
 * RSS の代替ソース: Data API のアップロードプレイリスト（プレイリストID = "UU" + channelId）。
 * 1 コール = 1 unit。RSS が失敗したスキャンだけが呼ぶので通常はクォータを消費しない。
 * 動画IDと公開日時が取れるので、RSS と同じ「新着検知 → videos API で状態確認」の流れになる。
 * @returns {Promise<{videoId:string,published:string|null,title:string|null}[]|null>}
 *   取得成功（0件のときは空配列）／失敗ときは null（RSS 側と同じ表現）
 */
async function fetchPlaylistVideoIds(channelId) {
    if (!API_KEY) {
        console.warn('[YouTube RSS] YOUTUBE_API_KEY が未設定のためプレイリスト代替は使えません');
        return null;
    }
    try {
        const resp = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
            params: {
                playlistId: deriveUploadsPlaylistId(channelId),
                maxResults: RSS_MAX_ITEMS,
                part: 'contentDetails,snippet',
                key: API_KEY
            },
            timeout: 10000
        });
        return parsePlaylistItems(resp.data, RSS_MAX_ITEMS);
    } catch (e) {
        logRssError(`${channelId}(playlist)`, e);
        return null;   // 取得失敗（空フィードと区別する。RSS 側と同じ表現にする）
    }
}

/** videos API をバッチ化して一括取得（最大50件/コール） */
async function fetchVideoStatusesBatch(ids) {
    if (!API_KEY) return new Map();
    if (!ids.length) return new Map();
    const result = new Map();
    for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        try {
            const resp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
                params: {
                    id: batch.join(','),
                    part: 'snippet,liveStreamingDetails,status',
                    key: API_KEY
                },
                timeout: 10000
            });
            for (const item of (resp.data?.items || [])) {
                result.set(item.id, item);
            }
        } catch (e) {
            console.error('[YouTube RSS] videos API batch error:', e.message || e);
        }
    }
    return result;
}

/** 予定通知（webhook と同じペイロード構造） */
async function notifyPlannedFromRss(item, publishedStr, title) {
    const videoId = item.id;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const thumbnail =
        item.snippet?.thumbnails?.maxres?.url ||
        item.snippet?.thumbnails?.high?.url ||
        item.snippet?.thumbnails?.medium?.url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    const payload = {
        type: 'youtube',
        settingKey: 'youtube',
        data: {
            title: `【予定】`,
            body: `${title}`,
            url,
            icon: ICON_URL,
            image: thumbnail,
            published: publishedStr || null,
            // 配信開始の予定時刻（ISO）。Android アプリが端末内アラームを
            // 予約するために使う（無ければアラームは予約されない）。
            // ※ YouTube Data API のライブ情報は `liveStreamingDetails`（`live` ではない）
            start_time: item.liveStreamingDetails?.scheduledStartTime || null
        }
    };
    const ok = await sendNotifyApi(payload);
    if (ok) {
        const ev = buildEventFromVideoItem(item, title);
        if (ev) {
            try { await upsertEvent(ev); } catch (e) { console.error('upsertEvent(planned/RSS) failed:', e.message || e); }
        }
        return true;
    }
    return false;
}

/** ライブ開始通知（webhook と同じペイロード構造） */
async function notifyLiveFromRss(item, title) {
    const videoId = item.id;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const thumbnail =
        item.snippet?.thumbnails?.maxres?.url ||
        item.snippet?.thumbnails?.high?.url ||
        item.snippet?.thumbnails?.medium?.url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    const payload = {
        type: 'youtube',
        settingKey: 'youtube',
        data: {
            title: `【ライブ】`,
            body: `${title}`,
            url,
            icon: ICON_URL,
            image: thumbnail,
            published: null,
            // ★ 配信開始の通知は「アラーム用チャネル」で配信する。
            //   事前告知が無い突然の開始でも、端末の中でアラームと同じ音で起きれるようにする
            //   （通常の mai_default チャネルでは「音は鳴るが画面は起こらない」）。
            //   チャネルが無い環境（未設定・古い APK）は FCM SDK が既定チャネルへフォールバックする。
            channel: 'mai_stream_alarm'
        }
    };
    const ok = await sendNotifyApi(payload);
    if (ok) {
        const ev = buildEventFromVideoItem(item, title);
        if (ev) {
            try { await upsertEvent(ev); } catch (e) { console.error('upsertEvent(live/RSS) failed:', e.message || e); }
        }
        return true;
    }
    return false;
}

/** ライブ開始チェック対象かどうか（予定枠の配信開始検知） */
function plannedDueForLiveCheck(rec, now) {
    if (rec.plannedStart) {
        const s = Date.parse(rec.plannedStart);
        if (!isNaN(s)) return now >= s - RSS_LIVE_CHECK_AHEAD_MS;
    }
    // 旧record（plannedStartなし）は plannedAt から24h以内を対象にする
    const p = rec.plannedAt ? Date.parse(rec.plannedAt) : NaN;
    return !isNaN(p) && (now - p) < 24 * 60 * 60 * 1000;
}

// スキャンの重複実行を防ぐ（前回のスキャン中最中はスキップ）。
// 重複すると sent_records.json の read-modify-write が競合し、
// 同じ動画を二重通知する可能性がある。
let _rssScanInFlight = false;

/**
 * 検知経路の状態を報告する。
 * - 検知経路（RSS / プレイリスト代替）が両方失敗したチャンネルがある場合: error
 * - どちらか一方でも取得できた: success（RSS だけが失敗なら代替を使ったことを明記）
 * 失敗が続いたら Discord へアラート（スパム防止のキーは sendDiscordAlert 側で制限）
 */
async function reportDetectionState(failedChannels, usedPlaylistFallback, rssFailedChannels = 0) {
    const allFailed = failedChannels >= CHANNEL_IDS.length;
    if (allFailed) _detectionFailStreak++;
    else _detectionFailStreak = 0;

    // 判定ロジックは純粋関数に寄せている（回帰テストから検証できるように）
    const decision = decideDetectionState({
        failedChannels,
        totalChannels: CHANNEL_IDS.length,
        rssFailedChannels,
        usedFallback: usedPlaylistFallback,
        failStreak: _detectionFailStreak,
        alertAfter: DETECTION_ALERT_AFTER_SCANS
    });

    // 状態報告は**待たない**（検知の待ち時間を増やさないため）
    reportScraperStatus(DETECTION_STATUS_ID, 'YouTube 配信検知', decision.status, decision.message);

    if (decision.alert) {
        await sendDiscordAlert(
            '🚨 YouTube の配信検知ができません',
            `**RSS フィード** と **Data API プレイリスト** の両方が失敗しています。\n` +
            `この間、配信開始・配信予定の通知が届きません。\n\n` +
            `**詳細:**\n\`\`\`\n${decision.message}\n\`\`\`\n\n` +
            `（RSS フィード と Data API プレイリストの**両方**に到達できない状態です。` +
            `外部 connectivity を確認してください）`,
            'ERROR',
            'youtube_detection_broken'
        );
    }
}

async function runRssFallbackScan() {
    if (_rssScanInFlight) {
        console.warn('[YouTube RSS] scan skipped (previous scan still running)');
        return;
    }
    _rssScanInFlight = true;
    try {
        const records = loadSentRecords();
        const now = Date.now();

        // 1) 直近のvideoIdを収集（RSS が失敗したら Data API のプレイリストで代替）
        const seen = new Map();
        let usedPlaylistFallback = false;
        let failedChannels = 0;
        let rssFailedChannels = 0;
        for (const channelId of CHANNEL_IDS) {
            let entries = await fetchRssVideoIds(channelId);
            if (entries === null) {
                // RSS 取得失敗（YouTube 側の一時的な 404 等）→ アップロードプレイリストへ切替
                rssFailedChannels++;
                entries = await fetchPlaylistVideoIds(channelId);
                if (entries && entries.length > 0) usedPlaylistFallback = true;
            }
            // 両方失敗したチャンネルだけを「検知経路の破綻」として数える
            if (entries === null) {
                failedChannels++;
                continue;
            }
            for (const e of entries) {
                if (!seen.has(e.videoId)) seen.set(e.videoId, e);
            }
        }
        if (usedPlaylistFallback) {
            // 5分ごとに出るとログが埋まるので、RSS 本体と同じ 10分間隔の抑制に載せる
            logRssError('fallback', new Error('RSS unavailable → Data API (uploads playlist) fallback used'));
        }

        // 検知経路の状態を報告する（壊れていることに気づけるようにする）
        reportDetectionState(failedChannels, usedPlaylistFallback, rssFailedChannels);

        if (seen.size === 0) return;

        // 2) ステータス確認が必要なものだけ抽出（liveSent済みは対象外）
        const needCheck = [];
        for (const [videoId, e] of seen) {
            const rec = records[videoId] || {};
            if (rec.liveSent) continue;
            const isUnhandled =
                !rec.plannedSent && !rec.liveSent && !rec.newVideoSent && !rec.notifiedAt;
            const isPlanned = rec.plannedSent && !rec.liveSent && plannedDueForLiveCheck(rec, now);
            if (isUnhandled || isPlanned) needCheck.push(videoId);
        }
        if (needCheck.length === 0) return;

        // 3) バッチで詳細取得
        const items = await fetchVideoStatusesBatch(needCheck);

        // 4) 分類して通知
        let changed = false;
        for (const [videoId, e] of seen) {
            const item = items.get(videoId);
            if (!item) continue;
            const live = item.liveStreamingDetails || null;
            const isLive = live && live.actualStartTime && !live.actualEndTime;
            const isScheduled = live && live.scheduledStartTime && !live.actualStartTime;
            const title = item.snippet?.title || e.title || 'YouTube動画';
            const rec = records[videoId] || {};

            if (rec.liveSent) continue;

            // ライブ開始（予定枠の開始もここで検知）
            if (isLive && !rec.liveSent) {
                const ok = await notifyLiveFromRss(item, title);
                if (ok) {
                    records[videoId] = { ...rec, liveSent: true, liveAt: new Date().toISOString() };
                    console.log(`[RSS] Live notify sent for ${videoId} (${title})`);
                    changed = true;
                }
                continue;
            }

            // 予定枠（webhookが検知できなかった場合のみ）
            if (isScheduled && !rec.plannedSent) {
                let publishedMs = NaN;
                if (e.published) publishedMs = Date.parse(e.published);
                if (!isNaN(publishedMs) && now - publishedMs <= RSS_PLANNED_FRESH_MS) {
                    const ok = await notifyPlannedFromRss(item, e.published, title);
                    if (ok) {
                        records[videoId] = {
                            ...rec,
                            plannedSent: true,
                            plannedAt: new Date().toISOString(),
                            plannedStart: live.scheduledStartTime || null
                        };
                        console.log(`[RSS] Planned notify sent for ${videoId} (${title})`);
                        changed = true;
                    }
                }
                continue;
            }
        }

        if (changed) saveSentRecords(records);
    } catch (e) {
        console.error('[YouTube RSS] fallback scan error:', e.message || e);
    } finally {
        _rssScanInFlight = false;
    }
}

function startPolling() {
    console.log(`[YouTube Poll] Starting live-end poller (interval: ${POLL_INTERVAL_MS / 1000}s)`);
    setInterval(pollForEndedLives, POLL_INTERVAL_MS);
    // 起動後初回は少し遅延して実行
    setTimeout(pollForEndedLives, 30 * 1000);

    console.log(`[CollabPoll] Starting collab-end poller (interval: ${POLL_INTERVAL_MS / 1000}s)`);
    setInterval(pollForEndedCollabs, POLL_INTERVAL_MS);
    setTimeout(pollForEndedCollabs, 90 * 1000);

    console.log(`[YouTube RSS] Starting fallback scan (interval: ${RSS_POLL_INTERVAL_MS / 1000}s)`);
    setInterval(runRssFallbackScan, RSS_POLL_INTERVAL_MS);
    setTimeout(runRssFallbackScan, 60 * 1000);
}

module.exports = {
    CHANNEL_IDS,
    startPolling,
    pollForEndedLives,
    pollForEndedCollabs,
    runRssFallbackScan,
    // src/core/schedule-drift-monitor.js が要求している（従来 export されておらず
    // 実行時 TypeError になっていたため追加）
    fetchVideoStatus,
    // 監視・検証用（RSS 取得と代替ソースの挙動確認）
    fetchRssVideoIds,
    fetchPlaylistVideoIds,
    // 監視・検証用（webhook のトークン検証。回帰テストから使う）
    createWebhookApp,
    init,
    startWebhook,
    subscribeAllChannels,
    startAutomaticResubscribe
};
