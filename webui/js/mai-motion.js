// mai-motion.js - 統一ブラーフェードイン・スクロールリビール・まいちゃん演出（全ページ共通）

(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const prefersReducedMotion = () =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const SYMBOLS = ['♥', '✦', '♡', '✧', '♥'];
  const COLORS = ['#d63398', '#B11E7C', '#f062b0', '#9b6bff', '#f59e0b'];

  /**
   * クリック／イベント地点からハート・きらめきパーティクルをふわっと飛ばす
   */
  function spawnMaiParticles(x, y, { count = 7, spreadX = 68, spreadY = 64, sizeMin = 12, sizeMax = 18 } = {}) {
    if (prefersReducedMotion()) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const el = document.createElement('span');
      el.className = 'mai-particle';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = SYMBOLS[i % SYMBOLS.length];

      const angle = (-Math.PI / 2) + ((i / Math.max(1, count - 1)) - 0.5) * 1.9 + (Math.random() - 0.5) * 0.4;
      const distX = Math.cos(angle) * (spreadX * (0.45 + Math.random() * 0.7));
      const distY = Math.sin(angle) * (spreadY * (0.55 + Math.random() * 0.65)) - 14;
      const size = Math.round(sizeMin + Math.random() * (sizeMax - sizeMin));
      const dur = (0.72 + Math.random() * 0.36).toFixed(2);
      const rot = Math.round((Math.random() - 0.5) * 52);

      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.setProperty('--dx', `${distX.toFixed(1)}px`);
      el.style.setProperty('--dy', `${distY.toFixed(1)}px`);
      el.style.setProperty('--p-size', `${size}px`);
      el.style.setProperty('--p-color', COLORS[Math.floor(Math.random() * COLORS.length)]);
      el.style.setProperty('--p-dur', `${dur}s`);
      el.style.setProperty('--rot', `${rot}deg`);

      el.addEventListener('animationend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 1400);
      frag.appendChild(el);
    }
    document.body.appendChild(frag);
  }

  // mai-voice.js などスタンドアロンスクリプトからも共有利用できるように公開
  window.spawnMaiParticles = spawnMaiParticles;

  /**
   * 1) スクロール連動ブラーリビール（画面外の要素のみ対象にし、ファーストビューを隠さない）
   */
  function initScrollReveal() {
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') return;

    const selector = [
      '.dl-card',
      '.dl-req-card',
      '.dl-help-card',
      '.dl-pwa-callout',
      '.logs-timeline .log-card:not(.hidden-log)',
      '.service-intro',
      '.future-section',
    ].join(', ');

    const nodes = Array.from(document.querySelectorAll(selector));
    if (!nodes.length) return;

    const foldY = window.innerHeight * 0.96;
    const targets = nodes.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && rect.top > foldY;
    });
    if (!targets.length) return;

    targets.forEach((el, idx) => {
      el.classList.add('mai-reveal');
      el.style.transitionDelay = `${Math.min((idx % 3) * 60, 120)}ms`;
    });

    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-revealed');
        // 完了後に delay を戻してホバー等に影響させない
        setTimeout(() => { entry.target.style.transitionDelay = ''; }, 700);
        io.unobserve(entry.target);
      });
    }, {
      rootMargin: '0px 0px -24px 0px',
      threshold: 0.04,
    });

    targets.forEach(el => io.observe(el));
  }

  /**
   * 3) 通知 ON/OFF トグルでまいちゃんが「ぴょん！」＋キラキラ、テスト送信・コピーでハート演出
   */
  function initToggleAndButtonDelight() {
    const toggle = document.getElementById('toggle-notify');
    const container = document.querySelector('.toggle-image-container');

    if (toggle && container) {
      let animTimer = 0;
      toggle.addEventListener('change', (e) => {
        // ユーザー操作（またはメニューが開いている状態）のみ演出
        if (!e.isTrusted && !document.body.classList.contains('menu-open')) return;

        container.classList.remove('is-joy', 'is-shy');
        void container.offsetWidth;

        if (toggle.checked) {
          container.classList.add('is-joy');
          const rect = container.getBoundingClientRect();
          if (rect.width > 0) {
            spawnMaiParticles(rect.left + rect.width * 0.5, rect.top + rect.height * 0.35, {
              count: 7,
              spreadX: 56,
              spreadY: 48,
              sizeMin: 11,
              sizeMax: 16,
            });
          }
        } else {
          container.classList.add('is-shy');
        }

        clearTimeout(animTimer);
        animTimer = setTimeout(() => {
          container.classList.remove('is-joy', 'is-shy');
        }, 700);
      });
    }

    // テスト通知ボタンクリックでふわっとハート
    const testBtn = document.getElementById('btn-send-test');
    if (testBtn) {
      testBtn.addEventListener('click', () => {
        const rect = testBtn.getBoundingClientRect();
        spawnMaiParticles(rect.left + rect.width * 0.5, rect.top + rect.height * 0.4, {
          count: 5,
          spreadX: 60,
          spreadY: 44,
          sizeMin: 11,
          sizeMax: 15,
        });
      });
    }

    // カウントのコピーボタンクリックで小さなハート
    document.addEventListener('click', (e) => {
      const copyBtn = e.target.closest?.('.stat-copy-btn');
      if (!copyBtn) return;
      const rect = copyBtn.getBoundingClientRect();
      spawnMaiParticles(rect.left + rect.width * 0.5, rect.top + rect.height * 0.3, {
        count: 3,
        spreadX: 34,
        spreadY: 32,
        sizeMin: 10,
        sizeMax: 13,
      });
    });
  }

  /**
   * 4) ヘッダーのまいちゃんアイコン（icon.webp）のさりげない仕草＆稼働オーラ連動
   */
  function initHeaderIconCharm() {
    const logo = document.querySelector('.header-left img.logo');
    if (!logo) return;

    // クリックで小さなハートが飛ぶちょっとした遊び心
    logo.addEventListener('click', () => {
      const rect = logo.getBoundingClientRect();
      spawnMaiParticles(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5, {
        count: 5,
        spreadX: 44,
        spreadY: 38,
        sizeMin: 10,
        sizeMax: 14,
      });
    });

    // ステータスドットが ok のときは淡いローズオーラを付与
    const dot = document.querySelector('#header-status-indicator .status-dot');
    if (!dot) return;

    const syncGlow = () => {
      logo.classList.toggle('is-live-glow', dot.classList.contains('ok'));
    };
    syncGlow();

    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(syncGlow);
      mo.observe(dot, { attributes: true, attributeFilter: ['class'] });
    }
  }

  /**
   * 5) スクロールするとひょっこり現れる「まいちゃんトップへ戻るボタン」
   */
  function initMaiScrollTop() {
    if (document.querySelector('.mai-scroll-top')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mai-scroll-top';
    btn.setAttribute('aria-label', 'ページ上部へ戻る');
    btn.title = 'ページ上部へ戻る';
    btn.innerHTML =
      '<img src="/icon.webp" alt="" class="mai-scroll-top-img" width="44" height="44" loading="lazy" decoding="async" />' +
      '<span class="mai-scroll-top-badge" aria-hidden="true"><i class="fa-solid fa-chevron-up"></i></span>';

    document.body.appendChild(btn);

    let ticking = false;
    const updateVisibility = () => {
      const y = window.scrollY || window.pageYOffset || 0;
      btn.classList.toggle('is-visible', y > 320);
      ticking = false;
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(updateVisibility);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    updateVisibility();

    btn.addEventListener('click', () => {
      const rect = btn.getBoundingClientRect();
      spawnMaiParticles(rect.left + rect.width * 0.5, rect.top + rect.height * 0.3, {
        count: 5,
        spreadX: 46,
        spreadY: 46,
        sizeMin: 11,
        sizeMax: 15,
      });
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    });
  }

  function initAll() {
    initScrollReveal();
    initToggleAndButtonDelight();
    initHeaderIconCharm();
    initMaiScrollTop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
