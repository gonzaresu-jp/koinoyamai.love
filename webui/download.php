<!doctype html>
<html lang="ja">

<head>
    <?php
    $pageTitle = "アプリをダウンロード";
    $pageDesc = "まいちゃん通知のAndroid版・Windows版アプリのダウンロードページです。FCMプッシュ通知でいつでも確実に配信情報を受け取れます。";
    $extraHead = '<link rel="stylesheet" href="/css/download.css?v=' . @filemtime(__DIR__ . '/css/download.css') . '" />';
    include __DIR__ . '/head.php';

    // Android APK（更新フィード android.json からバージョンを動的取得）
    $apkPath = __DIR__ . '/mai-notification.apk';
    $apkSize = @filesize($apkPath);
    $apkSizeMb = $apkSize ? round($apkSize / 1048576, 1) . " MB" : "";
    $apkVersion = "";
    $apkFeed = @json_decode(@file_get_contents(__DIR__ . '/dl/android.json'), true);
    if (is_array($apkFeed)) {
        $apkVersion = isset($apkFeed["versionName"]) ? (string)$apkFeed["versionName"] : "";
    }

    // Windows (更新フィード desktop.json から動的取得)
    $winVersion = "";
    $winNotes = "";
    $winHref = "";
    $winSizeMb = "";
    $feed = @json_decode(@file_get_contents(__DIR__ . '/dl/desktop.json'), true);
    if (is_array($feed)) {
        $winVersion = isset($feed["version"]) ? (string)$feed["version"] : "";
        $winNotes = isset($feed["notes"]) ? (string)$feed["notes"] : "";
        $winUrlPath = isset($feed["url"]) ? parse_url((string)$feed["url"], PHP_URL_PATH) : "";
        $winFile = $winUrlPath ? basename($winUrlPath) : "";
        if ($winFile) {
            $winSize = @filesize(__DIR__ . '/dl/' . $winFile);
            $winSizeMb = $winSize ? round($winSize / 1048576, 0) . " MB" : "";
            // 同名ファイルを上書きすると Cloudflare / nginx のキャッシュに旧版が残るため、
            // APK と同じく filemtime を付けてキャッシュを破棄する（ビルドのたびに自動で変わる）
            $winHref = '/dl/' . rawurlencode($winFile) . '?v=' . @filemtime(__DIR__ . '/dl/' . $winFile);
        }
    }
    ?>
</head>

<body id="app-body">
    <div id="header-slot">
        <?php include __DIR__ . '/header.php'; ?>
    </div>

    <main class="download-page">
        <section class="dl-hero fade">
            <img src="/icon.webp" alt="まいちゃん通知 ロゴ" class="dl-hero-logo" fetchpriority="high" />
            <div class="dl-hero-text">
                <h1>まいちゃん通知 アプリ</h1>
                <p>端末にインストールして、配信・活動の通知をもっと確実に。<br />対応OS: <strong>Android</strong> と <strong>Windows</strong></p>
            </div>
        </section>

        <div class="dl-grid">
            <!-- Android -->
            <article class="dl-card fade d1 dl-card-android">
                <div class="dl-card-head">
                    <div class="dl-logo dl-logo-android" aria-hidden="true">
                        <i class="fa-brands fa-android"></i>
                    </div>
                    <div class="dl-card-title">
                        <h2>Androidアプリ</h2>
                        <span class="dl-badge dl-badge-apk">
                            <?php if ($apkVersion): ?>v<?= htmlspecialchars($apkVersion) ?><?php else: ?>APK<?php endif; ?>
                        </span>
                    </div>
                </div>
                <p class="dl-card-desc">スマホ・タブレットにインストールして使う公式アプリ。FCM プッシュ通知で、画面を閉じていてもロック中もすぐに届きます。</p>
                <ul class="dl-features">
                    <li><i class="fa-solid fa-bell" aria-hidden="true"></i>FCM プッシュ通知（ロック中も即時）</li>
                    <li><i class="fa-solid fa-sliders" aria-hidden="true"></i>プラットフォーム別の通知ON/OFF</li>
                    <li><i class="fa-solid fa-battery-three-quarters" aria-hidden="true"></i>常駐しても軽量</li>
                </ul>
                <?php if ($apkSizeMb): ?>
                    <p class="dl-meta">ファイルサイズ: <?= htmlspecialchars($apkSizeMb) ?> / Android 8.0 以上</p>
                <?php endif; ?>
                <a class="dl-btn dl-btn-android" href="/mai-notification.apk?v=<?= @filemtime($apkPath) ?: time() ?>" target="_blank" rel="noopener noreferrer">
                    <i class="fa-solid fa-download" aria-hidden="true"></i> APKをダウンロード
                </a>
            </article>

            <!-- Windows -->
            <article class="dl-card fade d2 dl-card-windows">
                <div class="dl-card-head">
                    <div class="dl-logo dl-logo-windows" aria-hidden="true">
                        <i class="fa-brands fa-windows"></i>
                    </div>
                    <div class="dl-card-title">
                        <h2>Windowsアプリ</h2>
                        <span class="dl-badge dl-badge-win">
                            <?php if ($winVersion): ?>v<?= htmlspecialchars($winVersion) ?><?php else: ?>最新版<?php endif; ?>
                        </span>
                    </div>
                </div>
                <p class="dl-card-desc">PCで動かすデスクトップアプリ。ブラウザ風のタブ操作・自動アップデートチェック付き。ログイン状態と通知監視をタブ間で共有します。</p>
                <ul class="dl-features">
                    <li><i class="fa-solid fa-table-columns" aria-hidden="true"></i>ブラウザ風タブ（Ctrl+T / Ctrl+W / Ctrl+Tab）</li>
                    <li><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>起動時＋6時間毎の自動更新チェック</li>
                    <li><i class="fa-solid fa-bell" aria-hidden="true"></i>デスクトップ常駐で通知を受信</li>
                </ul>
                <?php if ($winNotes): ?>
                    <p class="dl-notes"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> <?= htmlspecialchars($winNotes) ?></p>
                <?php endif; ?>
                <?php if ($winSizeMb): ?>
                    <p class="dl-meta">ファイルサイズ: <?= htmlspecialchars($winSizeMb) ?> / Windows 10 以降（64bit）</p>
                <?php endif; ?>
                <?php if ($winHref): ?>
                    <a class="dl-btn dl-btn-windows" href="<?= htmlspecialchars($winHref) ?>" target="_blank" rel="noopener noreferrer">
                        <i class="fa-solid fa-download" aria-hidden="true"></i> セットアップをダウンロード
                    </a>
                <?php else: ?>
                    <p class="dl-meta">ダウンロードの準備中です。しばらくしてから再度ご確認ください。</p>
                <?php endif; ?>
            </article>
        </div>

        <section class="dl-help fade d3">
            <h3><i class="fa-solid fa-circle-question" aria-hidden="true"></i> インストールのヒント</h3>
            <ul>
                <li><strong>Android:</strong> ダウンロードしたAPKをタップしてインストール。初回は「不明なソースからのインストール」の許可を求められることがあります。</li>
                <li><strong>Windows:</strong> セットアップ（MaiPush-Setup）を実行してください。インストール後はスタートメニューまたはデスクトップから起動できます。</li>
                <li>ログイン後は通知のON/OFFを各プラットフォームごとに設定できます。</li>
            </ul>
        </section>

        <a class="dl-back fade d4" href="/">
            <i class="fa-solid fa-house" aria-hidden="true"></i> 通知ダッシュボードに戻る
        </a>
    </main>

    <div id="footer-slot">
        <?php include __DIR__ . '/footer.php'; ?>
    </div>

    <!-- iOS Helper を main.js より先に読み込む -->
    <script src="/ios-helper.js" defer></script>
    <script type="module" src="/dist/main.bundle.min.js?v=<?= @filemtime(__DIR__ . '/dist/main.bundle.min.js') ?: time(); ?>" defer></script>
    <script src="/dist/ui-misc.min.js?v=<?= @filemtime(__DIR__ . '/dist/ui-misc.min.js') ?: time(); ?>" defer></script>
</body>

</html>
