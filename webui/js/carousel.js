// carousel.js - カルーセル制御（高さ可変・スワイプ・ドット）

const carousel = document.querySelector('.stats-carousel');
const inner = document.querySelector('.stats-carousel-inner');
const dotsWrap = document.querySelector('.carousel-dots');

if (!carousel || !inner || !dotsWrap) {
  console.warn('[carousel] required element missing');
}

let current = 0;
let startX = 0;
let startY = 0;
let tracking = false;

const pages = inner ? inner.querySelectorAll('.stats-page') : [];
const maxPage = pages.length - 1;
const threshold = 60;
const dots = [];

/** スライド位置・高さ・ドットをまとめて更新 */
function update() {
  if (!inner || !carousel) return;

  inner.style.transform = `translateX(calc(-${current * 100}% - ${current * 48}px))`;

  requestAnimationFrame(() => {
    const activePage = pages[current];
    if (activePage) {
      carousel.style.height = activePage.scrollHeight + 'px';
    }
  });

  dots.forEach((d, i) => d.classList.toggle('active', i === current));

  if (arrowPrev) arrowPrev.disabled = current === 0;
  if (arrowNext) arrowNext.disabled = current === maxPage;
}

/** ドットボタンと左右矢印を生成 */
let arrowPrev = null;
let arrowNext = null;

function initDots() {
  if (!dotsWrap) return;

  dotsWrap.innerHTML = '';
  dots.length = 0;

  // 左矢印
  arrowPrev = document.createElement('button');
  arrowPrev.type = 'button';
  arrowPrev.className = 'carousel-arrow carousel-arrow-prev';
  arrowPrev.setAttribute('aria-label', '前のスライドへ');
  arrowPrev.innerHTML = '<i class="fa-solid fa-angle-left" aria-hidden="true"></i>';
  arrowPrev.addEventListener('click', () => {
    if (current > 0) {
      current--;
      update();
    }
  });
  dotsWrap.appendChild(arrowPrev);

  // ドット
  for (let i = 0; i <= maxPage; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `スライド ${i + 1}`);
    b.addEventListener('click', () => {
      current = i;
      update();
    });
    dotsWrap.appendChild(b);
    dots.push(b);
  }

  // 右矢印
  arrowNext = document.createElement('button');
  arrowNext.type = 'button';
  arrowNext.className = 'carousel-arrow carousel-arrow-next';
  arrowNext.setAttribute('aria-label', '次のスライドへ');
  arrowNext.innerHTML = '<i class="fa-solid fa-angle-right" aria-hidden="true"></i>';
  arrowNext.addEventListener('click', () => {
    if (current < maxPage) {
      current++;
      update();
    }
  });
  dotsWrap.appendChild(arrowNext);
}

// ===== Touch swipe =====

carousel?.addEventListener('touchstart', e => {
  const t = e.touches[0];
  startX = t.clientX;
  startY = t.clientY;
  tracking = true;
}, { passive: true });

carousel?.addEventListener('touchmove', e => {
  if (!tracking) return;

  const t = e.touches[0];
  const dx = t.clientX - startX;
  const dy = t.clientY - startY;

  if (Math.abs(dy) > Math.abs(dx)) {
    tracking = false;
  }
}, { passive: true });

carousel?.addEventListener('touchend', e => {
  if (!tracking) return;
  tracking = false;

  const t = e.changedTouches[0];
  const dx = t.clientX - startX;

  if (Math.abs(dx) > threshold) {
    if (dx < 0 && current < maxPage) current++;
    if (dx > 0 && current > 0) current--;
  }

  update();
});

// ネイティブ側にジェスチャを奪われた時（WebView の親レイアウトが intercept した等）の
// 状態リセット。無いと tracking が残ったまま次の指上げで誤判定する
carousel?.addEventListener('touchcancel', () => {
  tracking = false;
});

// ===== Mouse swipe =====

let mouseDragging = false;

carousel?.addEventListener('mousedown', e => {
  startX = e.clientX;
  startY = e.clientY;
  mouseDragging = true;
  tracking = true;

  // テキスト選択防止
  document.body.style.userSelect = "none";
});

carousel?.addEventListener('mousemove', e => {
  if (!mouseDragging || !tracking) return;

  const dx = e.clientX - startX;
  const dy = e.clientY - startY;

  // 縦スクロール優先
  if (Math.abs(dy) > Math.abs(dx)) {
    tracking = false;
  }
});

window.addEventListener('mouseup', e => {
  if (!mouseDragging || !tracking) {
    mouseDragging = false;
    tracking = false;
    document.body.style.userSelect = "";
    return;
  }

  const dx = e.clientX - startX;

  if (Math.abs(dx) > threshold) {
    if (dx < 0 && current < maxPage) current++;
    if (dx > 0 && current > 0) current--;
  }

  mouseDragging = false;
  tracking = false;
  document.body.style.userSelect = "";

  update();
});

// 親パネルへの伝播遮断
['pointerdown', 'pointermove', 'pointerup', 'pointercancel']
  .forEach(type => {
    carousel?.addEventListener(type, e => e.stopPropagation());
  });

// ===== ResizeObserver（高さ自動追従） =====

if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => {
    update();
  });

  pages.forEach(p => ro.observe(p));
}

// ===== 初期化 =====

document.addEventListener('DOMContentLoaded', () => {
  initDots();
  setTimeout(update, 100);
});

window.addEventListener('load', update);
window.addEventListener('resize', update);