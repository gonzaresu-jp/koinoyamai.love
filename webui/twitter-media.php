<!doctype html>
<html lang="ja">

<head>
<?php
$pageTitle = "恋乃夜まい メディアアーカイブ";
$pageDesc = "恋乃夜まい（まいちゃん）のX（Twitter）投稿に添付された画像・動画メディアを一覧で振り返れるメディアアーカイブページです。";
$extraHead = '<link rel="stylesheet" href="/css/twitter-media.css?v=' . @filemtime(__DIR__ . '/css/twitter-media.css') . '" />';
include __DIR__ . '/head.php';
?>
</head>

<body id="app-body">
  <div id="header-slot">
    <?php include __DIR__ . '/header.php'; ?>
  </div>

  <main>
    <div class="media-page">
      <h1 class="media-page-title"><i class="fa-brands fa-x-twitter"></i> メディアアーカイブ</h1>

      <!-- 統計 -->
      <div class="media-stats" id="media-stats">
        <div class="media-stat-card">
          <div class="media-stat-value" id="stat-total">-</div>
          <div class="media-stat-label">総メディア数</div>
        </div>
        <div class="media-stat-card">
          <div class="media-stat-value" id="stat-images">-</div>
          <div class="media-stat-label">画像</div>
        </div>
        <div class="media-stat-card">
          <div class="media-stat-value" id="stat-videos">-</div>
          <div class="media-stat-label">動画</div>
        </div>
        <div class="media-stat-card">
          <div class="media-stat-value" id="stat-size">-</div>
          <div class="media-stat-label">合計サイズ</div>
        </div>
      </div>

      <!-- フィルター -->
      <div class="media-filter-tabs">
        <button class="media-filter-btn is-active" data-filter="all">すべて</button>
        <button class="media-filter-btn" data-filter="image"><i class="fa-solid fa-image"></i> 画像</button>
        <button class="media-filter-btn" data-filter="video"><i class="fa-solid fa-video"></i> 動画</button>
      </div>

      <!-- グリッド -->
      <div class="media-grid" id="media-grid"></div>

      <!-- もっと読み込む -->
      <button class="media-load-more" id="media-load-more" style="display:none;">もっと読み込む</button>
    </div>
  </main>

  <!-- ライトボックス -->
  <div class="media-lightbox" id="media-lightbox">
    <button class="media-lightbox-close" id="lightbox-close"><i class="fa-solid fa-xmark"></i></button>
    <div class="media-lightbox-content" id="lightbox-content"></div>
  </div>

  <div id="footer-slot">
    <?php include __DIR__ . '/footer.php'; ?>
  </div>

  <script src="/ios-helper.js" defer></script>
  <script type="module" src="/dist/main.bundle.min.js?v=<?= @filemtime(__DIR__ . '/dist/main.bundle.min.js') ?: time(); ?>" defer></script>
  <script src="/dist/ui-misc.min.js?v=<?= @filemtime(__DIR__ . '/dist/ui-misc.min.js') ?: time(); ?>" defer></script>

  <script src="/js/twitter-media-dashboard.js?v=<?= @filemtime(__DIR__ . '/js/twitter-media-dashboard.js') ?: time(); ?>"></script>
</body>
</html>
