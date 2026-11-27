// mai-voice.js - まいちゃん画像クリック時の吹き出し・音声再生・パララックス＆マウス微追従

(() => {
  const targets = document.querySelectorAll('.count-bg-mai');
  if (!targets.length) return;

  const ua = navigator.userAgent || '';
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|EdgiOS|FxiOS|OPiOS|Android/i.test(ua);
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const finePointer = window.matchMedia?.('(pointer: fine)').matches ?? false;
  const speed = (reduceMotion || isSafari) ? 0 : 0.35;
  const enableMouseFollow = !reduceMotion && finePointer;

  let hideTimer = 0;
  let currentAudio = null;

  // ===== 音声・文言・リンクの設定 =====
  // ここを差し替えるだけで編集できます
  const voiceItems = [
    { text: 'だーりん、まいのこと好きなの知ってるけど"好き"って言って💗', audio: '/voice/yt-2024-06-07-248.mp3', url: 'https://youtu.be/k7cXdJxCfkI?t=9934' },
    { text: '大好き、愛してるよ、大好き。',                               audio: '/voice/yt-2024-06-07-246.mp3', url: 'https://youtu.be/k7cXdJxCfkI?t=9977' },
    { text: 'お疲れ様、ここでゆっくり休んでいってね。',                   audio: '/voice/yt-2024-04-18-55.mp3',  url: 'https://youtu.be/0ZFg7zrMqVw?t=3353' },
  ];

  // ===== 吹き出しボタンの生成 =====
  const popup = document.createElement('button');
  popup.type = 'button';
  popup.className = 'mai-voice-popup';
  popup.setAttribute('aria-live', 'polite');
  popup.hidden = true;
  document.body.appendChild(popup);

  function pickRandomItem() {
    if (!voiceItems.length) return null;
    return voiceItems[Math.floor(Math.random() * voiceItems.length)];
  }

  function showPopup(item, triggerEl) {
    popup.textContent = item?.text ?? '';
    popup.dataset.url = item?.url ?? '';
    popup.classList.remove('is-open');
    popup.hidden = false;

    if (triggerEl) {
      const rect = triggerEl.getBoundingClientRect();
      const gap = -150; // imgの右端からどれだけ食い込ませるか（負値=左寄せ）
      const anchorY = rect.top + rect.height * 0.1; // 吹き出しの基準Y（imgの上寄り）

      popup.style.left = (rect.right + gap) + 'px';
      popup.style.right = 'auto';
      popup.style.top = '0';
      popup.style.bottom = 'auto';

      // 高さ取得後に縦位置を確定
      requestAnimationFrame(() => {
        const ph = popup.offsetHeight;
        let top = anchorY - ph / 2;
        top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
        popup.style.top = top + 'px';
        popup.classList.add('is-open');
      });
    } else {
      popup.style.left = '10%';
      popup.style.top = 'auto';
      popup.style.bottom = '24px';
      requestAnimationFrame(() => popup.classList.add('is-open'));
    }

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      popup.classList.remove('is-open');
      setTimeout(() => { popup.hidden = true; }, 240);
    }, 15000);
  }

  async function playVoice(item) {
    if (!item?.audio) return;
    try {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      }
      currentAudio = new Audio(item.audio);
      await currentAudio.play();
    } catch {
      // 再生失敗時は無音で続行
    }
  }

  // ===== スクロールパララックス ＋ PC マウス微追従（独立した transform 制御） =====
  let scrollY = 0;
  let targetMx = 0;
  let targetMy = 0;
  let targetRot = 0;
  let curMx = 0;
  let curMy = 0;
  let curRot = 0;
  let rafId = 0;

  function renderTransform() {
    rafId = 0;
    curMx += (targetMx - curMx) * 0.12;
    curMy += (targetMy - curMy) * 0.12;
    curRot += (targetRot - curRot) * 0.12;

    const totalY = (scrollY * speed) + curMy;
    const tx = curMx.toFixed(2);
    const ty = totalY.toFixed(2);
    const rot = curRot.toFixed(2);

    targets.forEach(img => {
      img.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(${rot}deg)`;
    });

    const settled =
      Math.abs(targetMx - curMx) < 0.05 &&
      Math.abs(targetMy - curMy) < 0.05 &&
      Math.abs(targetRot - curRot) < 0.02;

    if (!settled) {
      rafId = requestAnimationFrame(renderTransform);
    }
  }

  function scheduleRender() {
    if (!rafId) rafId = requestAnimationFrame(renderTransform);
  }

  function onScroll() {
    scrollY = window.scrollY || window.pageYOffset || 0;
    scheduleRender();
  }

  if (speed > 0 || enableMouseFollow) {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('load', onScroll);
  }

  if (enableMouseFollow) {
    window.addEventListener('pointermove', (e) => {
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const nx = (e.clientX / vw) * 2 - 1; // -1 .. 1
      const ny = (e.clientY / vh) * 2 - 1; // -1 .. 1
      targetMx = nx * 9;
      targetMy = ny * 6;
      targetRot = nx * 1.1;
      scheduleRender();
    }, { passive: true });

    document.addEventListener('pointerleave', () => {
      targetMx = 0;
      targetMy = 0;
      targetRot = 0;
      scheduleRender();
    });
  }

  // ===== クリックイベント =====
  targets.forEach(img => {
    img.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      const item = pickRandomItem();
      if (!item) return;
      showPopup(item, e.currentTarget);
      await playVoice(item);
    });
  });

  popup.addEventListener('click', () => {
    const url = popup.dataset.url;
    if (url) window.location.href = url;
  });

  if (speed > 0 || enableMouseFollow) onScroll();
})();
