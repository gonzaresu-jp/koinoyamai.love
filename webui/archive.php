<!doctype html>
<html lang="ja">

<head>
    <?php
    require_once __DIR__ . '/_domain.php';
    $pageTitle = "配信アーカイブ検索";
    $pageDesc = "恋乃夜まいの配信アーカイブを横断検索できるページ。タイトル・文字起こし・コメント・ライブチャットを全文検索し、該当箇所のタイムスタンプ付きURLからYouTubeへ直接ジャンプできます。";

    // ---- SEO: 検索クエリ付きページはインデックスしない（アーカイブ本文のみインデックス） ----
    $robotsNoindex = !empty($_GET['q']) && trim((string)$_GET['q']) !== '';

    // ---- SEO: サーバーサイドで直近アーカイブを描画（検索エンジン向け本文） ----
    $seoArchives = array();
    $seoCategories = array();
    $seoArchiveTotal = 0;
    $seoJsonLd = '';

    function mai_archive_fetch($path, $timeoutSec = 6)
    {
        // PHP の関数スコープではグローバル変数が見えない。
        // global 宣言が無いと $domain が未定義になり、URL がパスのみになって
        // HTTP 取得が常に失敗していた（サーバサイドSEOが空・2026-10-21 実測）。
        global $domain, $apiBase;
        $ctx = stream_context_create(array(
            'http' => array('timeout' => $timeoutSec, 'ignore_errors' => true),
            // TLS 検証は有効にする（公開ドメイン経由のフォールバック用）。
            // ローカル API は http なので ssl 設定は使われない。
            'ssl'  => array('verify_peer' => true, 'verify_peer_name' => true),
        ));
        // ① 同一ホスト内の Node API（速い・インターネットを経由しない）
        $body = @file_get_contents($apiBase . $path, false, $ctx);
        if ($body === false) {
            // ② 接続できない場合は公開ドメイン経由（フォールバック）
            $body = @file_get_contents($domain . $path, false, $ctx);
        }
        if ($body === false) return null;
        $data = json_decode($body, true);
        return is_array($data) ? $data : null;
    }

    $arCategory = (isset($_GET['category']) && trim((string)$_GET['category']) !== '')
        ? rawurlencode(trim((string)$_GET['category'])) : '';
    $arList = mai_archive_fetch('/api/archive/videos?limit=12&sort=stream_at_desc'
        . ($arCategory !== '' ? '&category=' . $arCategory : ''));
    if ($arList !== null) {
        $seoArchives = (isset($arList['videos']) && is_array($arList['videos'])) ? $arList['videos'] : array();
        $seoArchiveTotal = isset($arList['total']) ? (int)$arList['total'] : count($seoArchives);
    }
    $arStats = mai_archive_fetch('/api/archive/stats');
    if ($arStats !== null && isset($arStats['categories']) && is_array($arStats['categories'])) {
        arsort($arStats['categories']);
        $seoCategories = array_keys($arStats['categories']);
    }

    if (!empty($seoArchives)) {
        $itemList = array();
        foreach ($seoArchives as $row) {
            $uploadDate = isset($row['stream_date_jst']) ? str_replace(' ', 'T', $row['stream_date_jst']) . '+09:00' : '';
            $itemList[] = array(
                '@type' => 'VideoObject',
                'name' => isset($row['title']) ? $row['title'] : '',
                'url' => isset($row['url']) ? $row['url'] : '',
                'thumbnailUrl' => $domain . (isset($row['thumbnail']) ? $row['thumbnail'] : ''),
                'uploadDate' => $uploadDate,
            );
        }
        $seoJsonLd = json_encode(array(
            '@context' => 'https://schema.org',
            '@type' => 'CollectionPage',
            'name' => '恋乃夜まい 配信アーカイブ一覧',
            'description' => '恋乃夜まい（まいちゃん）の配信アーカイブ。YouTubeで公開されたアーカイブを一覧掲載。タイトル・文字起こし・コメント検索にも対応。',
            'url' => $domain . '/archive',
            'mainEntity' => array(
                '@type' => 'ItemList',
                'itemListElement' => $itemList,
            ),
        // JSON_HEX_TAG: 動画タイトルに </script> が含まれても <script> タグを脱出できないようにする
        // （タイトルは外部（YouTube）由来なので、JSON の中にそのまま埋め込むのは危険）。
        ), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG);
    }
    $extraHead = '<link rel="stylesheet" href="/css/archive.css?v=' . @filemtime(__DIR__ . '/css/archive.css') . '" />';
    include __DIR__ . '/head.php';
    if (!empty($seoJsonLd)) {
        echo "<script type=\"application/ld+json\">" . $seoJsonLd . "</script>\n";
    }
    ?>
</head>

<body id="app-body">
    <div id="header-slot">
        <?php include __DIR__ . '/header.php'; ?>
    </div>

    <!-- 左右の立ち絵（装飾。スクロール量に応じて archive.js が transform を更新する） -->
    <div class="ar-deco ar-deco-left" data-speed="0.8" aria-hidden="true">
        <img src="/archive01.webp" alt="まいちゃんの立ち絵" width="512" height="512" decoding="async" fetchpriority="low" />
    </div>
    <div class="ar-deco ar-deco-right" data-speed="0.8" aria-hidden="true">
        <img src="/archive02.webp" alt="まいちゃんの立ち絵" width="512" height="512" decoding="async" fetchpriority="low" />
    </div>

    <main>
        <section class="ar-intro">
            <h1>配信アーカイブ検索</h1>
            <p>
                恋乃夜まいの配信アーカイブを検索できます。サムネイルまたはカード内のURLからYouTubeの該当動画が開きます。<br>
                キーワード検索では<strong>タイトル・文字起こし・コメント・ライブチャット</strong>を検索し、該当箇所のタイムスタンプ付きURLを表示します（「かわいい / 可愛い / カワイイ」のような表記ゆれも同じ結果になります）。
</p>
            </section>

        <?php if (!empty($seoCategories)): ?>
        <?php endif; ?>

        <?php if (!empty($seoArchives)): ?>

        <?php endif; ?>

        <form class="ar-form" id="ar-form" role="search">
            <div class="ar-field grow">
                <label for="ar-q">キーワード</label>
                <input type="search" id="ar-q" name="q" placeholder="例: かわいい / ホラー / おはよう" autocomplete="off" />
            </div>

            <div class="ar-field" id="ar-author-wrap">
                <label for="ar-author">ユーザー名 (チャット)</label>
                <input type="search" id="ar-author" name="author" placeholder="例: @koinoyamaich" autocomplete="off" />
            </div>

            <div class="ar-field" id="ar-kind-wrap" hidden>
                <label for="ar-kind">検索対象</label>
                <select id="ar-kind">
                    <option value="all">すべて</option>
                    <option value="title">タイトル</option>
                    <option value="transcript">文字起こし</option>
                    <option value="comment">コメント</option>
                    <option value="chat">ライブチャット</option>
                </select>
            </div>

            <div class="ar-field">
                <label for="ar-category">カテゴリ</label>
                <select id="ar-category">
                    <option value="">すべて</option>
                </select>
            </div>

            <div class="ar-field" id="ar-sort-wrap">
                <label for="ar-sort">並び順</label>
                <select id="ar-sort">
                    <option value="stream_at_desc">配信が新しい順</option>
                    <option value="stream_at_asc">配信が古い順</option>
                    <option value="view_desc">再生数が多い順</option>
                    <option value="like_desc">高評価が多い順</option>
                    <option value="duration_desc">配信時間が長い順</option>
                    <option value="duration_asc">配信時間が短い順</option>
                    <option value="size_desc">動画サイズが大きい順</option>
                    <option value="size_asc">動画サイズが小さい順</option>
                    <option value="hits_desc" id="ar-sort-hits" hidden disabled>ヒットが多い順</option>
                </select>
            </div>

            <div class="ar-field">
                <label>&nbsp;</label>
                <button type="submit" class="ar-btn"><i class="fa-solid fa-magnifying-glass"></i> 検索</button>
            </div>

            <div class="ar-field" id="ar-clear-wrap" hidden>
                <label>&nbsp;</label>
                <button type="button" class="ar-btn ghost" id="ar-clear">検索を解除</button>
            </div>
        </form>

        <p class="ar-status" id="ar-status" aria-live="polite"></p>

        <div class="ar-results" id="ar-results"></div>

        <div class="ar-load-more" id="ar-load-more-wrap" hidden>
            <button type="button" class="ar-btn" id="ar-load-more">さらに読み込む</button>
        </div>

        <nav class="ar-pager" id="ar-pager" aria-label="ページ送り" hidden></nav>

        <a href="/" class="ar-back">
            <div>
                <h3 style="margin:0;">通知ダッシュボードに戻る</h3>
            </div>
        </a>
    </main>

    <div id="footer-slot">
        <?php include __DIR__ . '/footer.php'; ?>
    </div>

    <script src="/ios-helper.js" defer></script>
    <script src="/dist/archive.min.js?v=<?= @filemtime(__DIR__ . '/dist/archive.min.js') ?: time(); ?>" defer></script>
    <script type="module" src="/dist/main.bundle.min.js?v=<?= @filemtime(__DIR__ . '/dist/main.bundle.min.js') ?: time(); ?>" defer></script>

</body>

</html>
