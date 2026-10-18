const { KeepLiveWS } = require('bilibili-live-ws');
const axios = require('axios');

let live = null;
let isLive = false;

async function fetchLiveStatus(roomId) {
  const url = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}`;
  const res = await axios.get(url, { timeout: 10000 });
  const liveStatus = Number(res?.data?.data?.live_status || 0);
  return liveStatus === 1;
}

function startBilibiliWatcher({ roomId, onLiveStart, onError, onRecovery }) {
  if (live) {
    console.log('[bilibili] already started');
    return;
  }

  roomId = Number(roomId);

  console.log('[bilibili] watching room:', roomId);

  live = new KeepLiveWS(roomId);

  console.log('[bilibili] connected, waiting for room events...');

  // "live" here means websocket join success, not stream live start.
  live.on('live', async () => {
    try {
      const nowLive = await fetchLiveStatus(roomId);
      isLive = nowLive;
      console.log(nowLive ? 'livestart (already live)' : 'offline');
      if (typeof onRecovery === 'function') onRecovery();
    } catch (e) {
      console.error('[bilibili] failed to fetch initial live status:', e?.message || e);
    }
  });

  // Bilibili room command when stream starts.
  live.on('LIVE', () => {
    if (isLive) return;

    isLive = true;
    console.log('livestart');

    // ★ mainへ通知
    if (onLiveStart) onLiveStart();
  });

  // Bilibili room command when stream ends.
  live.on('PREPARING', () => {
    if (!isLive) return;
    isLive = false;
    console.log('offline');
  });

  live.on('error', (err) => {
    const msg = err?.message || String(err);
    console.error('[bilibili] websocket error:', msg);
    if (typeof onError === 'function') onError(msg);
  });
}

module.exports = { startBilibiliWatcher };

if (require.main === module) {
  require('dotenv').config();

  const roomId = process.env.BILIBILI_ROOM_ID;
  if (!roomId) {
    console.error('[bilibili] BILIBILI_ROOM_ID is not set in .env');
    process.exit(1);
  }

  startBilibiliWatcher({
    roomId,
    onLiveStart: () => {
      console.log('[bilibili] onLiveStart callback called');
    }
  });

  process.on('SIGINT', () => {
    console.log('[bilibili] stopped by SIGINT');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('[bilibili] stopped by SIGTERM');
    process.exit(0);
  });
}
