<!doctype html>
<html lang="ja">

<head>
    <?php
    // status.php
    $pageTitle = "システム稼働状況";
    $pageDesc = "まいちゃん通知（恋乃夜まい非公式通知サービス）のバックグラウンド監視プロセス・AI使用量・サーバーリソースのリアルタイム稼働状況を確認できます。";
    $extraHead = '<link rel="stylesheet" href="/css/status.css?v=' . @filemtime(__DIR__ . '/css/status.css') . '" />';
    include __DIR__ . '/head.php';
    ?>
</head>


<body id="app-body">
    <?php include __DIR__ . '/header.php'; ?>

    <div class="status-container">
        <div class="status-header">
            <h1>システム稼働状況</h1>
            <p>バックグラウンドプロセスとサーバーリソースの健康状態をリアルタイムで表示します。</p>
            <button class="status-refresh-btn" onclick="loadAll()">
                <i class="fa-solid fa-rotate"></i> 更新
            </button>
        </div>

        <!-- サーバーリソース -->
        <div class="resource-section">
            <div class="resource-section-title"><i class="fa-solid fa-server" style="margin-right:6px"></i>サーバーリソース</div>
            <div id="resource-grid" class="resource-grid">
                <div class="ai-muted">Loading...</div>
            </div>
        </div>

        <div class="section-divider"></div>

        <!-- AI 使用量 -->
        <div class="resource-section">
            <div class="resource-section-title"><i class="fa-solid fa-brain" style="margin-right:6px"></i>AI 使用量と上限</div>
            <div id="ai-grid" class="resource-grid">
                <div class="ai-muted">Loading...</div>
            </div>
        </div>

        <div class="section-divider"></div>

        <!-- スクレイパー状況 -->
        <div class="scraper-section-title"><i class="fa-solid fa-circle-nodes" style="margin-right:6px"></i>プロセスステータス</div>
        <div id="status-grid" class="status-grid">
            <div class="status-loading">Loading systems health...</div>
        </div>
    </div>

    <?php include __DIR__ . '/footer.php'; ?>

    <script src="/js/status-page.js?v=<?= @filemtime(__DIR__ . '/js/status-page.js') ?: time(); ?>"></script>
    <script src="/ios-helper.js" defer></script>
    <script type="module" src="/dist/main.bundle.min.js?v=<?= @filemtime(__DIR__ . '/dist/main.bundle.min.js') ?: time(); ?>" defer></script>
</body>

</html>