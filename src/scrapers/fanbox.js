global.File = class File { };
const { getSharedBrowser, closeSharedBrowser } = require('../core/browser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { signNotifyPayload } = require('../core/notify-sign');

const LOCAL_API_URL = 'http://127.0.0.1:8080/api/notify';
const FANBOX_USER = 'koinoya-mai';
const ICON_URL = '/icon.webp';
const PUBLIC_URL = `https://www.fanbox.cc/@${FANBOX_USER}`;
const POLL_INTERVAL = 3 * 60 * 1000;
const STATE_FILE = path.resolve(__dirname, '..', '..', 'fanbox-state.json');
const NOTIFY_TOKEN = process.env.NOTIFY_API_TOKEN || process.env.LOCAL_API_TOKEN || null;

// 既知の投稿IDセット（IDの大小ではなく集合で管理）
let knownIds = new Set(loadState().knownIds || []);

// (プロセス終了時のクリーンアップ処理は main.js で一元管理するように変更しました)

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    }
  } catch (e) {
    console.error('state load err', e);
  }
  return {};
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ knownIds: Array.from(knownIds) }), 'utf8');
  } catch (e) {
    console.error('state save err', e);
  }
}

// 🔧 既知IDセット方式: IDの大小ではなく「初見かどうか」で新投稿を判定
async function checkFanboxPosts() {
  console.log(`Fanbox API check: ${FANBOX_USER}`);

  try {
    const res = await axios.get(`https://api.fanbox.cc/post.listCreator?creatorId=${FANBOX_USER}&limit=10`, {
      headers: {
        'Origin': 'https://www.fanbox.cc',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    if (!res.data || !res.data.body || !Array.isArray(res.data.body.posts)) {
      console.warn('Fanbox: APIレスポンスが不正です', res.data);
      return;
    }

    const items = res.data.body.posts;
    if (items.length === 0) {
      console.warn('Fanbox: 投稿が0件です');
      return;
    }

    const currentIds = [];
    const postTitleMap = new Map();
    
    items.forEach(item => {
      const id = parseInt(item.id, 10);
      currentIds.push(id);
      postTitleMap.set(id, item.title);
    });

    console.log(`Fanbox: 取得した最新の投稿ID: ${currentIds.join(', ')}`);
    console.log(`Fanbox: 既知ID数: ${knownIds.size}`);

    // 初回起動: 現在見えている全IDを「既知」として記録し通知しない
    if (knownIds.size === 0) {
      currentIds.forEach(id => knownIds.add(id));
      saveState();
      console.log(`初回起動: ${knownIds.size}件の投稿IDを既知として記録しました`);
      return;
    }

    // 既知セットにないIDを「新投稿」とみなす (逆順にして古いものから通知)
    const newIds = currentIds.filter(id => !knownIds.has(id)).reverse();

    if (newIds.length === 0) {
      console.log('Fanbox: 新しい投稿はありません');
      return;
    }

    if (newIds.length >= 5) {
      console.log(`Fanbox: 大量の新投稿(${newIds.length}件)を検出しました。再同期とみなし通知をスキップします。`);
      newIds.forEach(id => knownIds.add(id));
      saveState();
      return;
    }

    console.log(`Fanbox: 新投稿ID発見: ${newIds.join(', ')}`);

    // 新投稿それぞれについて通知
    for (const newId of newIds) {
      const newPostUrl = `https://www.fanbox.cc/@${FANBOX_USER}/posts/${newId}`;
      const postTitle = postTitleMap.get(newId) || '';

      console.log('Fanbox: 新しい投稿発見:', postTitle, newPostUrl);
      const payload = {
        type: 'fanbox',
        settingKey: 'fanbox',
        data: {
          title: '【Fanbox】恋乃夜まい｜pixivFANBOX',
          body: postTitle || undefined,
          url: newPostUrl,
          icon: ICON_URL,
          published: new Date().toISOString()
        }
      };

      try {
        const bodyString = JSON.stringify(payload);
        const sig = signNotifyPayload(process.env.NOTIFY_HMAC_SECRET || null, bodyString);
        await axios.post(LOCAL_API_URL, payload, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'X-Notify-Token': NOTIFY_TOKEN,
            ...(sig ? { 'X-Notify-Hmac': sig.hmac, 'X-Notify-Timestamp': sig.timestamp } : {})
          }
        });
        console.log('Fanbox -> /api/notify sent:', newPostUrl);
      } catch (e) {
        console.error('Fanbox notify failed:', e.message || e);
      }
    }

    // 通知後、新IDをすべて既知セットに追加して保存
    newIds.forEach(id => knownIds.add(id));
    saveState();

  } catch (e) {
    console.error('Fanbox check error:', e.message || e);
  }
}

function startPolling(interval = POLL_INTERVAL, onError = null, onRecovery = null) {
  console.log(`Fanbox polling started for @${FANBOX_USER} (interval: ${interval / 1000}s)`);

  let running = false;

  const loop = async () => {
    if (running) return;
    running = true;
    try {
      await checkFanboxPosts();
      if (typeof onRecovery === 'function') onRecovery();
    } catch (e) {
      console.error('Fanbox check error:', e);
      if (typeof onError === 'function') {
        onError(e?.message || String(e));
      }
    } finally {
      running = false;
    }

    const t = setTimeout(loop, interval);
    if (t && typeof t.unref === 'function') t.unref();
  };

  loop();
}

// 直接実行された場合は自動起動
if (require.main === module) {
  startPolling(POLL_INTERVAL);
  console.log(`Fanbox Puppeteer scraper running for @${FANBOX_USER}`);
}

module.exports = { startPolling, checkFanboxPosts };
