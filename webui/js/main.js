// main.js - メイン初期化処理（header.html fetch 挿入対応版）

import { PAGING, getClientId } from './config.js?v=20260403';
import { initPush, unsubscribePush, sendTestToMe, sendSubscriptionToServer } from './pushService.js?v=20260312a';
import { savePlatformSettings, getPlatformSettings } from './settingsService.js?v=20260312c';
import { saveNameToServer, initSubscriberNameUI } from './subscriberService.js?v=20260312a';
import { fetchHistory, fetchHistoryMore, clearJsonCache } from './historyService.js?v=20260407a';
import { initLogFilterSettings } from './filterService.js?v=20260312a';
import {
  updateToggleImage,
  updatePlatformSettingsVisibility,
  initPlatformSettingsUI,
  initHeaderDependentUI,
  loadPlatformSettingsUIFromServer
} from './uiController.js?v=20260317a';
import './palette.js';

function isAndroidApp() {
  try {
    return typeof window !== 'undefined' && window.MaiApp && typeof window.MaiApp.isAndroidApp === 'function' && window.MaiApp.isAndroidApp();
  } catch {
    return false;
  }
}

if (isAndroidApp() && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(r => r.unregister());
  }).catch(() => { });
}

// 旧 Android アプリ（v1.0）の利用者に入れ直しを案内する。
// v1.1 から署名の鍵が変わったため上書きアップデートできない。v1.0 には getAppVersion が無いのでそれで見分ける。
function showLegacyAndroidAppNotice() {
  const KEY = 'mai-legacy-app-notice-dismissed';
  try { if (Date.now() - Number(localStorage.getItem(KEY) || 0) < 3 * 86400000) return; } catch { }
  if (location.pathname.startsWith('/download')) return;
  const bar = document.createElement('div');
  bar.setAttribute('role', 'alert');
  bar.style.cssText = 'position:fixed;left:10px;right:10px;bottom:12px;z-index:99999;background:#fff;border:2px solid #b11e7c;' +
    'border-radius:14px;padding:12px 14px;box-shadow:0 6px 20px rgba(0,0,0,.18);font-size:14px;line-height:1.55;color:#333;';
  bar.innerHTML = '<div style="font-weight:800;color:#b11e7c;margin-bottom:4px;">アプリの新しいバージョンがあります</div>' +
    '<div>このアプリは古いバージョン（v1.0）です。新しいバージョンは自動で更新できないため、<b>一度アンインストールしてから</b>ダウンロードページの新しいアプリを入れてください。入れ直した後は、通知の設定をもう一度オンにしてください。</div>' +
    '<div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">' +
    '<button type="button" data-act="later" style="border:1px solid #ccc;background:#fff;border-radius:999px;padding:6px 14px;font-size:13px;">あとで</button>' +
    '<a href="/download.php" style="background:#b11e7c;color:#fff;border-radius:999px;padding:6px 16px;font-size:13px;font-weight:700;text-decoration:none;">ダウンロードページへ</a></div>';
  bar.querySelector('[data-act="later"]').addEventListener('click', () => {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { }
    bar.remove();
  });
  document.body.appendChild(bar);
}
if (isAndroidApp()) {
  let hasVersionApi = false;
  try { hasVersionApi = typeof window.MaiApp.getAppVersion === 'function'; } catch { }
  if (!hasVersionApi) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showLegacyAndroidAppNotice);
    else showLegacyAndroidAppNotice();
  }
}

if (!isAndroidApp() && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js')
    .then(reg => {
      console.log('[SW] registered:', reg.scope);
    })
    .catch(err => {
      console.error('[SW] register failed:', err);
    });
}
/* =========================
 * グローバル状態
 * ========================= */
let autoTimer = null;
let hasInitialHistoryLoaded = false;
let lastHistoryRefreshAt = 0;

let $logs = null;
let $status = null;

/* =========================
 * ユーティリティ
 * ========================= */
function areAllPlatformsDisabled(settings) {
  return Object.values(settings).every(v => !v);
}

function areAllPlatformsDisabledSafe() {
  try {
    return areAllPlatformsDisabled(getPlatformSettings());
  } catch {
    return true;
  }
}

/* =========================
 * 履歴更新（全体共有）
 * ========================= */
async function refreshHistory({ reason = 'manual', force = false } = {}) {
  if (!$logs || !$status) return;
  if (!hasInitialHistoryLoaded && !force) return;

  const now = Date.now();
  if (!force && (now - lastHistoryRefreshAt) < 1500) return;
  lastHistoryRefreshAt = now;

  if (force) clearJsonCache();

  fetchHistory($logs, $status, {
    append: false,
    useCache: !force
  });
}

/* =========================
 * ServiceWorker メッセージ
 * ========================= */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'NAVIGATE' && data.url) {
      window.location.href = data.url;
      return;
    }

    if (data.type === 'HISTORY_INVALIDATE') {
      if (document.visibilityState === 'visible') {
        refreshHistory({ reason: 'sw_invalidate', force: true });
      }
      return;
    }

    if (data.type === 'CLEAR_HISTORY_CACHE') {
      clearJsonCache();
      if (document.visibilityState === 'visible') {
        setTimeout(() => {
          refreshHistory({ reason: 'sw_clear_cache', force: true });
        }, 800);
      }
      return;
    }

    if (data.type === 'CLEAR_AND_RELOAD_HISTORY') {
      refreshHistory({ reason: 'sw_clear_and_reload', force: true });
    }
  });
}

/* =========================
 * DOM 初期化
 * ========================= */
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Main] 初期化開始');

  $logs = document.getElementById('logs');
  $status = document.getElementById('status');

  if (!$logs || !$status) {
    console.warn('[Main] 履歴UI要素が不足しているため履歴取得機能はスキップします');
  } else {
    /* === 初回履歴取得（最優先） === */
    if (!hasInitialHistoryLoaded) {
      hasInitialHistoryLoaded = true;
      fetchHistory($logs, $status, { append: false, useCache: true });
    }
  }

  /* =========================
   * ヘッダー依存UI初期化
   * ========================= */
  try {
    await initHeaderDependentUI();
  } catch (e) {
    console.warn('[Main] initHeaderDependentUI error', e);
  }

  const $toggleNotify = document.getElementById('toggle-notify');
  const $btnSendTest = document.getElementById('btn-send-test');
  const $autoRefreshCheckbox = document.getElementById('auto-refresh');

  /* =========================
   * プラットフォーム設定UI
   * ========================= */
  initPlatformSettingsUI($toggleNotify);

  const serverResult = await loadPlatformSettingsUIFromServer($toggleNotify);
  if (serverResult?.applied && serverResult.settings && $toggleNotify) {
    const anyOn = Object.values(serverResult.settings).some(Boolean);
    $toggleNotify.checked = anyOn;
    updatePlatformSettingsVisibility(anyOn);
    updateToggleImage();
  }

  initLogFilterSettings($toggleNotify);

  /* =========================
   * 購読者名UI
   * ========================= */
  let showLinked = () => { };
  try {
    const ui = await initSubscriberNameUI();
    if (ui?.showLinked) showLinked = ui.showLinked;
  } catch (e) {
    console.warn('[Main] 購読者名UI初期化エラー', e);
  }

  /* =========================
   * 通知トグル（Push / Android）
   * ========================= */
  if ($toggleNotify) {
    let enabled = false;
    const isAndroid = isAndroidApp();

    if (isAndroid) {
      try {
        enabled = !!window.MaiApp.isNotificationsEnabled();
      } catch {
        enabled = true;
      }
      showLinked(false);
    } else {
      try {
        const sw = await navigator.serviceWorker.ready;
        let sub = await sw.pushManager.getSubscription();

        if (!sub) {
          const raw = localStorage.getItem('pushSubscription');
          if (raw) {
            try { sub = JSON.parse(raw); } catch { }
          }
        }

        if (sub) {
          enabled = true;
          const serialized = sub.toJSON ? sub.toJSON() : sub;
          await sendSubscriptionToServer(serialized);
          localStorage.setItem('pushSubscription', JSON.stringify(serialized));
        }
      } catch { }
    }

    if (areAllPlatformsDisabledSafe()) {
      enabled = false;
      showLinked(false);
    }

    $toggleNotify.checked = enabled;
    updatePlatformSettingsVisibility(enabled);
    updateToggleImage();

    let processing = false;
    $toggleNotify.addEventListener('change', async () => {
      if (processing) return;
      processing = true;

      try {
        if (isAndroid) {
          if (typeof window.MaiApp.setNotificationsEnabled === 'function') {
            window.MaiApp.setNotificationsEnabled($toggleNotify.checked);
          }
          if ($toggleNotify.checked) {
            await savePlatformSettings();
          }
          showLinked(false);
        } else {
          if ($toggleNotify.checked) {
            // iOS: Web Push は「ホーム画面に追加したアプリ」でのみ使える（Apple 仕様・iOS 16.4+）。
            // 案内（ios-helper.js）を出さないと「トグルが戻るだけ」になり、
            // 利用者が理由を知れないままになる（2026-10-23 追加・以前は案内が未呼び出し）。
            const helper = window.iosHelper;
            if (helper && helper.isIOS) {
              if (helper.isIOSChrome) {
                alert("iOS の Chrome では通知登録はできません（ホーム画面追加も不可）。\nSafari でこのページを開いてから、もう一度お試しください。");
                throw new Error("IOS_CHROME_UNSUPPORTED");
              }
              if (!helper.isPWA) {
                helper.showInstallGuide();
                throw new Error("IOS_PWA_REQUIRED");
              }
            }
            await initPush();
            // message を空にすると alert が「理由が不明です」になる（サーバ保存失敗は最有力の失敗経路）
            if (!(await savePlatformSettings())) throw new Error("通知設定の保存に失敗しました");

            const input = document.getElementById('subscriber-name-input');
            const name = input?.value?.trim();
            if (name) await saveNameToServer(getClientId(), name);

            showLinked(true);
          } else {
            await unsubscribePush();
            showLinked(false);
          }
        }
      } catch (e) {
        $toggleNotify.checked = false;
        const reason = String((e && e.message) || "");
        // iOS の案内モーダルを出している二重表示は避ける
        if (reason === "IOS_PWA_REQUIRED" || reason === "IOS_CHROME_UNSUPPORTED") {
          console.warn("[push] 通知登録を中断:", reason);
        } else {
          // 失敗を無言にすると「押したのに何も起きない」になる（iPhone で実際に報告された挙動）
          console.error("[push] 通知登録に失敗:", e);
          alert("通知を登録できませんでした。\n" + (reason || "理由が不明です") +
            "\n\nもう一度お試しいただくか、ブラウザの通知許可設定を確認してください。");
        }
      } finally {
        updatePlatformSettingsVisibility($toggleNotify.checked);
        updateToggleImage();
        processing = false;
      }
    });
  }

  /* =========================
   * ボタン類
   * ========================= */
  document.getElementById('more-logs-button')
    ?.addEventListener('click', () => fetchHistoryMore($logs, $status));

  document.getElementById('btn-refresh')
    ?.addEventListener('click', () => refreshHistory({ force: true }));

  if ($btnSendTest) {
    $btnSendTest.addEventListener('click', async () => {
      $btnSendTest.disabled = true;
      await sendTestToMe();
      $btnSendTest.disabled = false;
    });
  }

  if ($autoRefreshCheckbox) {
    $autoRefreshCheckbox.addEventListener('change', e => {
      if (e.target.checked) {
        refreshHistory({ force: true });
        autoTimer = setInterval(() => refreshHistory({ force: true }), 30000);
      } else {
        clearInterval(autoTimer);
      }
    });
  }

  /* --- リンク設定保存 --- */
  const $btnSaveLinks = document.getElementById('btn-save-links');
  if ($btnSaveLinks) {
    $btnSaveLinks.addEventListener('click', async () => {
      if ($btnSaveLinks.disabled) return;
      $btnSaveLinks.disabled = true;
      const originalText = $btnSaveLinks.textContent;
      $btnSaveLinks.textContent = '保存中...';

      try {
        const success = await savePlatformSettings();
        if (success) {
          $btnSaveLinks.textContent = '保存完了！';
          setTimeout(() => {
            $btnSaveLinks.textContent = originalText;
            $btnSaveLinks.disabled = false;
            // パネルを閉じる
            const $btnLinkSettings = document.getElementById('btn-link-settings');
            const $linkSettingsContainer = document.getElementById('link-settings-container');
            if ($btnLinkSettings && $linkSettingsContainer) {
              $linkSettingsContainer.classList.remove('is-open');
              $btnLinkSettings.setAttribute('aria-expanded', 'false');
              $linkSettingsContainer.setAttribute('aria-hidden', 'true');
            }
            // 履歴の表示（リンク先）を更新のために再描画
            refreshHistory({ reason: 'links_updated', force: true });
          }, 1000);
        } else {
          $btnSaveLinks.textContent = '保存失敗';
          setTimeout(() => {
            $btnSaveLinks.textContent = originalText;
            $btnSaveLinks.disabled = false;
          }, 2000);
        }
      } catch (e) {
        console.error('Save links error:', e);
        $btnSaveLinks.textContent = 'エラー発生';
        setTimeout(() => {
          $btnSaveLinks.textContent = originalText;
          $btnSaveLinks.disabled = false;
        }, 2000);
      }
    });
  }

  /* =========================
   * visibility 復帰
   * ========================= */
  let backgroundSince = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      backgroundSince = Date.now();
    } else if (backgroundSince && Date.now() - backgroundSince > 1000) {
      refreshHistory({ force: true });
      backgroundSince = null;
    }
  });
});