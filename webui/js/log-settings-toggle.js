// log-settings-toggle.js - ログ設定（リンク先カスタム設定）メニューの開閉
//
// このスクリプトは複数のページから読み込まれるが、ログ設定の UI
// （btn-log-settings / log-settings-container）が存在しないページ（例: test.php）もある。
// 要素が無いときは何もしない（2026-10-21 実測: 要素が null のまま
// addEventListener を呼ぶと TypeError になり、そのページで読み込む
// 他のスクリプトも止まっていた）。
//
// ※ トップレベルの `return` はスクリプト文法エラー（Illegal return statement）になるため、
//   IIFE で囲んでから return する。
(function () {
    const btn = document.getElementById('btn-log-settings');
    const menu = document.getElementById('log-settings-container');
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
})();
