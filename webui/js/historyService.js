// historyService.js - 履歴表示管理(JSON優先版)
import { API, PAGING, getClientId, normalizePlatformName } from './config.js';

// =========================
// JSONキャッシュ
// =========================
const jsonCache = {
  data: null,
  timestamp: 0,
  ttl: 5000, // 5秒
  limit: 50  // JSONの最大件数 (server.jsのHISTORY_JSON_LIMITと合わせる)
};

// =========================
// SSE（任意）: サーバが対応しているなら UI を自動更新
// =========================
export function setupHistorySse($logsEl, $statusEl) {
  const es = new EventSource('/api/events/stream');

  es.addEventListener('message', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload && payload.type === 'history-updated') {
        clearJsonCache();
        PAGING.offset = 0;
        PAGING.hasMore = true;
        fetchHistory($logsEl, $statusEl, { append: false, useCache: false });
      }
    } catch (err) {
      console.warn('[History SSE] Invalid payload', err);
    }
  });

  es.addEventListener('error', () => {
    console.warn('[History SSE] disconnected or error');
  });

  return es;
}

// =========================
// HTMLエスケープユーティリティ
// =========================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ツイキャスのサムネは http で配信されるが、CSP(img-src) は https のみ許可している。
// 証明書が *.twitcasting.tv で有効なため、履歴表示時は https に昇格させる。
function toHttpsThumb(url) {
  if (!url) return null;
  return /^http:\/\/(?:[\w-]+\.)*twitcasting\.tv\//i.test(url) ? 'https://' + url.slice(7) : url;
}

// サムネ読込失敗時（期限切れURL・外部障害など）はサムネ枠ごと隠して
// 壊れた画像アイコンが残らないようにする。
function bindThumbFallbacks(root) {
  if (!root) return;
  root.querySelectorAll('.log-media-thumb img:not([data-thumb-bound])').forEach((img) => {
    img.dataset.thumbBound = '1';
    const drop = () => { const box = img.closest('.log-media-thumb'); if (box) box.remove(); };
    if (img.complete && img.naturalWidth === 0) { drop(); return; }
    img.addEventListener('error', drop, { once: true });
  });
}

/**
 * URLをユーザー指定のテンプレートに基づいて変換する
 * @param {string} url 元のURL
 * @param {string} platform プラットフォーム名
 * @returns {string} 変換後のURL
 */
function transformUrl(url, platform) {
  if (!url) return url;
  
  let settings;
  try {
    const raw = localStorage.getItem('platformSettings');
    settings = raw ? JSON.parse(raw) : null;
  } catch (e) {
    return url;
  }
  
  if (!settings || !settings.customLinks) return url;

  // normalizePlatformName は config.js からインポート済み
  const p = normalizePlatformName(platform || '').toLowerCase();
  
  const mapping = {
    'twitcasting': 'twitcasting',
    'youtube': 'youtube',
    'twitch': 'twitch',
    'twitter': 'twitter',
    'fanbox': 'other',
    'pixiv': 'other',
    'gipt': 'other',
    'bilibili': 'other',
    'milestone': 'other',
    'schedule': 'other'
  };

  const linkKey = mapping[p] || 'other';
  const template = settings.customLinks[linkKey];

  if (!template || !template.trim() || !template.includes('{url}')) {
    return url;
  }

  return template.replace(/\{url\}/g, url);
}

// =========================
// SNS風タイムライン表示用ヘルパー
// =========================
const PLATFORM_META = {
  'youtube':           { label: 'YouTube',        icon: 'fa-brands fa-youtube',     tone: 'youtube' },
  'youtube-community': { label: 'YTコミュニティ', icon: 'fa-brands fa-youtube',     tone: 'youtube' },
  'twitter-main':      { label: 'X',              icon: 'fa-brands fa-x-twitter',   tone: 'twitter' },
  'twitter-sub':       { label: 'X (サブ)',       icon: 'fa-brands fa-x-twitter',   tone: 'twitter' },
  'twitch':            { label: 'Twitch',         icon: 'fa-brands fa-twitch',      tone: 'twitch' },
  'twitcasting':       { label: 'ツイキャス',     icon: 'fa-solid fa-tower-broadcast', tone: 'twitcasting' },
  'fanbox':            { label: 'FANBOX',         icon: 'fa-solid fa-palette',      tone: 'fanbox' },
  'bilibili':          { label: 'bilibili',       icon: 'fa-brands fa-bilibili',    tone: 'bilibili' },
  'schedule':          { label: 'スケジュール',   icon: 'fa-regular fa-calendar',   tone: 'primary' },
  'milestone':         { label: '記念日',         icon: 'fa-solid fa-heart',        tone: 'primary' },
  'gipt':              { label: 'Gipt',           icon: 'fa-solid fa-gift',         tone: 'primary' },
};

function formatTimelineTime(timestampSec) {
  const tsMs = (timestampSec || 0) * 1000;
  const date = new Date(tsMs);
  const full = date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Tokyo'
  });

  const diffSec = Math.floor((Date.now() - tsMs) / 1000);
  if (diffSec >= 0 && diffSec < 60) return { short: 'たった今', full };
  if (diffSec >= 60 && diffSec < 3600) return { short: `${Math.floor(diffSec / 60)}分前`, full };
  if (diffSec >= 3600 && diffSec < 86400) return { short: `${Math.floor(diffSec / 3600)}時間前`, full };
  if (diffSec >= 86400 && diffSec < 86400 * 7) return { short: `${Math.floor(diffSec / 86400)}日前`, full };

  const nowYear = new Date().toLocaleString('ja-JP', { year: 'numeric', timeZone: 'Asia/Tokyo' });
  const itemYear = date.toLocaleString('ja-JP', { year: 'numeric', timeZone: 'Asia/Tokyo' });
  const short = date.toLocaleString('ja-JP', {
    ...(nowYear !== itemYear ? { year: 'numeric' } : {}),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Tokyo'
  });
  return { short, full };
}

// =========================
// UI生成
// =========================
export function createLogItem(log) {
  const { short: timeShort, full: timeFull } = formatTimelineTime(log.timestamp);

  const safeTitle = escapeHtml(log.title || '通知');
  const safeBody = escapeHtml(log.body || 'メッセージなし');

  // URLのカスタム変換を適用
  const displayUrl = transformUrl(log.url, log.platform);
  const safeUrl = displayUrl ? escapeHtml(displayUrl) : '';

  const titleHtml = safeUrl
    ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeTitle}</a>`
    : safeTitle;

  const statusClass = log.status === 'fail' ? ' status-fail' : '';
  const platformData = normalizePlatformName(log.platform || '不明');
  const meta = Object.hasOwn(PLATFORM_META, platformData) ? PLATFORM_META[platformData] : {
    label: log.platform || '通知',
    icon: 'fa-solid fa-bell',
    tone: 'default'
  };

  const avatarSrc = escapeHtml(log.icon || '/icon.webp');
  const avatarHtml = `
    <div class="sns-avatar-wrap">
      <img src="${avatarSrc}" alt="" class="icon sns-avatar" loading="lazy" />
      <span class="sns-plat-dot tone-${meta.tone}" aria-hidden="true"><i class="${meta.icon}"></i></span>
    </div>
  `;

  // Generate HTML for log item with optional media thumbnail
  // Twitter 添付は media_url、YouTube/ツイキャスの配信サムネは image を使う
  const thumbUrl = toHttpsThumb(log.media_url || log.image);
  const safeThumbUrl = thumbUrl ? escapeHtml(thumbUrl) : '';
  const thumbType = thumbUrl ? (log.media_url ? log.media_type : 'image') : null;
  const mediaThumbHtml = (safeThumbUrl && thumbType) ? `
    <div class="log-media-thumb" data-media-url="${safeThumbUrl}" data-media-type="${escapeHtml(thumbType)}">
      ${thumbType === 'video'
        ? `<div class="media-thumb-content"><video src="${safeThumbUrl}" preload="metadata" muted></video><div class="video-badge"><i class="fa-solid fa-play"></i> 動画</div></div>`
        : `<div class="media-thumb-content"><img src="${safeThumbUrl}" alt="" loading="lazy"></div>`}
    </div>` : '';

  const footHtml = safeUrl
    ? `<div class="sns-foot"><a class="sns-open-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> 開く</a></div>`
    : '';

  return `
    <article class="card sns-post${statusClass}" data-platform="${escapeHtml(platformData)}">
      ${avatarHtml}
      <div class="card-content sns-main">
        <div class="sns-head meta">
          <div class="title sns-author">${titleHtml}</div>
          <span class="platform sns-plat-pill tone-${meta.tone}">${escapeHtml(meta.label)}</span>
          ${log.status === 'fail' ? '<span class="status-badge sns-fail-badge">送信失敗</span>' : ''}
          <time class="time sns-time" title="${escapeHtml(timeFull)}">${escapeHtml(timeShort)}</time>
        </div>
        <p class="body sns-body">${safeBody}</p>
        ${mediaThumbHtml}
        ${footHtml}
      </div>
    </article>
  `;
}

export function applySequentialFadeIn() {
  const cards = document.querySelectorAll('#logs .card:not([data-fade-applied])');
  const delayIncrement = 0.15;

  cards.forEach((card, index) => {
    const delay = index * delayIncrement;
    card.style.animationDelay = `${delay}s`;
    card.setAttribute('data-fade-applied', 'true');

    card.addEventListener('animationend', function handler() {
      card.style.animation = 'none';
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
      card.removeEventListener('animationend', handler);
    }, { once: true });
  });
}

// =========================
// 内部ユーティリティ
// =========================
function getCurrentFilterSettingsFallback() {
  return {
    twitcasting: document.getElementById('filter-twitcasting')?.classList.contains('is-on') || false,
    youtube: document.getElementById('filter-youtube')?.classList.contains('is-on') || false,
    youtubeCommunity: document.getElementById('filter-youtube-community')?.classList.contains('is-on') || false,
    fanbox: document.getElementById('filter-fanbox')?.classList.contains('is-on') || false,
    twitterMain: document.getElementById('filter-twitter-main')?.classList.contains('is-on') || false,
    twitterSub: document.getElementById('filter-twitter-sub')?.classList.contains('is-on') || false,
    milestone: document.getElementById('filter-milestone')?.classList.contains('is-on') || false,
    schedule: document.getElementById('filter-schedule')?.classList.contains('is-on') || false,
    gipt: document.getElementById('filter-gipt')?.classList.contains('is-on') || false,
    twitch: document.getElementById('filter-twitch')?.classList.contains('is-on') || false,
    bilibili: document.getElementById('filter-bilibili')?.classList.contains('is-on') | false,
  };
}

function shouldIncludeLog(log, settings) {
  if (!log) return false;
  if (!settings) return true;

  const anyEnabled = Object.values(settings).some(Boolean);
  if (!anyEnabled) return true;

  const platform = normalizePlatformName((log.platform || '').toString());

  if (platform.includes('twitcasting')) return !!settings.twitcasting;
  if (platform.includes('youtube') && platform.includes('community')) return !!settings.youtubeCommunity;
  if (platform.includes('youtube')) return !!settings.youtube;
  if (platform.includes('fanbox') || platform.includes('pixiv')) return !!settings.fanbox;
  if (platform.includes('twitter') && platform.includes('sub')) return !!settings.twitterSub;
  if (platform.includes('twitter')) return !!settings.twitterMain;
  if (platform.includes('milestone')) return !!settings.milestone;
  if (platform.includes('schedule')) return !!settings.schedule;
  if (platform.includes('gipt')) return !!settings.gipt;
  if (platform.includes('twitch')) return !!settings.twitch;
  if (platform.includes('bilibili')) return !! settings.bilibili;

  return true;
}

async function fetchJsonWithTimeout(url, { timeoutMs = 8000, noStore = false } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: noStore ? 'no-store' : 'default',
      headers: { 'Accept': 'application/json' }
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// =========================
// JSONファイルから履歴取得
// =========================
async function fetchHistoryFromJson(settings, pageLimit) {
  const now = Date.now();
  
  if (jsonCache.data && (now - jsonCache.timestamp < jsonCache.ttl)) {
    return jsonCache.data;
  }

  try {
    const res = await fetchJsonWithTimeout('/history.json', {
      timeoutMs: 5000,
      noStore: true
    });

    if (!res.ok) throw new Error(`JSON fetch failed: ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data.logs)) throw new Error('Invalid JSON format');

    jsonCache.data = data;
    jsonCache.timestamp = now;
    return data;
  } catch (e) {
    console.warn('[fetchHistoryFromJson] JSON取得失敗:', e.message);
    return null;
  }
}

// =========================
// 履歴取得のメイン関数
// =========================
export async function fetchHistory($logsEl, $statusEl, { append = false, useCache = true } = {}) {
  if (PAGING.loading) return;

  const startTime = performance.now();
  PAGING.loading = true;
  PAGING.initialized = true;

  const pageLimit = PAGING.limit || 5;
  const clientId = getClientId();

  if (!append) {
    PAGING.offset = 0;
    PAGING.displayedCount = 0;
    if ($logsEl) {
      $logsEl.innerHTML = renderHistorySkeleton();
    }
  }

  const settings =
    (typeof window.getCurrentFilterSettings === 'function')
      ? window.getCurrentFilterSettings()
      : getCurrentFilterSettingsFallback();

  let collectedLogs = [];
  let rawProcessedCount = 0;
  let totalCount = 0;
  let hasMore = false;

  try {
    // 1. JSONキャッシュ/ファイルから取得
    if (PAGING.offset < jsonCache.limit) {
      const jsonData = await fetchHistoryFromJson(settings, pageLimit);
      if (jsonData && Array.isArray(jsonData.logs)) {
        const startIdx = PAGING.offset;
        let i = startIdx;
        while (i < jsonData.logs.length && collectedLogs.length < pageLimit) {
          const log = jsonData.logs[i];
          if (shouldIncludeLog(log, settings)) {
            collectedLogs.push(log);
          }
          i++;
        }
        rawProcessedCount = i - startIdx;
        totalCount = jsonData.total ?? jsonData.logs.length;
        hasMore = i < totalCount || totalCount > jsonData.logs.length;
      }
    }

    // 2. もし追加が必要ならDB APIから取得
    // JSONの末尾に達したか、最初からJSONの範囲外の場合
    if (collectedLogs.length < pageLimit && (PAGING.hasMore || !PAGING.initialized)) {
      const needed = pageLimit - collectedLogs.length;
      const dbOffset = PAGING.offset + rawProcessedCount;

      // フィルタによる空振りを防ぐため、少し多めに取得する（最大50）
      const apiLimit = Math.min(needed * 5, 50);

      const url = `${API.HISTORY}?clientId=${encodeURIComponent(clientId || '')}&limit=${apiLimit}&offset=${dbOffset}`;
      
      const res = await fetchJsonWithTimeout(url, { timeoutMs: 8000, noStore: true });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.logs)) {
          let j = 0;
          while (j < data.logs.length && collectedLogs.length < pageLimit) {
            const log = data.logs[j];
            if (shouldIncludeLog(log, settings)) {
              collectedLogs.push(log);
            }
            j++;
          }
          // 重要：実際に「使用または検討した」件数分だけオフセットを進める
          rawProcessedCount += j;
        }
        totalCount = data.total ?? totalCount;
        // DB上の全件数と比較して次があるか判定
        hasMore = (dbOffset + (Array.isArray(data.logs) ? data.logs.length : 0)) < totalCount;
      }
    }

    // 3. 描画処理
    if ($logsEl) {
      if (!append) {
        $logsEl.innerHTML = '';
        $logsEl.classList.add('loaded');
        delete $logsEl.dataset.source;
      }

      if (collectedLogs.length > 0) {
        const html = collectedLogs.map(createLogItem).join('');
        $logsEl.insertAdjacentHTML('beforeend', html);
        requestAnimationFrame(() => {
          applySequentialFadeIn();
          bindThumbFallbacks($logsEl);
        });
      } else if (!append) {
        $logsEl.innerHTML = '<p class="status-message info-message">表示できる履歴はありません</p>';
      }
    }

    // 4. 状態更新
    PAGING.offset += rawProcessedCount;
    const visibleCards = $logsEl ? $logsEl.querySelectorAll('.card:not(.filtered-out)').length : 0;
    PAGING.displayedCount = visibleCards;
    PAGING.hasMore = hasMore;

    const $btnMore = document.getElementById('more-logs-button');
    if ($btnMore) {
      $btnMore.style.display = PAGING.hasMore ? 'block' : 'none';
    }

    if ($statusEl) {
      const loadTimeSec = (performance.now() - startTime) / 1000;
      $statusEl.textContent = `表示中: ${PAGING.displayedCount} / 総数: ${totalCount} (${loadTimeSec.toFixed(2)}秒)`;
      $statusEl.className = 'status-message success-message';
    }

    if (typeof window.applyLogFiltering === 'function') {
      window.applyLogFiltering();
    }

  } catch (e) {
    console.error('[fetchHistory] 失敗:', e);
    if ($statusEl) {
      $statusEl.textContent = '履歴の取得に失敗しました';
      $statusEl.className = 'status-message error-message';
    }
  } finally {
    PAGING.loading = false;
  }
}

function renderHistorySkeleton(count = 5) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <div class="skeleton-card">
        <div class="skeleton-box skeleton-icon"></div>
        <div class="skeleton-content">
          <div class="skeleton-box skeleton-line title"></div>
          <div class="skeleton-box skeleton-line"></div>
          <div class="skeleton-box skeleton-line" style="width: 80%"></div>
          <div class="skeleton-box skeleton-line meta"></div>
        </div>
      </div>
    `;
  }
  return html;
}

// =========================
// more ボタン
// =========================
export function fetchHistoryMore($logsEl, $statusEl) {
  if (PAGING.hasMore && !PAGING.loading) {
    fetchHistory($logsEl, $statusEl, { append: true, useCache: false });
  }
}

// =========================
// JSON キャッシュ制御
// =========================
export function clearJsonCache() {
  jsonCache.data = null;
  jsonCache.timestamp = 0;
}

export const clearHistoryCache = clearJsonCache;

// =========================
// Media Lightbox Interaction
// =========================
;(function initLightbox() {
  const el = document.getElementById('media-lightbox');
  if (el && el.parentNode !== document.body) {
    document.body.appendChild(el);
  }
  // Android WebViewはbackdrop-filterのGPU合成が不安定で画像が隠れることがあるため無効化
  try {
    const isAndroid = !!(window.MaiApp && typeof window.MaiApp.isAndroidApp === 'function' && window.MaiApp.isAndroidApp());
    if (el && isAndroid) el.classList.add('no-blur');
  } catch {}
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const lb = document.getElementById('media-lightbox');
    const ct = document.getElementById('lightbox-content');
    if (lb?.classList.contains('is-open')) {
      lb.classList.remove('is-open');
      lb.style.touchAction = '';
      document.body.classList.remove('lightbox-open');
      if (ct) ct.innerHTML = '';
      resetZoomState();
    }
  }
});

// Zoom/pan state (image only, not video)
let zoomState = null;

function resetZoomState() {
  if (zoomState?.momentumRaf) cancelAnimationFrame(zoomState.momentumRaf);
  zoomState = null;
}

function setupZoomPan(mediaEl) {
  if (!mediaEl || mediaEl.tagName === 'VIDEO') return;
  mediaEl.style.transformOrigin = '0 0';
  mediaEl.style.willChange = 'transform';
  zoomState = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, vx: 0, vy: 0, history: [], momentumRaf: 0 };

  function apply() {
    if (!zoomState || !mediaEl) return;
    mediaEl.style.transform = zoomState.scale > 1
      ? `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`
      : '';
  }

  function runMomentum() {
    if (!zoomState || (Math.abs(zoomState.vx) < 0.5 && Math.abs(zoomState.vy) < 0.5)) return;
    zoomState.vx *= 0.94;
    zoomState.vy *= 0.94;
    zoomState.x += zoomState.vx;
    zoomState.y += zoomState.vy;
    apply();
    zoomState.momentumRaf = requestAnimationFrame(runMomentum);
  }

  function stopMomentum() {
    if (zoomState?.momentumRaf) {
      cancelAnimationFrame(zoomState.momentumRaf);
      zoomState.momentumRaf = 0;
    }
    zoomState.vx = 0; zoomState.vy = 0;
  }

  function onWheel(e) {
    if (!zoomState) return;
    e.preventDefault();
    stopMomentum();
    const rect = mediaEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const prev = zoomState.scale;
    const next = Math.max(1, Math.min(20, prev * Math.pow(1.08, -e.deltaY / 100)));
    if (next === 1) {
      zoomState.scale = 1; zoomState.x = 0; zoomState.y = 0;
    } else {
      const r = next / prev;
      zoomState.scale = next;
      zoomState.x = mx * (1 - r) + zoomState.x;
      zoomState.y = my * (1 - r) + zoomState.y;
    }
    apply();
  }

  function onDown(e) {
    if (!zoomState || e.button !== 0 || zoomState.scale <= 1) return;
    stopMomentum();
    zoomState.dragging = true;
    zoomState.startX = e.clientX - zoomState.x;
    zoomState.startY = e.clientY - zoomState.y;
    zoomState.history = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
    mediaEl.style.cursor = 'grabbing';
    e.preventDefault();
  }

  function onMove(e) {
    if (!zoomState?.dragging) return;
    zoomState.x = e.clientX - zoomState.startX;
    zoomState.y = e.clientY - zoomState.startY;
    zoomState.history.push({ t: performance.now(), x: e.clientX, y: e.clientY });
    if (zoomState.history.length > 10) zoomState.history.shift();
    apply();
  }

  function onUp() {
    if (!zoomState) return;
    zoomState.dragging = false;
    if (mediaEl) mediaEl.style.cursor = zoomState.scale > 1 ? 'grab' : '';
    // compute momentum velocity from last ~5 events
    const h = zoomState.history;
    if (h.length >= 2) {
      const recent = h.slice(-5);
      const first = recent[0], last = recent[recent.length - 1];
      const dt = last.t - first.t;
      if (dt > 0 && dt < 150) {
        zoomState.vx = (last.x - first.x) / dt * 16 * 0.8;
        zoomState.vy = (last.y - first.y) / dt * 16 * 0.8;
        zoomState.momentumRaf = requestAnimationFrame(runMomentum);
      }
    }
    zoomState.history = [];
  }

  function onDbl(e) {
    if (!zoomState) return;
    e.preventDefault();
    stopMomentum();
    if (zoomState.scale > 1) {
      zoomState.scale = 1; zoomState.x = 0; zoomState.y = 0;
    } else {
      zoomState.scale = 3; zoomState.x = 0; zoomState.y = 0;
    }
    if (mediaEl) mediaEl.style.cursor = zoomState.scale > 1 ? 'grab' : '';
    apply();
  }

  // --- Touch handling (mobile) ---
  let touchId = null;
  let pinchDist = 0;
  const lb = document.getElementById('media-lightbox');
  if (!lb) return;

  function onTouchStart(e) {
    if (!zoomState || !mediaEl) return;
    if (e.touches.length === 1) {
      if (!mediaEl.contains(e.target)) return;
      if (zoomState.scale <= 1) return;
      e.preventDefault();
      touchId = e.touches[0].identifier;
      const t = e.touches[0];
      stopMomentum();
      zoomState.dragging = true;
      zoomState.startX = t.clientX - zoomState.x;
      zoomState.startY = t.clientY - zoomState.y;
      zoomState.history = [{ t: performance.now(), x: t.clientX, y: t.clientY }];
    } else if (e.touches.length >= 2) {
      e.preventDefault();
      stopMomentum();
      touchId = null;
      zoomState.dragging = false;
      const t0 = e.touches[0], t1 = e.touches[1];
      pinchDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    }
  }

  function onTouchMove(e) {
    if (!zoomState || !mediaEl) return;
    if (e.touches.length === 1 && zoomState.dragging && touchId !== null) {
      e.preventDefault();
      const t = e.touches[0];
      zoomState.x = t.clientX - zoomState.startX;
      zoomState.y = t.clientY - zoomState.startY;
      zoomState.history.push({ t: performance.now(), x: t.clientX, y: t.clientY });
      if (zoomState.history.length > 10) zoomState.history.shift();
      apply();
    } else if (e.touches.length >= 2) {
      e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      const d = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const cx = (t0.clientX + t1.clientX) / 2;
      const cy = (t0.clientY + t1.clientY) / 2;
      if (pinchDist === 0) {
        pinchDist = d;
        return;
      }
      const ratio = pinchDist > 0 ? d / pinchDist : 1;
      pinchDist = d;
      const s = Math.max(1, Math.min(20, zoomState.scale * ratio));
      if (s === 1) {
        zoomState.scale = 1; zoomState.x = 0; zoomState.y = 0;
      } else {
        const rect = mediaEl.getBoundingClientRect();
        const mx = cx - rect.left;
        const my = cy - rect.top;
        zoomState.x = mx * (1 - ratio) + zoomState.x;
        zoomState.y = my * (1 - ratio) + zoomState.y;
        zoomState.scale = s;
      }
      apply();
    }
  }

  function onTouchEnd(e) {
    if (!zoomState) return;
    if (e.touches.length === 0 && zoomState.dragging) {
      zoomState.dragging = false;
      const h = zoomState.history;
      if (h.length >= 2) {
        const recent = h.slice(-5);
        const first = recent[0], last = recent[recent.length - 1];
        const dt = last.t - first.t;
        if (dt > 0 && dt < 150) {
          zoomState.vx = (last.x - first.x) / dt * 16 * 0.5;
          zoomState.vy = (last.y - first.y) / dt * 16 * 0.5;
          zoomState.momentumRaf = requestAnimationFrame(runMomentum);
        }
      }
      zoomState.history = [];
      touchId = null;
    } else if (e.touches.length < 2) {
      pinchDist = 0;
    }
  }

  lb.style.touchAction = 'none';
  mediaEl.addEventListener('wheel', onWheel, { passive: false });
  mediaEl.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  mediaEl.addEventListener('dblclick', onDbl);
  lb.addEventListener('touchstart', onTouchStart, { passive: false });
  lb.addEventListener('touchmove', onTouchMove, { passive: false });
  lb.addEventListener('touchend', onTouchEnd, { passive: false });
  lb.addEventListener('touchcancel', onTouchEnd, { passive: false });
}

document.addEventListener('click', (event) => {
  const lightbox = document.getElementById('media-lightbox');
  const content = document.getElementById('lightbox-content');
  if (!lightbox) return;

  // Close when clicking overlay background or close button
  if (lightbox.classList.contains('is-open')) {
    if (event.target === lightbox || event.target.closest('#lightbox-close')) {
      lightbox.classList.remove('is-open');
      lightbox.style.touchAction = '';
      document.body.classList.remove('lightbox-open');
      if (content) {
        const media = content.querySelector('img, video');
        if (media) {
          media.removeAttribute('style');
          media.style.maxWidth = '90vw';
          media.style.maxHeight = '90vh';
        }
        content.innerHTML = '';
      }
      resetZoomState();
      return;
    }
  }

  // Open lightbox when a media thumbnail is clicked
  const thumb = event.target.closest('.log-media-thumb');
  if (thumb && content) {
    const mediaUrl = thumb.dataset.mediaUrl;
    const mediaType = thumb.dataset.mediaType;
    resetZoomState();
    // Android WebViewでvh単位が0として計算される既知の不具合があるため、
    // window.innerHeight/innerWidthから直接pxを計算して指定する
    const maxW = Math.round(window.innerWidth * 0.9);
    const maxH = Math.round(window.innerHeight * 0.9);
    content.style.maxWidth = maxW + 'px';
    content.style.maxHeight = maxH + 'px';
    if (mediaType === 'video') {
      content.innerHTML = `<video src="${mediaUrl}" controls autoplay style="max-width:${maxW}px; max-height:${maxH}px;"></video>`;
    } else {
      content.innerHTML = `<img src="${mediaUrl}" style="max-width:${maxW}px; max-height:${maxH}px;" />`;
      const img = content.querySelector('img');
      if (img) {
        img.addEventListener('error', () => {
          content.innerHTML = `<div class="lightbox-error">画像を読み込めませんでした<br><a href="${mediaUrl}" target="_blank" rel="noopener">別タブで開く</a></div>`;
        }, { once: true });
      }
    }
    lightbox.classList.add('is-open');
    document.body.classList.add('lightbox-open');
    setupZoomPan(content.querySelector('img, video'));
  }
});
