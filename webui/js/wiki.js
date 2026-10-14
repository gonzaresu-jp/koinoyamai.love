(() => {
  "use strict";

  // 目次のスクロールスパイ（記事本文は静的・API依存なし）
  function setupScrollSpy() {
    const links = [...document.querySelectorAll(".wk-toc-list a")];
    const sections = links
      .map((a) => document.getElementById(a.getAttribute("href").slice(1)))
      .filter(Boolean);
    if (!sections.length || !("IntersectionObserver" in window)) return;

    const visible = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        let bestId = null;
        let bestRatio = 0;
        for (const [id, ratio] of visible) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = id;
          }
        }
        if (!bestId) return;
        links.forEach((a) => a.classList.toggle("is-active", a.getAttribute("href") === "#" + bestId));
      },
      { rootMargin: "-76px 0px -55% 0px", threshold: [0, 0.1, 0.5, 1] }
    );
    sections.forEach((s) => observer.observe(s));
    links[0]?.classList.add("is-active");
  }

  // ---- 衣装画像のライトボックス
  // メディアアーカイブ／通知履歴と共通の #media-lightbox を使う。
  // 背景クリック・右上×・Esc で閉じる／ホールで拡大・ドラッグで移動（慣性つき）・
  // ダブルクリックで1↔3倍・ピンチズーム対応。
  let zoomState = null;
  let lbLastFocus = null;

  function resetZoomState() {
    if (zoomState && zoomState.momentumRaf) cancelAnimationFrame(zoomState.momentumRaf);
    zoomState = null;
  }

  function setupZoomPan(mediaEl) {
    if (!mediaEl || mediaEl.tagName === "VIDEO") return;
    mediaEl.style.transformOrigin = "0 0";
    mediaEl.style.willChange = "transform";
    zoomState = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, vx: 0, vy: 0, history: [], momentumRaf: 0 };

    function apply() {
      if (!zoomState || !mediaEl) return;
      mediaEl.style.transform = zoomState.scale > 1
        ? `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`
        : "";
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
      if (zoomState && zoomState.momentumRaf) {
        cancelAnimationFrame(zoomState.momentumRaf);
        zoomState.momentumRaf = 0;
      }
      if (zoomState) { zoomState.vx = 0; zoomState.vy = 0; }
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
      mediaEl.style.cursor = "grabbing";
      e.preventDefault();
    }

    function onMove(e) {
      if (!zoomState || !zoomState.dragging) return;
      zoomState.x = e.clientX - zoomState.startX;
      zoomState.y = e.clientY - zoomState.startY;
      zoomState.history.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      if (zoomState.history.length > 10) zoomState.history.shift();
      apply();
    }

    function onUp() {
      if (!zoomState) return;
      zoomState.dragging = false;
      if (mediaEl) mediaEl.style.cursor = zoomState.scale > 1 ? "grab" : "";
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
      if (mediaEl) mediaEl.style.cursor = zoomState.scale > 1 ? "grab" : "";
      apply();
    }

    // --- タッチ（モバイル）: ドラッグ移動＋ピンチズーム ---
    let touchId = null;
    let pinchDist = 0;
    const lb = document.getElementById("media-lightbox");
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

    lb.style.touchAction = "none";
    mediaEl.addEventListener("wheel", onWheel, { passive: false });
    mediaEl.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    mediaEl.addEventListener("dblclick", onDbl);
    lb.addEventListener("touchstart", onTouchStart, { passive: false });
    lb.addEventListener("touchmove", onTouchMove, { passive: false });
    lb.addEventListener("touchend", onTouchEnd, { passive: false });
    lb.addEventListener("touchcancel", onTouchEnd, { passive: false });
  }

  function openLightbox(src, cap) {
    const lb = document.getElementById("media-lightbox");
    const content = document.getElementById("lightbox-content");
    if (!lb || !content) return;
    resetZoomState();
    // Android WebViewはvh単位が0として計算される既知の不具合があるためpxで指定
    const maxW = Math.round(window.innerWidth * 0.9);
    const maxH = Math.round(window.innerHeight * 0.85);
    content.style.maxWidth = maxW + "px";
    content.style.maxHeight = maxH + "px";
    const safeSrc = String(src).replace(/"/g, "&quot;");
    content.innerHTML = `<img src="${safeSrc}" style="max-width:${maxW}px;max-height:${maxH}px;object-fit:contain;"><div class="media-lightbox-info"></div>`;
    const info = content.querySelector(".media-lightbox-info");
    if (info) info.textContent = cap || "";
    const img = content.querySelector("img");
    if (img) {
      img.addEventListener("error", () => {
        content.innerHTML = `<div class="lightbox-error">画像を読み込めませんでした<br><a href="${safeSrc}" target="_blank" rel="noopener">別タブで開く</a></div>`;
      }, { once: true });
    }
    lbLastFocus = document.activeElement;
    lb.classList.add("is-open");
    document.body.classList.add("lightbox-open");
    setupZoomPan(content.querySelector("img"));
    const closeBtn = document.getElementById("lightbox-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeLightbox() {
    const lb = document.getElementById("media-lightbox");
    const content = document.getElementById("lightbox-content");
    if (!lb || !lb.classList.contains("is-open")) return;
    lb.classList.remove("is-open");
    lb.style.touchAction = "";
    document.body.classList.remove("lightbox-open");
    if (content) content.innerHTML = "";
    resetZoomState();
    if (lbLastFocus && typeof lbLastFocus.focus === "function") lbLastFocus.focus();
    lbLastFocus = null;
  }

  function initLightbox() {
    const el = document.getElementById("media-lightbox");
    if (el && el.parentNode !== document.body) document.body.appendChild(el);
    // Android WebViewはbackdrop-filterのGPU合成が不安定
    try {
      const isAndroid = !!(window.MaiApp && typeof window.MaiApp.isAndroidApp === "function" && window.MaiApp.isAndroidApp());
      if (el && isAndroid) el.classList.add("no-blur");
    } catch {}
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  document.addEventListener("click", (e) => {
    const lb = document.getElementById("media-lightbox");
    if (lb && lb.classList.contains("is-open")) {
      if (e.target === lb || (e.target && e.target.closest && e.target.closest("#lightbox-close"))) {
        closeLightbox();
        return;
      }
    }
    if (!e.target || typeof e.target.closest !== "function") return;
    const a = e.target.closest(".wk-costume-gallery a");
    if (a) {
      e.preventDefault();
      const img = a.querySelector("img");
      const fig = a.closest("figure");
      const capEl = fig && fig.querySelector("figcaption");
      const cap = (capEl && capEl.textContent) || (img && img.getAttribute("alt")) || "";
      openLightbox(a.getAttribute("href"), cap);
    }
  });

  // YouTube アーカイブへのテキストリンク → リンク位置の近くにサムネ＋タイトルのポップアップ
  // （配信スケジュールのカードのような体験）。カード表示(.wk-video-card)とチャンネルは対象外。
  // タイトルは YouTube oEmbed (CORS許可) から実行時取得し videoId 単位でキャッシュ。
  function setupStreamPopups() {
    let pop = null;
    const titleCache = Object.create(null);

    function extractVideoId(href) {
      try {
        const u = new URL(href, location.href);
        if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
        if (!/^(www\.)?youtube\.com$/.test(u.hostname)) return null;
        const v = u.searchParams.get("v");
        if (v) return v;
        const m = u.pathname.match(/^\/(?:live|embed)\/([A-Za-z0-9_-]{6,})/);
        return m ? m[1] : null;
      } catch (e) {
        return null;
      }
    }

    function ensurePop() {
      if (pop) return pop;
      pop = document.createElement("div");
      pop.className = "wk-sm-pop";
      pop.innerHTML =
        '<div class="wk-sm-card" role="dialog" aria-label="動画プレビュー">' +
        '<button class="wk-sm-close" type="button" aria-label="閉じる">&times;</button>' +
        '<div class="wk-sm-thumb"><img alt="" referrerpolicy="no-referrer"></div>' +
        '<div class="wk-sm-body">' +
        '<p class="wk-sm-title"></p>' +
        '<p class="wk-sm-channel"></p>' +
        '<p class="wk-sm-hint">クリックで YouTube を開く</p>' +
        "</div></div>";
      document.body.appendChild(pop);
      return pop;
    }

    function hidePop() {
      if (!pop || !pop.classList.contains("is-open")) return;
      pop.classList.remove("is-open");
      pop._url = "";
      pop._videoId = "";
    }

    function positionPop(link) {
      const r = link.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const pw = Math.min(360, Math.max(240, vw - 24));
      pop.style.width = pw + "px";
      pop.style.left = "0px";
      pop.style.top = "0px";
      pop.style.bottom = "auto";
      let left = r.left;
      if (left + pw > vw - 12) left = vw - pw - 12;
      if (left < 12) left = 12;
      pop.style.left = Math.round(left) + "px";
      const ph = pop.offsetHeight || 260;
      const below = r.bottom + 8;
      if (below + ph <= window.innerHeight - 12) {
        pop.style.top = Math.round(below) + "px";
      } else if (r.top - 8 - ph >= 12) {
        pop.style.top = "auto";
        pop.style.bottom = Math.round(window.innerHeight - r.top + 8) + "px";
      } else {
        pop.style.top = Math.round(Math.max(12, Math.min(below, window.innerHeight - ph - 12))) + "px";
      }
    }

    function openPop(link, videoId) {
      const p = ensurePop();
      p._url = link.href;
      p._videoId = videoId;
      const img = p.querySelector(".wk-sm-thumb img");
      img.src = "https://img.youtube.com/vi/" + encodeURIComponent(videoId) + "/hqdefault.jpg";
      img.alt = "";
      const titleEl = p.querySelector(".wk-sm-title");
      const chEl = p.querySelector(".wk-sm-channel");
      const cached = titleCache[videoId];
      if (cached) {
        titleEl.textContent = cached.title;
        chEl.textContent = cached.author;
      } else {
        titleEl.textContent = "読み込み中…";
        chEl.textContent = "";
        const ep = "https://www.youtube.com/oembed?format=json&url=" +
          encodeURIComponent("https://www.youtube.com/watch?v=" + videoId);
        let opts = {};
        try { opts = { signal: AbortSignal.timeout(6000) }; } catch (e) {}
        fetch(ep, opts)
          .then((res) => (res && res.ok ? res.json() : null))
          .then((d) => {
            if (!d || !pop || pop._videoId !== videoId) return;
            titleCache[videoId] = { title: d.title || "", author: d.author_name || "" };
            titleEl.textContent = d.title || "YouTube 動画";
            chEl.textContent = d.author_name || "";
          })
          .catch(() => {
            if (pop && pop._videoId === videoId && titleEl.textContent === "読み込み中…") {
              titleEl.textContent = "YouTube 動画";
            }
          });
      }
      p.classList.add("is-open");
      positionPop(link);
    }

    document.addEventListener("click", (e) => {
      if (!e.target || typeof e.target.closest !== "function") return;
      const inPop = pop && pop.classList.contains("is-open") && e.target.closest(".wk-sm-pop");
      if (pop && pop.classList.contains("is-open") && !inPop) hidePop();
      if (inPop) {
        if (e.target.closest(".wk-sm-close")) {
          hidePop();
          return;
        }
        if (e.target.closest(".wk-sm-card") && pop._url) {
          window.open(pop._url, "_blank", "noopener");
          hidePop();
        }
        return;
      }
      const link = e.target.closest("a[href]");
      if (!link || link.closest(".wk-video-card")) return;
      const videoId = extractVideoId(link.href);
      if (!videoId) return;
      // 修飾キー付きクリック（新規タブ・コピー等）は既定動作のまま
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      openPop(link, videoId);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hidePop();
    });
    window.addEventListener("scroll", hidePop, { passive: true });
    window.addEventListener("resize", hidePop, { passive: true });
  }

  initLightbox();
  setupScrollSpy();
  setupStreamPopups();
})();
