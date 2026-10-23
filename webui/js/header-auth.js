
    (function () {
        'use strict';

        async function initHeaderAuth() {
            const loading = document.getElementById('header-auth-loading');
            const loginBtn = document.getElementById('header-login-btn');
            const chip = document.getElementById('header-user-chip');
            const avatar = document.getElementById('header-avatar');
            const logoutItem = document.getElementById('nav-logout-item');
            const loginCta = document.getElementById('nav-login-cta');
            const logoutAvatar = document.getElementById('nav-logout-avatar');

            // アバター画像が読めないとき（Google のホスト不通・Googleアカウントに
            // プロフィール写真が無い・ファイル欠品など）は「壊れた画像アイコン」を
            // 出さず、デフォルトアバター → 非表示 に倒す
            function guardAvatar(img) {
                img.addEventListener('error', () => {
                    if (img.dataset.avatarFallback) {
                        img.style.visibility = 'hidden';
                        return;
                    }
                    img.dataset.avatarFallback = '1';
                    img.src = '/default-avatar.webp';
                });
            }
            if (avatar) guardAvatar(avatar);
            if (logoutAvatar) guardAvatar(logoutAvatar);

            try {
                const res = await fetch('/api/user/me', { credentials: 'include' });

                // 401 = 未ログイン（正常ケース）。throwせず下のcatchに流してログイン前表示へ
                if (!res.ok) {
                    window.__authUser = null;
                    chip.style.display = 'none';
                    loginBtn.style.display = 'flex';
                    logoutItem.style.display = 'none';
                    loginCta.style.display = 'block';
                    loading.style.display = 'none';
                    return;
                }

                const user = await res.json();

                avatar.src = user.avatar_url || '/default-avatar.webp';
                logoutAvatar.src = avatar.src;

                chip.style.display = 'flex';
                loginBtn.style.display = 'none';
                logoutItem.style.display = 'block';
                loginCta.style.display = 'none';
                loading.style.display = 'none';

                // auth-settings-bridge.js が参照するグローバル変数をセット
                window.__authUser = user;

                // ページ読み込みのたびに clientId を紐づけ（未紐づけの補完）
                const storedClientId = localStorage.getItem('clientId') || '';
                if (storedClientId) {
                    fetch('/api/user/link-subscription', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ client_id: storedClientId }),
                    }).catch(() => { });
                }

                // Androidアプリの場合は android_devices.user_id を紐づけ
                try {
                    const isAndroid = typeof window !== 'undefined'
                        && window.MaiApp
                        && typeof window.MaiApp.isAndroidApp === 'function'
                        && window.MaiApp.isAndroidApp();
                    if (isAndroid) {
                        const androidClientId = window.MaiApp.getAndroidClientId && window.MaiApp.getAndroidClientId();
                        const linkClientId = androidClientId || storedClientId;
                        if (linkClientId) {
                            fetch('/api/android/link-user', {
                                method: 'POST',
                                credentials: 'include',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ clientId: linkClientId })
                            }).catch(() => { });
                        }
                    }
                } catch { }

            } catch {
                chip.style.display = 'none';
                loginBtn.style.display = 'flex';
                logoutItem.style.display = 'none';
                loginCta.style.display = 'block';
                loading.style.display = 'none';

                window.__authUser = null;
            }
        }

        async function updateStatusIndicator() {
            const indicator = document.getElementById('header-status-indicator');
            if (!indicator) return;
            const dot = indicator.querySelector('.status-dot');
            try {
                // 1. スクレイパー状態の取得
                const res = await fetch('/api/scraper-status');
                if (!res.ok) throw new Error('status endpoint failed');
                const data = await res.json();
                const items = data.items || [];
                
                // 2. サーバーリソース状況の取得（高負荷時のステータス反映用）
                let sysData = null;
                try {
                    const sysRes = await fetch('/api/system-info');
                    if (sysRes.ok) sysData = await sysRes.json();
                } catch(e) { }

                let hasError = false;
                let hasWarning = false;
                let isRunning = false;

                // スクラッパー状態の評価
                if (items.length > 0) {
                    const effectiveItems = items.map(i => {
                        if (i.status !== 'running') return i;
                        const staleSec = (Date.now() - new Date(i.last_run).getTime()) / 1000;
                        return staleSec > 180 ? { ...i, status: 'success' } : i;
                    });
                    if (effectiveItems.some(i => i.status === 'error')) hasError = true;
                    if (effectiveItems.some(i => i.status === 'running')) isRunning = true;
                }

                // サーバーリソースの評価（70%で警告、90%以上でエラー扱い）
                if (sysData) {
                    const cpuUsage = sysData.cpu?.usagePercent || 0;
                    const memUsage = sysData.memory?.usagePercent || 0;
                    if (cpuUsage >= 90 || memUsage >= 95) hasError = true;
                    else if (cpuUsage >= 70 || memUsage >= 80) hasWarning = true;
                }

                dot.className = 'status-dot';
                if (hasError) dot.classList.add('error');
                else if (hasWarning) dot.classList.add('warning');
                else if (isRunning) dot.classList.add('running');
                else dot.classList.add('ok');

            } catch (e) {
                dot.className = 'status-dot'; // 通信エラー等はグレー（Unknown）
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            initHeaderAuth();
            updateStatusIndicator();
            setInterval(updateStatusIndicator, 60000); // 1分毎に更新
        });
    })();

    function headerLoginWithGoogle() {
        // config.js と同じキー名 'clientId' を使う
        const clientId = localStorage.getItem('clientId') || '';
        const returnTo = location.pathname + location.search;
        location.href =
            `/auth/google?client_id=${encodeURIComponent(clientId)}&returnTo=${encodeURIComponent(returnTo)}`;
    }

    async function headerLogout() {
        let clientId = localStorage.getItem('clientId') || localStorage.getItem('client_id') || '';
        try {
            const isAndroid = typeof window !== 'undefined'
                && window.MaiApp
                && typeof window.MaiApp.isAndroidApp === 'function'
                && window.MaiApp.isAndroidApp();
            if (isAndroid && window.MaiApp.getAndroidClientId) {
                clientId = window.MaiApp.getAndroidClientId() || clientId;
            }
        } catch { }

        await fetch('/auth/logout', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId })
        });
        location.reload();
    }
