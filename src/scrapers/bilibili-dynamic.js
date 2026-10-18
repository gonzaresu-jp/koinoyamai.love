/*****************************************************************
  bilibili Dynamic watcher (production grade)
  - polymer API only
  - zero-miss diff detection
  - type aware parsing
  - jitter + exponential backoff
  - keep alive
*****************************************************************/

const axios = require('axios');
const fs = require('fs');
const { signNotifyPayload } = require('../core/notify-sign');
const path = require('path');
// env vars は main.js 経由で既に読み込まれているが、
// 単体起動時のために明示パスで dotenv も読む
require('dotenv').config({ path: path.join(__dirname, '.env') });

/* =========================================================
   設定
========================================================= */

const DEFAULT_UID = '1900434152';
const LOGS_DIR = path.join(__dirname, 'logs');
const STATE_FILE = path.join(LOGS_DIR, 'bilibili-state.json');

const DEFAULT_NOTIFY_CONFIG = {
  token: null,
  apiUrl: 'http://localhost:8080/api/notify',
  hmacSecret: null
};

// 30分間隔
const BASE_INTERVAL_MS = Number(process.env.BILI_DYNAMIC_INTERVAL_MS || 30 * 60 * 1000); // 30分 = 1800秒 = 1,800,000ms
const JITTER_MS = Number(process.env.BILI_DYNAMIC_JITTER_MS || 30000);
const MAX_BACKOFF_MS = Number(process.env.BILI_DYNAMIC_MAX_BACKOFF_MS || 30 * 60 * 1000);

/* =========================================================
   状態
========================================================= */

let lastId = null;
let timer = null;
let backoffMs = 0;
let notifyConfig = { ...DEFAULT_NOTIFY_CONFIG };
let uid = DEFAULT_UID;
let cookie = null;
let onError = null;
let onRecovery = null;

if (fs.existsSync(STATE_FILE)) {
  lastId = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastId || null;
}

/* =========================================================
   axios client
========================================================= */

function createClient() {
  return axios.create({
    timeout: 10000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      'Referer': `https://space.bilibili.com/${uid}/dynamic`,
      'Accept': 'application/json, text/plain, */*',
      'Cookie': cookie
    }
  });
}

/* =========================================================
   polymer API fetch
========================================================= */

async function fetchDynamicList() {
  const client = createClient();
  const res = await client.get(
    'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space',
    {
      params: {
        host_mid: uid
      }
    }
  );

  if (res.data.code !== 0) {
    throw new Error(`api rejected code=${res.data.code}`);
  }

  return res.data.data?.items || [];
}

/* =========================================================
   dynamic parser（型別）
========================================================= */

function parseDynamic(item) {
  const author = item.modules?.module_author;
  const dynamic = item.modules?.module_dynamic;

  const id = item.id_str;
  const ts = author?.pub_ts;
  const time = new Date(ts * 1000).toLocaleString();

  let text = '';

  if (!dynamic) return null;

  // 動画投稿
  if (dynamic.major?.archive) {
    text = `[動画] ${dynamic.major.archive.title}`;
  }
  // 最新のOpusフォーマット（画像・テキスト統合）
  else if (dynamic.major?.type === 'MAJOR_TYPE_OPUS') {
    text = dynamic.major.opus?.summary?.text || dynamic.desc?.text || '[投稿]';
  }
  // 画像投稿
  else if (dynamic.major?.draw) {
    text = `[画像] ${dynamic.desc?.text || ''}`;
  }
  // 通常テキスト
  else if (dynamic.desc?.text) {
    text = dynamic.desc.text;
  }
  // 転送
  else if (dynamic.major?.type === 'MAJOR_TYPE_FORWARD') {
    text = `[転送] ${dynamic.desc?.text || ''}`;
  }
  // ライブ配信開始
  else if (dynamic.major?.type === 'MAJOR_TYPE_LIVE_RCMD') {
    const liveTitle = dynamic.major.live_rcmd?.content?.live_play_info?.title || '';
    text = `[ライブ開始] ${liveTitle}`;
  }
  // 記事
  else if (dynamic.major?.type === 'MAJOR_TYPE_ARTICLE') {
    text = `[記事] ${dynamic.major.article?.title || ''}`;
  }
  // その他の形式のフォールバック
  else {
    text = dynamic.desc?.text || '[新しい投稿がありました]';
  }

  return {
    id,
    time,
    text: text.slice(0, 200),
    url: id ? `https://t.bilibili.com/${id}` : null
  };
}

/* =========================================================
   差分検出（全件方式 ← ここが最重要）
========================================================= */

function extractNewItems(list) {
  // ===== 初回起動時 =====
  if (!lastId) {
    const first = list[0];
    lastId = first?.id_str || null;
    saveState();

    // ★ ここ追加（最新投稿をログ出力）
    const parsed = parseDynamic(first);
    if (parsed) {
      console.log('[init]');
      console.log(`latest: ${parsed.time} | ${parsed.id}`);
      console.log(parsed.text);
    }

    return [];
  }

  // ===== 通常差分 =====
  const newItems = [];

  for (const item of list) {
    if (item.id_str === lastId) break;
    newItems.push(item);
  }

  if (newItems.length) {
    lastId = newItems[0].id_str;
    saveState();
  }

  return newItems.reverse();
}

/* =========================================================
   メイン処理
========================================================= */

async function fetchDynamic() {
  try {
    const list = await fetchDynamicList();

    if (!list.length) {
      console.log('[dynamic] empty');
      backoffMs = 0;
      return;
    }

    const newItems = extractNewItems(list);

    if (!newItems.length) {
      console.log('[no change]');
      backoffMs = 0;
      return;
    }

    console.log(`🔥 NEW POSTS: ${newItems.length}`);

    for (const item of newItems) {
      const parsed = parseDynamic(item);
      if (!parsed) continue;

      console.log(`${parsed.time} | ${parsed.id}`);
      console.log(parsed.text);

      if (notifyConfig?.apiUrl && notifyConfig?.token) {
        await sendNotify(parsed);
      }
    }

    backoffMs = 0;
    if (typeof onRecovery === 'function') onRecovery();

  } catch (e) {
    const status = e.response?.status;

    const retriable =
      status === 429 ||
      status === 403 ||
      status === 412 ||
      (status >= 500 && status < 600) ||
      !status;

    if (retriable) {
      backoffMs = backoffMs
        ? Math.min(backoffMs * 2, MAX_BACKOFF_MS)
        : BASE_INTERVAL_MS;
    }

    const errMsg = `[dynamic error] status=${status} ${e.message}`;
    console.error(errMsg);
    if (retriable) {
      console.log(`backoff: ${Math.round(backoffMs / 1000)}s`);
    }
    if (typeof onError === 'function') onError(errMsg);
  }
}

/* =========================================================
   util
========================================================= */

function saveState() {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
  } catch (_) {}
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ lastId }, null, 2)
  );
}

function getNextDelayMs() {
  if (backoffMs > 0) return backoffMs;

  const jitter = Math.floor((Math.random() * 2 - 1) * JITTER_MS);
  return Math.max(30000, BASE_INTERVAL_MS + jitter);
}

/* =========================================================
   notify
========================================================= */

async function sendNotify(parsed) {
  const payload = {
    type: 'bilibili',
    settingKey: 'bilibili',
    data: {
      title: '【Bilibili】新規投稿',
      body: parsed?.text || '',
      url: parsed?.url || `https://space.bilibili.com/${uid}/dynamic`,
      icon: '/icon.webp'
    }
  };

  const bodyString = JSON.stringify(payload);

  const headers = {
    'Content-Type': 'application/json',
    'X-Notify-Token': notifyConfig.token || ''
  };

if (notifyConfig.hmacSecret) {
    const sig = signNotifyPayload(notifyConfig.hmacSecret, bodyString);
    if (sig) {
      headers['X-Notify-Hmac'] = sig.hmac;
      headers['X-Notify-Timestamp'] = sig.timestamp;
    }
  }

  try {
    await axios.post(notifyConfig.apiUrl, payload, {
      headers,
      timeout: 10000
    });
    console.log('[bilibili-dynamic] notify sent:', parsed?.id);
  } catch (e) {
    console.error('[bilibili-dynamic] notify failed:', e?.message || e);
  }
}

/* =========================================================
   polling loop
========================================================= */

async function runLoop() {
  await fetchDynamic();

  const delay = getNextDelayMs();
  console.log(`[next check in ${Math.round(delay / 1000)}s]`);
  timer = setTimeout(runLoop, delay);
}

function startBilibiliDynamicWatcher(config = {}) {
  uid = String(config.uid || process.env.BILI_UID || DEFAULT_UID);
  cookie = config.cookie || process.env.BILI_COOKIE || null;
  notifyConfig = { ...DEFAULT_NOTIFY_CONFIG, ...(config.notifyConfig || {}) };
  onError = typeof config.onError === 'function' ? config.onError : null;
  onRecovery = typeof config.onRecovery === 'function' ? config.onRecovery : null;

  if (!cookie) {
    console.error('[bilibili-dynamic] BILI_COOKIE 未設定。スキップします。');
    return false;
  }

  console.log('[bilibili-dynamic] watching uid:', uid);
  runLoop();
  return true;
}

function stopBilibiliDynamicWatcher() {
  if (timer) clearTimeout(timer);
  timer = null;
}

process.on('SIGINT', () => {
  if (timer) clearTimeout(timer);
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (timer) clearTimeout(timer);
  process.exit(0);
});

if (require.main === module) {
  const ok = startBilibiliDynamicWatcher();
  if (!ok) process.exit(1);
}

module.exports = {
  startBilibiliDynamicWatcher,
  stopBilibiliDynamicWatcher
};

