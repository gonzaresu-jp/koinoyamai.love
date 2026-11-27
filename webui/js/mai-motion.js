// mai-motion.js - 統一ブラーフェードイン・スクロールリビール・ページ上部へ戻るボタン（全ページ共通）

(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const prefersReducedMotion = () =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  /**
   * スクロール連動ブラーリビール（画面外の要素のみ対象にし、ファーストビューを隠さない）
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
   * ページ上部へ戻るボタン（今後専用素材へ差し替え予定・現在は Font Awesome 矢印のみ）
   */
  function initScrollTopButton() {
    if (document.querySelector('.mai-scroll-top')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mai-scroll-top';
    btn.setAttribute('aria-label', 'ページ上部へ戻る');
    btn.title = 'ページ上部へ戻る';
    btn.innerHTML = '<i class="fa-solid fa-arrow-up" aria-hidden="true"></i>';

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
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    });
  }

  function initAll() {
    initScrollReveal();
    initScrollTopButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
