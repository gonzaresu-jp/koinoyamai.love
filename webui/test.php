<!doctype html>
<html lang="ja">

<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>テスト完了！</title>
    <link rel="icon" href="/icon.webp">
    <?php
    include __DIR__ . '/head.php';
    ?>


    <script src="https://unpkg.com/@lottiefiles/lottie-player@2.0.2/dist/lottie-player.js"></script>
    <link rel="stylesheet" href="/css/test.css?v=<?= @filemtime(__DIR__ . '/css/test.css') ?: time() ?>" />
</head>

<body id="app-body">
    <section id="header-slot">
        <?php include __DIR__ . '/header.php'; ?>
    </section>

    <main style="padding-right: 0; padding-left: 0;">
        <div id="animation-container">
        </div>

        <div id="animation-container-other">
            <picture>
                <source srcset="/mai.avif" type="image/avif">
                <source srcset="mai.png" type="image/png">
                <img src="mai.gif" alt="透過アニメーション">
            </picture>
        </div>

        <a href="/" style="text-decoration:none; color:inherit; display:block;">
            <div style="
                background-color:#FFF;
                margin:40px;
                min-height:60px;
                display:flex;
                align-items:center;
                justify-content:center;
                padding:10px 20px;">
                <h3 style="margin:0;">通知ダッシュボードに戻る</h3>
            </div>
        </a>
    </main>

    <section id="footer-slot">
        <?php include __DIR__ . '/footer.php'; ?>
    </section>
    <script src="/js/test-notification-anim.js?v=<?= @filemtime(__DIR__ . '/js/test-notification-anim.js') ?: time(); ?>"></script>
    <script src="/js/test-webgl.js?v=<?= @filemtime(__DIR__ . '/js/test-webgl.js') ?: time(); ?>"></script>
    <!-- iOS Helper を main.js より先に読み込む -->
    <script src="/ios-helper.js" defer></script>
    <script type="module" src="/dist/main.bundle.min.js" defer></script>
    <script src="/js/log-settings-toggle.js?v=<?= @filemtime(__DIR__ . '/js/log-settings-toggle.js') ?: time(); ?>"></script>
    <script src="/js/page-fade-sw.js?v=<?= @filemtime(__DIR__ . '/js/page-fade-sw.js') ?: time(); ?>"></script>

    <script src="/js/test-oshidays.js?v=<?= @filemtime(__DIR__ . '/js/test-oshidays.js') ?: time(); ?>"></script>
    <script src="/js/page-fade-sw.js?v=<?= @filemtime(__DIR__ . '/js/page-fade-sw.js') ?: time(); ?>"></script>
</body>

</html>