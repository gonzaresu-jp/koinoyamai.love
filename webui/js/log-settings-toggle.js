
        const btn = document.getElementById('btn-log-settings');
        const menu = document.getElementById('log-settings-container');

        // このスクリプトは複数のページから読み込まれるが、
        // ログ設定のUI（btn-log-settings / log-settings-container）が
        // 存在しないページ（例: test.php）では何もしない。
        // 要素が null のまま addEventListener を呼ぶと TypeError になり、
        // そのページで読み込む他のスクリプトも止まるため（2026-10-21 実測）。
        if (!btn || !menu) return;

        btn.addEventListener('click', () => {
            const open = menu.classList.toggle('is-open');
            btn.setAttribute('aria-expanded', open);
            menu.setAttribute('aria-hidden', !open);
        });

        // メニュー外クリックで閉じる
        document.addEventListener('click', (e) => {
            if (!btn.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.remove('is-open');
                btn.setAttribute('aria-expanded', false);
                menu.setAttribute('aria-hidden', true);
            }
        });

    