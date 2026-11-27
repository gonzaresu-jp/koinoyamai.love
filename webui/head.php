<?php
$siteName = "まいちゃん通知 | 恋乃夜まい 配信・活動通知サービス";
$defaultDesc = "Koinoya Mai（恋乃夜まい）の配信・活動をリアルタイムで通知する非公式ファンサービス。YouTube・TwitCasting・Twitch・Twitter・Pixiv Fanboxなど複数プラットフォームに対応。配信アーカイブの全文検索・まいAIチャット・非公式wikiなど、推し活を深める機能も揃えています。";
require_once __DIR__ . '/_domain.php'; // ドメイン単一ソース（リクエスト導出）

// 正規パス（canonical）の算出:
// - クエリ文字列（?q=..., UTM 等）を除去
// - .php 付き・末尾スラッシュ無しを正規 URL（/slug/）へ集約して重複インデックスを防止
if (!isset($canonicalPath)) {
    $rawPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if (!is_string($rawPath) || $rawPath === '') {
        $rawPath = '/';
    }
    $canonicalMap = [
        '/index.php'         => '/',
        '/archive'           => '/archive/',
        '/archive.php'       => '/archive/',
        '/guide'             => '/guide/',
        '/guide.php'         => '/guide/',
        '/logs'              => '/logs/',
        '/logs.php'          => '/logs/',
        '/download'          => '/download/',
        '/download.php'      => '/download/',
        '/status'            => '/status/',
        '/status.php'        => '/status/',
        '/future'            => '/future/',
        '/future.php'        => '/future/',
        '/info'              => '/info/',
        '/info.php'          => '/info/',
        '/twitter-media'     => '/twitter-media/',
        '/twitter-media.php' => '/twitter-media/',
    ];
    $canonicalPath = $canonicalMap[$rawPath] ?? $rawPath;
}
$currentUrl = $domain . $canonicalPath;

$title = isset($pageTitle) ? $pageTitle . " | まいちゃん通知" : $siteName;
$description = isset($pageDesc) ? $pageDesc : $defaultDesc;
$image = isset($pageImage) ? $pageImage : $defaultImage;

$websiteJsonLd = json_encode([
    '@context' => 'https://schema.org',
    '@type' => 'WebSite',
    'name' => 'まいちゃん通知',
    'alternateName' => ['Koinoya Mai Notification', '恋乃夜まい通知', '恋乃夜まい 通知ダッシュボード'],
    'url' => $domain . '/',
    'inLanguage' => 'ja',
    'description' => $defaultDesc,
    'publisher' => [
        '@type' => 'Organization',
        'name' => 'まいちゃん通知 開発チーム',
    ],
    'potentialAction' => [
        '@type' => 'SearchAction',
        'target' => $domain . '/archive/?q={search_term_string}',
        'query-input' => 'required name=search_term_string',
    ],
    'mainEntity' => [
        '@type' => 'Person',
        'name' => '恋乃夜まい',
        'alternateName' => 'Koinoya Mai',
        'sameAs' => [
            'https://www.youtube.com/@koinoyamaich',
            'https://x.com/koinoya_mai',
            'https://twitcasting.tv/c:koinoya_mai',
            'https://www.twitch.tv/koinoya_mai',
        ],
    ],
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG);

$breadcrumbJsonLd = '';
if ($canonicalPath !== '/' && isset($pageTitle) && empty($robotsNoindex)) {
    $breadcrumbJsonLd = json_encode([
        '@context' => 'https://schema.org',
        '@type' => 'BreadcrumbList',
        'itemListElement' => [
            [
                '@type' => 'ListItem',
                'position' => 1,
                'name' => 'まいちゃん通知',
                'item' => $domain . '/',
            ],
            [
                '@type' => 'ListItem',
                'position' => 2,
                'name' => $pageTitle,
                'item' => $currentUrl,
            ],
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG);
}
?>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />

<!-- JSON-LD: 構造化データ（SEO強化） -->
<?php if ($websiteJsonLd): ?>
<script type="application/ld+json"><?= $websiteJsonLd ?></script>
<?php endif; ?>
<?php if ($breadcrumbJsonLd): ?>
<script type="application/ld+json"><?= $breadcrumbJsonLd ?></script>
<?php endif; ?>

<!-- =====================================================
     SEO: タイトル・概要
     ===================================================== -->
<title><?= htmlspecialchars($title) ?></title>
<meta name="description" content="<?= htmlspecialchars($description) ?>" />
<meta name="keywords"
  content="恋乃夜まい,koinoyamai,まいちゃん,まいちゃん通知,配信通知,ライブ通知,YouTube通知,TwitCasting,Twitch,Vtuber,バーチャルYouTuber,ファンサイト,配信アーカイブ,文字起こし検索,まいAI,wiki" />

<!-- canonical：重複URLペナルティ防止 -->
<link rel="canonical" href="<?= htmlspecialchars($currentUrl) ?>" />

<!-- robots: 検索結果ページ等は $robotsNoindex で noindex,follow に切り替え -->
<meta name="robots" content="<?= isset($robotsNoindex) && $robotsNoindex ? 'noindex, follow' : 'index, follow' ?>" />

<!-- =====================================================
     OGP（Open Graph）
     ===================================================== -->
<meta property="og:url" content="<?= htmlspecialchars($currentUrl) ?>" />
<meta property="og:type" content="website" />
<meta property="og:title" content="<?= htmlspecialchars($title) ?>" />
<meta property="og:description" content="<?= htmlspecialchars($description) ?>" />
<meta property="og:site_name" content="まいちゃん通知" />
<meta property="og:image" content="<?= htmlspecialchars($image) ?>" />
<meta property="og:image:alt" content="<?= htmlspecialchars(isset($pageImageAlt) ? $pageImageAlt : "まいちゃん通知 ロゴ") ?>" />
<meta property="og:locale" content="ja_JP" />

<!-- =====================================================
     Twitter Card
     ===================================================== -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@Yuzuki_Mai_17" />
<meta name="twitter:title" content="<?= htmlspecialchars($title) ?>" />
<meta name="twitter:description" content="<?= htmlspecialchars($description) ?>" />
<meta name="twitter:image" content="<?= htmlspecialchars($image) ?>" />
<meta name="twitter:image:alt" content="<?= htmlspecialchars(isset($pageImageAlt) ? $pageImageAlt : "まいちゃん通知 ロゴ") ?>" />

<!-- =====================================================
     iOS / PWA 対応
     ===================================================== -->
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="まいちゃん通知" />
<meta name="mobile-web-app-capable" content="yes" />

<!-- =====================================================
     アイコン / manifest
     ===================================================== -->
<link rel="icon" href="/icon.webp" />
<link rel="apple-touch-icon" href="/icon-192.webp" />
<link rel="apple-touch-icon" sizes="192x192" href="/icon-192.webp" />
<link rel="apple-touch-icon" sizes="512x512" href="/icon-512.webp" />

<!-- =====================================================
     CSS / 基本アセット
     ===================================================== -->
<!-- プリコネクション: ヘッダーの外部アイコン(img.icons8.com)へ先に接続を確立 -->
<link rel="preconnect" href="https://img.icons8.com" />
<!-- メインCSS: ブロックするが必須 -->
<link rel="stylesheet" href="/style.min.css?v=<?= @filemtime(__DIR__ . '/style.min.css') ?: time(); ?>" />
<!-- FontAwesome: preloadで非ブロック読み込み -->
<link rel="preload" href="/fontawesome-free-7.2.0-web/css/all.min.css" as="style"
  onload="this.onload=null;this.rel='stylesheet'" crossorigin="anonymous" />
<noscript>
  <link rel="stylesheet" href="/fontawesome-free-7.2.0-web/css/all.min.css" crossorigin="anonymous" />
</noscript>
<!-- FAフォントを事前 preload→描画ほっく载ってから利用 -->
<link rel="preload" href="/fontawesome-free-7.2.0-web/webfonts/fa-solid-900.woff2" as="font" type="font/woff2"
  crossorigin="anonymous" />
<link rel="preload" href="/fontawesome-free-7.2.0-web/webfonts/fa-regular-400.woff2" as="font" type="font/woff2"
  crossorigin="anonymous" />
<link rel="preload" href="/fontawesome-free-7.2.0-web/webfonts/fa-brands-400.woff2" as="font" type="font/woff2"
  crossorigin="anonymous" />
<?= isset($extraHead) ? $extraHead : '' ?>

<!-- スマホ用特化スタイル（必ず最後に読み込んでオーバーライドする） -->
<link rel="preload" href="/sp.min.css?v=<?= @filemtime(__DIR__ . '/sp.min.css') ?: time(); ?>" as="style" onload="this.onload=null;this.rel='stylesheet'"
  media="screen and (max-width: 800px)" />
<noscript>
  <link rel="stylesheet" href="/sp.min.css?v=<?= @filemtime(__DIR__ . '/sp.min.css') ?: time(); ?>" media="screen and (max-width: 800px)" />
</noscript>

<!-- ヘッダー専用CSS（全ページ共通・header.php の style を分離） -->
<link rel="stylesheet" href="/css/header.css?v=<?= @filemtime(__DIR__ . '/css/header.css') ?: time(); ?>" />

<?= isset($extraHeadEnd) ? $extraHeadEnd : '' ?>


