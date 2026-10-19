<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>揺れるまいちゃん</title>
    <link rel="icon" href="/icon.webp">
    <link rel="stylesheet" href="/style.min.css" />
  <link rel="stylesheet" href="/css/wave.css" />
</head>
<body id="app-body" class="menu-transitions-disabled">
<div id="header-slot">
        <?php include __DIR__ . '/header.php'; ?>
    </div>


<!-- iOS Helper を main.js より先に読み込む -->
    <script src="/ios-helper.js" defer></script>
    <script type="module" src="/js/main.js" defer></script>
    <!-- wave-log-settings.js は index.php のログ設定ボタン用のため本頁では読み込まない -->
    <script src="/js/wave-oshidays.js?v=20260926"></script>
<script src="/js/wave-page-fade.js?v=20260926"></script>
<script type="module" src="/js/wave-layout.js?v=20260926"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pixi.js/7.4.0/pixi.min.js"></script>
<script src="/js/wave-pixi.js?v=20260926"></script>
<div id="footer-slot">
        <?php include __DIR__ . '/footer.php'; ?>
    </div>
</body>
</html>