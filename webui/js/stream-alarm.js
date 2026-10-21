/**
 * stream-alarm.js - 配信開始アラームの設定 UI（Android アプリのみ）
 *
 * 目的:
 *   配信の 15 分前（など）に**端末内アラーム**を鳴らして、寝ていても起きて配信を見られるようにする。
 *   通知（FCM push）に依存せず AlarmManager.setAlarmClock で端末内に予約するので、
 *   push が届かない・遅延する環境でも鳴る。
 *
 * ブラウザ（Web のみ）では Android アプリが無いため、この UI は表示しない。
 * 実体は Kotlin 側（mai_notification/.../AlarmScheduler.kt）。
 */

const SA_STATE_KEY = 'streamAlarmState';

let saState = { enabled: false, offsetMin: 15, canExact: true, choices: [0, 5, 10, 15, 30] };

function saIsAndroidApp() {
  return !!(window.MaiApp && typeof window.MaiApp.getStreamAlarmState === 'function');
}

function saEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function saParseState(json) {
  try {
    const raw = typeof json === 'string' ? JSON.parse(json) : json;
    if (!raw || typeof raw !== 'object') return null;
    return {
      enabled: !!raw.enabled,
      offsetMin: Number(raw.offsetMin) || 0,
      canExact: raw.canExact !== false,
      choices: Array.isArray(raw.choices) && raw.choices.length ? raw.choices : [0, 5, 10, 15, 30],
    };
  } catch (e) {
    console.warn('[stream-alarm] 状態の解析に失敗', e);
    return null;
  }
}

function saLoadState() {
  if (!saIsAndroidApp()) return null;
  const parsed = saParseState(window.MaiApp.getStreamAlarmState());
  if (parsed) return parsed;
  // ブリッジが失敗した時はローカルストレージの値をフォールバックに使う
  try {
    const raw = localStorage.getItem(SA_STATE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return {
        enabled: !!o.enabled,
        offsetMin: Number(o.offsetMin) || 15,
        canExact: o.canExact !== false,
        choices: [0, 5, 10, 15, 30],
      };
    }
  } catch (e) { /* ignore */ }
  return null;
}

function saSaveStateLocal() {
  try { localStorage.setItem(SA_STATE_KEY, JSON.stringify(saState)); } catch (e) { /* ignore */ }
}

function saRender() {
  const box = document.getElementById('stream-alarm-settings');
  if (!box) return;

  const btn = document.getElementById('toggle-stream-alarm');
  if (btn) {
    btn.classList.toggle('is-on', saState.enabled);
    const prefix = '配信アラーム';
    btn.textContent = `${prefix}: ${saState.enabled ? 'ON' : 'OFF'}`;
  }

  const sel = document.getElementById('stream-alarm-offset');
  if (sel) {
    // 選択肢をアプリ側の指定に合わせる
    const wanted = saState.choices.map(String);
    const current = Array.from(sel.options).map((o) => o.value);
    if (wanted.join(',') !== current.join(',')) {
      sel.innerHTML = wanted
        .map((v) => `<option value="${saEsc(v)}">${saEsc(saOffsetLabel(Number(v)))}</option>`)
        .join('');
    }
    sel.value = String(saState.offsetMin);
  }

  const status = document.getElementById('stream-alarm-status');
  const permBtn = document.getElementById('btn-stream-alarm-permission');
  const sysBtn = document.getElementById('btn-stream-alarm-system');
  if (status) {
    if (!saState.canExact) {
      status.textContent = '正確なアラームの権限がありません（設定から許可してください）';
      status.style.color = '#c0392b';
    } else {
      status.textContent = saState.enabled
        ? `配信の${saOffsetLabel(saState.offsetMin)}に端末で通知します`
        : 'オフです';
      status.style.color = '';
    }
  }
  if (permBtn) permBtn.hidden = saState.canExact;
  if (sysBtn) sysBtn.hidden = false;
}

function saOffsetLabel(min) {
  if (!min) return '開始時刻ちょうど';
  return `${min}分前`;
}

function saInit() {
  const box = document.getElementById('stream-alarm-settings');
  if (!box) return;
  if (!saIsAndroidApp()) {
    box.hidden = true; // ブラウザでは使わない
    return;
  }
  box.hidden = false;

  const st = saLoadState();
  if (st) saState = st;
  saRender();

  const btn = document.getElementById('toggle-stream-alarm');
  if (btn) {
    btn.addEventListener('click', () => {
      saState.enabled = !saState.enabled;
      try {
        if (typeof window.MaiApp.setStreamAlarmEnabled === 'function') {
          window.MaiApp.setStreamAlarmEnabled(saState.enabled);
        }
      } catch (e) {
        console.warn('[stream-alarm] setStreamAlarmEnabled に失敗', e);
      }
      saSaveStateLocal();
      saRender();
    });
  }

  const sel = document.getElementById('stream-alarm-offset');
  if (sel) {
    sel.addEventListener('change', () => {
      const v = Number(sel.value) || 0;
      saState.offsetMin = v;
      try {
        if (typeof window.MaiApp.setStreamAlarmOffsetMin === 'function') {
          window.MaiApp.setStreamAlarmOffsetMin(v);
        }
      } catch (e) {
        console.warn('[stream-alarm] setStreamAlarmOffsetMin に失敗', e);
      }
      saSaveStateLocal();
      saRender();
    });
  }

  const permBtn = document.getElementById('btn-stream-alarm-permission');
  if (permBtn) {
    permBtn.addEventListener('click', () => {
      try {
        if (typeof window.MaiApp.openExactAlarmSettings === 'function') {
          window.MaiApp.openExactAlarmSettings();
        }
      } catch (e) { /* ignore */ }
    });
  }

  const sysBtn = document.getElementById('btn-stream-alarm-system');
  if (sysBtn) {
    sysBtn.addEventListener('click', () => {
      // 標準のアラーム時計に「開始時刻ちょうど」で登録する画面を開く。
      // ⚠️ EXTRA_SKIP_UI は API 19 以降無視され、必ず確認 UI が出る（1タップ必須）。
      try {
        if (typeof window.MaiApp.getNextStreamStartAt === 'function' &&
            typeof window.MaiApp.openSystemAlarmSetScreen === 'function') {
          const ms = Number(window.MaiApp.getNextStreamStartAt()) || 0;
          if (!ms) {
            alert('次の配信予定が見つかりませんでした');
            return;
          }
          const d = new Date(ms);
          window.MaiApp.openSystemAlarmSetScreen(d.getHours(), d.getMinutes(), 'まいちゃん 配信開始');
        }
      } catch (e) {
        console.warn('[stream-alarm] 標準アラームの設定に失敗', e);
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', saInit);
} else {
  saInit();
}

// 設定画面を開いた時に状態を更新する（権限を許可して戻った場合など）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const st = saLoadState();
  if (st) {
    saState = st;
    saRender();
  }
});
