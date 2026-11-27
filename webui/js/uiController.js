// uiController.js - UI制御とイベント処理（header.html を fetch 挿入しても壊れない版）
//
// 目的:
// - header が「後から DOM に挿入」されても、ハンバーガー/通知トグル/各ボタンが確実に動く
// - クリック/変更イベントは「イベントデリゲーション」で拾う（=挿入順に依存しない）
// - 「推し始め（日数）」も header 挿入後に初期化して確実に反映する
//
// 前提:
// - index.html 側で window.__layoutReady（header/footer 読み込み Promise）があるとさらに安定
//   例: window.__layoutReady = (async()=>{ await load('header-slot','/header.php'); ... })();

import {
  getPlatformSettings,
  savePlatformSettings,
  applySettingsToUI,
  loadPlatformSettingsUI,
  fetchPlatformSettingsFromServer,
} from "./settingsService.js?v=20260312d";

// =========================
// 共通ユーティリティ
// =========================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAndroidApp() {
  try {
    return typeof window !== 'undefined' && window.MaiApp && typeof window.MaiApp.isAndroidApp === 'function' && window.MaiApp.isAndroidApp();
  } catch {
    return false;
  }
}

async function waitForElement(selector, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(intervalMs);
  }
  return null;
}

function safeTextPrefix(label) {
  // "TwitCasting: ON" の "TwitCasting" を取り出す
  if (!label) return "";
  return String(label).split(":")[0].trim();
}

// =========================
// 画像トグル / 表示切替
// =========================
export function updateToggleImage() {
  const $toggleNotify = document.getElementById("toggle-notify");
  if (!$toggleNotify) return;

  document.body.classList.toggle("notifications-enabled", !!$toggleNotify.checked);
  document.body.classList.toggle("settings-on", !!$toggleNotify.checked);
}

export function updatePlatformSettingsVisibility(isChecked) {
  const $platformSettings = document.getElementById("platform-settings");
  if (!$platformSettings) return;

  if (isChecked) {
    $platformSettings.style.display = "block";
    $platformSettings.classList.remove("fade-out");
    $platformSettings.classList.add("fade-in");
  } else {
    $platformSettings.classList.remove("fade-in");
    $platformSettings.classList.add("fade-out");
    setTimeout(() => {
      $platformSettings.style.display = "none";
    }, 200);
  }
}

// =========================
// 推し始め（日数）
// =========================
function initOshiDays() {
  const STORAGE_KEY = "maistart_date";
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  const dateInput = document.getElementById("start"); // header 内
  const meetValueEl = document.getElementById("days-to-meet"); // main 内（表示先）
  const meetStatItem = meetValueEl?.closest?.(".stat-item");

  // 表示先が無いなら何もしない（壊さない）
  if (!meetValueEl || !meetStatItem) return;
  // header がまだ無いなら何もしない（呼び出し側で後から再試行する）
  if (!dateInput) return;

  function parseYMD(ymd) {
    if (!ymd) return null;
    const parts = String(ymd).split("-").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
  }
  function stripTime(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }
  function daysSinceLocal(date) {
    const now = stripTime(new Date()).getTime();
    const then = stripTime(date).getTime();
    return Math.max(0, Math.floor((now - then) / MS_PER_DAY));
  }
  function yearsMonthsSince(date) {
    const start = stripTime(date);
    const now = stripTime(new Date());
    if (now < start) return { years: 0, months: 0 };

    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    if (now.getDate() < start.getDate()) months -= 1;
    if (months < 0) {
      years -= 1;
      months += 12;
    }
    if (years < 0) return { years: 0, months: 0 };
    return { years, months };
  }
  function formatDaysWithYearsMonths(date) {
    const days = daysSinceLocal(date);
    const ym = yearsMonthsSince(date);
    return `${days}日(${ym.years}年${ym.months}ヶ月)`;
  }

  function applyFromStorageOrInput() {
    const stored = localStorage.getItem(STORAGE_KEY);
    let effective = stored || dateInput.value || null;

    if (!effective) {
      meetStatItem.style.display = "none";
      meetValueEl.textContent = "0 日";
      return;
    }

    const parsed = parseYMD(effective);
    if (!parsed) {
      meetStatItem.style.display = "none";
      return;
    }

    meetValueEl.textContent = formatDaysWithYearsMonths(parsed);
    meetStatItem.style.display = "";
    if (dateInput.value !== effective) dateInput.value = effective;
  }

  function save(value) {
    if (!value) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
    applyFromStorageOrInput();
  }

  // 初期反映
  applyFromStorageOrInput();

  // 変更反映
  dateInput.addEventListener("change", () => save(dateInput.value));

  // 日付跨ぎ対策（必要なら）
  // 0時をまたいだら表示更新したい場合は setInterval も可だが、ここでは軽量にする
}

// =========================
// ハンバーガーメニュー初期化
// =========================
// ハンバーガーメニュー初期化の修正版
function initHamburgerMenu() {
  const body = document.getElementById("app-body") || document.body;
  const toggle = document.getElementById("hamburger-toggle");
  const overlay = document.getElementById("menu-overlay");
  const navMenu = document.getElementById("nav-menu");

  if (!toggle || !overlay || !navMenu) {
    console.warn('[initHamburgerMenu] 必要な要素が見つかりません');
    return false;
  }

  // 二重バインド防止 - しかし、return前にログを出す
  if (toggle.dataset.bound === "1") {
    console.log('[initHamburgerMenu] 既にバインド済み');
    return true;
  }

  console.log('[initHamburgerMenu] ハンバーガーメニューを初期化中...');
  toggle.dataset.bound = "1";

  // 初回描画で transition が暴発するのを避ける（既存仕様踏襲）
  body.classList.add("menu-transitions-disabled");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      body.classList.remove("menu-transitions-disabled");
    });
  });

  function menuItems() {
    return document.querySelectorAll("#nav-menu > .nav-list > li");
  }

  function applyHamburgerSequentialFadeIn() {
    const items = menuItems();
    const delayIncrement = 32;
    items.forEach((item, index) => {
      const delay = Math.min(index * delayIncrement, 320);
      setTimeout(() => item.classList.add("is-faded-in"), delay);
    });
  }

  function toggleMenu(isOpen) {
    console.log('[toggleMenu] メニューを', isOpen ? '開く' : '閉じる');
    const items = menuItems();
    if (isOpen) {
      items.forEach((i) => i.classList.remove("is-faded-in"));
      body.classList.add("menu-open");
      toggle.setAttribute("aria-expanded", "true");
      overlay.style.display = "block";
      setTimeout(() => applyHamburgerSequentialFadeIn(), 120);
    } else {
      body.classList.remove("menu-open");
      toggle.setAttribute("aria-expanded", "false");
      overlay.style.display = "none";
      items.forEach((i) => i.classList.remove("is-faded-in"));
    }
  }

  // クリックイベントを登録
  toggle.addEventListener("click", (e) => {
    console.log('[hamburger-toggle] クリックイベント発火');
    e.preventDefault();
    e.stopPropagation();
    const isExpanded = toggle.getAttribute("aria-expanded") === "true";
    toggleMenu(!isExpanded);
  });

  overlay.addEventListener("click", () => {
    console.log('[menu-overlay] クリックイベント発火');
    toggleMenu(false);
  });

  console.log('[initHamburgerMenu] イベントリスナー登録完了');

  // 右端スワイプ（既存実装の移植：挿入順依存を排除）
  (function installRightEdgeSwipeMenu() {
    const EDGE_START = 270;
    const OPEN_THRESHOLD = 60;
    const CLOSE_THRESHOLD = 60;
    const MAX_VERTICAL_DELTA = 30;

    let pointerActive = false;
    let startX = 0, startY = 0;
    let trackingForOpen = false;
    let trackingForClose = false;

    function isMenuOpen() {
      return document.body.classList.contains("menu-open");
    }

    function onPointerDown(e) {

      if (e.target.closest('.stats-carousel')) return;

      const x = e.clientX || (e.touches && e.touches[0].clientX);
      const y = e.clientY || (e.touches && e.touches[0].clientY);

      startX = x;
      startY = y;
      pointerActive = true;
      trackingForOpen = false;
      trackingForClose = false;

      if (!isMenuOpen() && startX >= window.innerWidth - EDGE_START) {
        trackingForOpen = true;
      }

      if (isMenuOpen()) {
        const menu = document.getElementById("nav-menu");
        const ov = document.getElementById("menu-overlay");
        const target = e.target || (e.touches && e.touches[0].target);

        if (ov && ov.style.display !== "none" && ov.contains(target)) {
          trackingForClose = true;
        } else if (menu) {
          const r = menu.getBoundingClientRect();
          if (startX >= r.left && startX <= r.right && startY >= r.top && startY <= r.bottom) {
            trackingForClose = true;
          }
        }
      }
    }

    function onPointerMove(e) {

      if (e.target.closest('.stats-carousel, .carousel-dots')) return;

      if (!pointerActive) return;

      const x = e.clientX || (e.touches && e.touches[0].clientX);
      const y = e.clientY || (e.touches && e.touches[0].clientY);
      const dx = x - startX;
      const dy = y - startY;

      if (Math.abs(dy) > MAX_VERTICAL_DELTA) {
        trackingForOpen = false;
        trackingForClose = false;
        return;
      }

      if (trackingForOpen && dx < -OPEN_THRESHOLD) {
        toggleMenu(true);
        trackingForOpen = false;
        pointerActive = false;
        if (e.cancelable) e.preventDefault();
        return;
      }

      if (trackingForClose && dx > CLOSE_THRESHOLD) {
        toggleMenu(false);
        trackingForClose = false;
        pointerActive = false;
        if (e.cancelable) e.preventDefault();
        return;
      }
    }

    function onPointerUp() {
      pointerActive = false;
      trackingForOpen = false;
      trackingForClose = false;
    }

    if ("ontouchstart" in window) {
      document.addEventListener("touchstart", onPointerDown, { passive: true });
      document.addEventListener("touchmove", onPointerMove, { passive: false });
      document.addEventListener("touchend", onPointerUp, { passive: true });
      document.addEventListener("touchcancel", onPointerUp, { passive: true });
    } else if (window.PointerEvent) {
      document.addEventListener("pointerdown", onPointerDown, { passive: true });
      document.addEventListener("pointermove", onPointerMove, { passive: false });
      document.addEventListener("pointerup", onPointerUp, { passive: true });
      document.addEventListener("pointercancel", onPointerUp, { passive: true });
    }
  })();

  return true;
}

// =========================
// プラットフォーム設定（ボタン）
// - header が後挿入でも動くよう「デリゲーション」
// =========================
export function initPlatformSettingsUI($toggleNotify) {
  // 互換：呼び出し側が渡してこなくても取れるようにする
  const notifyToggle = document.getElementById("toggle-notify");

  // 二重バインド防止
  if (document.body.dataset.platformDelegationBound === "1") return;
  document.body.dataset.platformDelegationBound = "1";

  document.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("#platform-settings button.platform-setting-button");
    if (!btn) return;

    // UI 切り替え
    btn.classList.toggle("is-on");
    const prefix = safeTextPrefix(btn.textContent);
    btn.textContent = `${prefix}: ${btn.classList.contains("is-on") ? "ON" : "OFF"}`;

    // 保存（通知ON時のみサーバー保存、というあなたの仕様を踏襲）
    try {
      const nt = notifyToggle || document.getElementById("toggle-notify");
      if (nt?.checked) {
        await savePlatformSettings();
      }
    } catch (err) {
      console.error("[platform-settings] save error", err);
    }

    // フィルター連動（既存仕様）
    try {
      if (
        typeof window.syncFilterWithNotificationSettings === "function" &&
        typeof window.applyFilterSettingsToUI === "function" &&
        typeof window.saveFilterSettings === "function" &&
        typeof window.applyLogFiltering === "function"
      ) {
        const syncButton = document.getElementById("filter-sync-notification");
        if (syncButton?.classList.contains("is-on")) {
          const synced = window.syncFilterWithNotificationSettings();
          window.applyFilterSettingsToUI(synced);
          window.saveFilterSettings(synced);
          window.applyLogFiltering();
        }
      }
    } catch (err) {
      console.warn("[platform-settings] filter sync error", err);
    }
  });
}

// =========================
// サーバー/ローカルから設定を反映
// =========================
export async function loadPlatformSettingsUIFromServer() {
  const notifyToggle = document.getElementById("toggle-notify");

  if (isAndroidApp()) {
    const local = await loadPlatformSettingsUI();
    if (local.ok) {
      applySettingsToUI(local.settings);
      if (notifyToggle) {
        const anyOn = Object.values(local.settings).some((v) => !!v);
        notifyToggle.checked = anyOn;
        updatePlatformSettingsVisibility(anyOn);
        updateToggleImage();
      }
      return { applied: true, source: "android-local", settings: local.settings };
    }
  }

  try {
    let hasSubscription = false;
    try {
      if ("serviceWorker" in navigator && "PushManager" in window) {
        const sw = await navigator.serviceWorker.ready;
        const sub = await sw.pushManager.getSubscription();
        hasSubscription = !!sub;
      }
    } catch (e) {
      console.warn("[loadPlatformSettingsUIFromServer] subscription check error", e);
      hasSubscription = false;
    }

    if (!hasSubscription) {
      // subscription が無いならローカルのみ反映（既存仕様）
      const local = await loadPlatformSettingsUI();
      if (local.ok) {
        applySettingsToUI(local.settings);
        return { applied: true, source: "local", settings: local.settings };
      } else {
        if (notifyToggle) {
          notifyToggle.checked = false;
          updatePlatformSettingsVisibility(false);
          updateToggleImage();
        }
        return { applied: false, source: "none" };
      }
    }

    const res = await fetchPlatformSettingsFromServer();
    if (res && res.ok && res.settings) {
      applySettingsToUI(res.settings);
      if (notifyToggle) {
        const anyOn = Object.values(res.settings).some((v) => !!v);
        notifyToggle.checked = anyOn;
        updatePlatformSettingsVisibility(anyOn);
        updateToggleImage();
      }
      return { applied: true, source: "server", settings: res.settings };
    }

    const local = await loadPlatformSettingsUI();
    if (local.ok) {
      applySettingsToUI(local.settings);
      return { applied: true, source: "local", settings: local.settings };
    }

    if (notifyToggle) {
      notifyToggle.checked = false;
      updatePlatformSettingsVisibility(false);
      updateToggleImage();
    }
    return { applied: false, source: "none" };
  } catch (err) {
    console.error("[loadPlatformSettingsUIFromServer] unexpected error", err);
    if (notifyToggle) {
      notifyToggle.checked = false;
      updatePlatformSettingsVisibility(false);
      updateToggleImage();
    }
    return { applied: false, source: "error", error: String(err) };
  }
}

// =========================
// 通知トグル（header後挿入でも動く）
// =========================
function initNotifyToggleHandlers() {
  const toggle = document.getElementById("toggle-notify");
  if (!toggle) return false;

  if (toggle.dataset.bound === "1") return true;
  toggle.dataset.bound = "1";

  toggle.addEventListener("change", async () => {
    updateToggleImage();
    updatePlatformSettingsVisibility(toggle.checked);

    // 「通知を受信する」を OFF にした時の挙動はあなたの設計次第だが
    // ここでは UI だけ確実に閉じる（サーバー保存はしない）
    // ON の時は、別処理（pushService 等）が subscription を作る想定
  });

  // 初期反映
  setTimeout(() => {
    updateToggleImage();
    updatePlatformSettingsVisibility(toggle.checked);
  }, 0);

  return true;
}

// =========================
// header/footer fetch 挿入環境向けの「確実な初期化」
// =========================
export async function initHeaderDependentUI() {
  // 1) layoutReady があるなら待つ（header が無い状態で bind して死ぬのを防ぐ）
  try {
    if (window.__layoutReady && typeof window.__layoutReady.then === "function") {
      await window.__layoutReady;
    }
  } catch (e) {
    console.warn("[uiController] __layoutReady failed", e);
  }

  // 2) それでも念のため、header要素待ち
  await waitForElement("#nav-menu");
  await waitForElement("#hamburger-toggle");
  await waitForElement("#menu-overlay");

  // 3) 初期化（全て「二重バインド防止」済み）
  initHamburgerMenu();
  initNotifyToggleHandlers();
  initPlatformSettingsUI(document.getElementById("toggle-notify"));

  // 4) 推し始め（日数）
  // header の input#start が存在する前に initOshiDays が走ると無効化されるので、ここで確実に呼ぶ
  initOshiDays();
}

// ハンバーガーメニューのロック制御
export function lockHamburger(lock) {
  const btn = document.getElementById("hamburger-toggle");
  if (!btn) return;

  btn.classList.toggle("is-locked", !!lock);
  btn.setAttribute("aria-disabled", lock ? "true" : "false");
}

// =========================
// 既存コード互換：window 公開（必要なら）
// =========================
window.updateToggleImage = updateToggleImage;
window.getPlatformSettings = getPlatformSettings;
window.initHeaderDependentUI = initHeaderDependentUI;


