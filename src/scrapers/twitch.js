const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TWITCH_API = 'https://api.twitch.tv/helix';
const TWITCH_AUTH = 'https://id.twitch.tv/oauth2/token';

const STATE_FILE = path.join(__dirname, 'twitch_state.json');


/* ===============================
   永続状態管理
================================ */

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}


/* ===============================
   Utility
================================ */

function extractLoginFromUrl(url) {
  const u = new URL(url);
  return u.pathname.split('/').filter(Boolean)[0];
}

async function fetchAppAccessToken(clientId, clientSecret) {
  const res = await axios.post(TWITCH_AUTH, null, {
    params: {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    },
  });
  return res.data.access_token;
}

async function checkStream(broadcasterId, token, clientId) {
  const res = await axios.get(`${TWITCH_API}/streams`, {
    params: { user_id: broadcasterId },
    headers: {
      'Client-Id': clientId,
      'Authorization': `Bearer ${token}`,
    },
  });
  return res.data.data[0] || null;
}

async function getBroadcasterId(login, token, clientId) {
  const res = await axios.get(`${TWITCH_API}/users`, {
    params: { login },
    headers: {
      'Client-Id': clientId,
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!res.data.data.length) throw new Error(`User not found: ${login}`);
  return res.data.data[0].id;
}


/* ===============================
   Main
================================ */

async function startTwitchPolling(config) {
  const { twitchUrl, clientId, clientSecret, notifyConfig, scheduleConfig, interval = 10000, onError, onRecovery } = config;

  let currentToken = config.appAccessToken;
  let broadcasterId = null;

  const broadcasterLogin = extractLoginFromUrl(twitchUrl);

  const state = loadState();
  let lastStreamId = state.lastStreamId || null;

  const poll = async () => {
    try {
      if (!broadcasterId) {
        if (!currentToken) currentToken = await fetchAppAccessToken(clientId, clientSecret);
        broadcasterId = await getBroadcasterId(broadcasterLogin, currentToken, clientId);
      }

      const stream = await checkStream(broadcasterId, currentToken, clientId);

      /* ===============================
         通知ロジック（IDベース）
      =============================== */

      if (stream) {
        if (stream.id !== lastStreamId) {
          console.log(`[Twitch] New stream detected: ${stream.id}`);

          lastStreamId = stream.id;
          saveState({ lastStreamId });

          if (notifyConfig?.apiUrl) {
            await axios.post(
              notifyConfig.apiUrl,
              {
                type: 'twitch',
                data: {
                  title: `${broadcasterLogin} が配信を開始しました`,
                  body: stream.title || '',
                  url: `https://www.twitch.tv/${broadcasterLogin}`,
                  icon: 'https://assets.twitch.tv/assets/favicon-32-e29e246c157142c94346.png',
                  image: stream.thumbnail_url
                    ? stream.thumbnail_url.replace('{width}', '640').replace('{height}', '360')
                    : null,
                },
              },
              {
                headers: { 'X-Notify-Token': notifyConfig.token },
                timeout: 5000,
              }
            ).catch(() => {});
          }

          if (scheduleConfig?.apiUrl && scheduleConfig?.token) {
            const thumbUrl = stream.thumbnail_url
              ? stream.thumbnail_url.replace('{width}', '640').replace('{height}', '360')
              : null;
            try {
              await axios.post(
                scheduleConfig.apiUrl,
                {
                  title: stream.title || `${broadcasterLogin} の配信`,
                  scheduled_at: stream.started_at || new Date().toISOString(),
                  url: `https://www.twitch.tv/${broadcasterLogin}`,
                  thumbnail_url: thumbUrl,
                  platform: 'twitch',
                  external_id: `twitch_${stream.id}`
                },
                {
                  headers: { 'Content-Type': 'application/json', 'X-Notify-Token': scheduleConfig.token },
                  timeout: 10000,
                }
              );
              console.log(`[Twitch] schedule event created for stream ${stream.id}`);
            } catch (e) {
              console.warn(`[Twitch] schedule event creation failed:`, e.message);
            }
          }
        }
      }

      if (typeof onRecovery === 'function') onRecovery();

    } catch (e) {
      if (e.response?.status === 401) {
        currentToken = await fetchAppAccessToken(clientId, clientSecret);
      } else {
        const msg = `[Twitch] Polling error: ${e.message}`;
        console.error(msg);
        if (typeof onError === 'function') onError(e.message);
      }
    }

    setTimeout(poll, interval);
  };

  poll();
}

module.exports = { startTwitchPolling };
