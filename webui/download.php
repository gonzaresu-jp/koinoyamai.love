<!doctype html>
<html lang="ja">

<head>
    <?php
    $pageTitle = "アプリをダウンロード";
    $pageDesc = "まいちゃん通知のAndroid版・Windows版アプリのダウンロードページです。各アプリの主な機能、動作環境・推奨要件、インストール手順をご案内します。";
    $extraHead = '<link rel="stylesheet" href="/css/download.css?v=' . @filemtime(__DIR__ . '/css/download.css') . '" />';
    include __DIR__ . '/head.php';

    // Android APK（更新フィード android.json からバージョン・更新メモを動的取得）
    $apkPath = __DIR__ . '/mai-notification.apk';
    $apkSize = @filesize($apkPath);
    $apkSizeMb = $apkSize ? round($apkSize / 1048576, 1) . " MB" : "";
    $apkVersion = "";
    $apkNotes = "";
    $apkFeed = @json_decode(@file_get_contents(__DIR__ . '/dl/android.json'), true);
    if (is_array($apkFeed)) {
        $apkVersion = isset($apkFeed["versionName"]) ? (string)$apkFeed["versionName"] : "";
        $apkNotes = isset($apkFeed["notes"]) ? (string)$apkFeed["notes"] : "";
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
        <div class="dl-shell">
            <!-- ヘッダー帯 -->
            <header class="dl-hero">
                <div class="dl-hero-main">
                    <img src="/icon.webp" alt="まいちゃん通知 ロゴ" class="dl-hero-logo" width="64" height="64" fetchpriority="high" />
                    <div class="dl-hero-text">
                        <h1 class="dl-title">まいちゃん通知 アプリ</h1>
                        <p class="dl-lead">端末にインストールして、配信・活動の通知をもっと確実に。無料・登録不要で使えます。</p>
                    </div>
                </div>
                <div class="dl-hero-pills" aria-label="対応プラットフォーム概要">
                    <a class="dl-os-pill is-android" href="#app-android">
                        <i class="fa-brands fa-android" aria-hidden="true"></i>
                        <span>Android<?= $apkVersion ? ' v' . htmlspecialchars($apkVersion) : '' ?></span>
                    </a>
                    <a class="dl-os-pill is-windows" href="#app-windows">
                        <i class="fa-brands fa-windows" aria-hidden="true"></i>
                        <span>Windows<?= $winVersion ? ' v' . htmlspecialchars($winVersion) : '' ?></span>
                    </a>
                    <a class="dl-os-pill is-req" href="#requirements">
                        <i class="fa-solid fa-microchip" aria-hidden="true"></i>
                        <span>推奨要件を見る</span>
                    </a>
                </div>
            </header>

            <!-- アプリダウンロード 2カラム -->
            <section class="dl-band dl-cards-band" aria-label="アプリ一覧">
                <div class="dl-grid">
                    <!-- Android -->
                    <article id="app-android" class="dl-card dl-card-android">
                        <div class="dl-card-head">
                            <div class="dl-logo dl-logo-android" aria-hidden="true">
                                <i class="fa-brands fa-android"></i>
                            </div>
                            <div class="dl-card-title">
                                <h2>Androidアプリ</h2>
                                <div class="dl-badges">
                                    <span class="dl-badge dl-badge-apk">
                                        <?= $apkVersion ? 'v' . htmlspecialchars($apkVersion) : 'APK' ?>
                                    </span>
                                    <span class="dl-badge dl-badge-sub">APK 直配布</span>
                                </div>
                            </div>
                        </div>

                        <p class="dl-card-desc">スマホ・タブレット向け専用アプリ。FCM プッシュ通知と配信アラームで、画面を閉じていてもロック中でも配信開始を見逃しません。</p>

                        <ul class="dl-features">
                            <li><i class="fa-solid fa-bell" aria-hidden="true"></i><span>FCM プッシュ通知（ロック中・バックグラウンドも即時）</span></li>
                            <li><i class="fa-solid fa-clock" aria-hidden="true"></i><span>止めるまで鳴る配信アラーム（最大15分で自動停止）</span></li>
                            <li><i class="fa-solid fa-table-cells-large" aria-hidden="true"></i><span>ホーム画面ウィジェット（カウント・まいちゃんの予定）</span></li>
                            <li><i class="fa-solid fa-sliders" aria-hidden="true"></i><span>プラットフォーム別の通知ON/OFF・アプリ内更新対応</span></li>
                        </ul>

                        <?php if ($apkNotes): ?>
                            <div class="dl-notes">
                                <span class="dl-notes-label"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> 最新版の更新内容</span>
                                <p><?= htmlspecialchars($apkNotes) ?></p>
                            </div>
                        <?php endif; ?>

                        <div class="dl-card-foot">
                            <div class="dl-meta-chips">
                                <?php if ($apkSizeMb): ?>
                                    <span class="dl-meta-chip"><i class="fa-solid fa-hard-drive" aria-hidden="true"></i> <?= htmlspecialchars($apkSizeMb) ?></span>
                                <?php endif; ?>
                                <span class="dl-meta-chip"><i class="fa-solid fa-mobile-screen" aria-hidden="true"></i> Android 8.0 以上</span>
                                <span class="dl-meta-chip"><i class="fa-solid fa-check" aria-hidden="true"></i> 無料</span>
                            </div>
                            <a class="dl-btn dl-btn-android" href="/mai-notification.apk?v=<?= @filemtime($apkPath) ?: time() ?>" target="_blank" rel="noopener noreferrer">
                                <i class="fa-solid fa-download" aria-hidden="true"></i> APKをダウンロード
                            </a>
                        </div>
                    </article>

                    <!-- Windows -->
                    <article id="app-windows" class="dl-card dl-card-windows">
                        <div class="dl-card-head">
                            <div class="dl-logo dl-logo-windows" aria-hidden="true">
                                <i class="fa-brands fa-windows"></i>
                            </div>
                            <div class="dl-card-title">
                                <h2>Windowsアプリ</h2>
                                <div class="dl-badges">
                                    <span class="dl-badge dl-badge-win">
                                        <?= $winVersion ? 'v' . htmlspecialchars($winVersion) : '最新版' ?>
                                    </span>
                                    <span class="dl-badge dl-badge-sub">64bit / WinUI 3</span>
                                </div>
                            </div>
                        </div>

                        <p class="dl-card-desc">PC で常駐して使えるデスクトップアプリ。ブラウザ風のタブ操作や自動更新チェックに対応し、ログイン状態と通知監視をタブ間で共有します。</p>

                        <ul class="dl-features">
                            <li><i class="fa-solid fa-table-columns" aria-hidden="true"></i><span>ブラウザ風タブ操作（Ctrl+T / Ctrl+W / Ctrl+Tab）</span></li>
                            <li><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i><span>起動時＋6時間毎の自動アップデートチェック</span></li>
                            <li><i class="fa-solid fa-bell" aria-hidden="true"></i><span>タスクトレイ常駐＆Windows 起動時の自動起動対応</span></li>
                            <li><i class="fa-solid fa-box-open" aria-hidden="true"></i><span>.NET 8 同梱で追加ランタイム不要・管理者権限不要</span></li>
                        </ul>

                        <?php if ($winNotes): ?>
                            <div class="dl-notes">
                                <span class="dl-notes-label"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> 最新版の更新内容</span>
                                <p><?= htmlspecialchars($winNotes) ?></p>
                            </div>
                        <?php endif; ?>

                        <div class="dl-card-foot">
                            <div class="dl-meta-chips">
                                <?php if ($winSizeMb): ?>
                                    <span class="dl-meta-chip"><i class="fa-solid fa-hard-drive" aria-hidden="true"></i> <?= htmlspecialchars($winSizeMb) ?></span>
                                <?php endif; ?>
                                <span class="dl-meta-chip"><i class="fa-solid fa-desktop" aria-hidden="true"></i> Windows 10/11 (64bit)</span>
                                <span class="dl-meta-chip"><i class="fa-solid fa-check" aria-hidden="true"></i> 無料</span>
                            </div>
                            <?php if ($winHref): ?>
                                <a class="dl-btn dl-btn-windows" href="<?= htmlspecialchars($winHref) ?>" target="_blank" rel="noopener noreferrer">
                                    <i class="fa-solid fa-download" aria-hidden="true"></i> セットアップをダウンロード
                                </a>
                            <?php else: ?>
                                <p class="dl-preparing">ダウンロードの準備中です。しばらくしてから再度ご確認ください。</p>
                            <?php endif; ?>
                        </div>
                    </article>
                </div>
            </section>

            <!-- 動作環境・推奨要件 -->
            <section id="requirements" class="dl-band dl-req-band" aria-labelledby="dl-req-heading">
                <div class="dl-section-head">
                    <h2 id="dl-req-heading" class="dl-section-title">
                        <i class="fa-solid fa-microchip" aria-hidden="true"></i> 動作環境・推奨要件
                    </h2>
                    <p class="dl-section-sub">快適に通知・画面表示を利用するための最小要件と推奨スペックの目安です。</p>
                </div>

                <div class="dl-req-grid">
                    <!-- Android 要件 -->
                    <div class="dl-req-card is-android">
                        <div class="dl-req-card-head">
                            <span class="dl-req-icon is-android" aria-hidden="true"><i class="fa-brands fa-android"></i></span>
                            <h3>Android アプリ</h3>
                        </div>
                        <div class="dl-req-list">
                            <div class="dl-req-row">
                                <div class="dl-req-label">対応 OS</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span class="dl-tier is-min">最小</span><span>Android 8.0（API 26）以上</span></div>
                                    <div class="dl-req-line"><span class="dl-tier is-rec">推奨</span><span>Android 10.0 以上</span></div>
                                </div>
                            </div>
                            <div class="dl-req-row">
                                <div class="dl-req-label">メモリ（RAM）</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span class="dl-tier is-min">最小</span><span>2 GB 以上</span></div>
                                    <div class="dl-req-line"><span class="dl-tier is-rec">推奨</span><span>4 GB 以上</span></div>
                                </div>
                            </div>
                            <div class="dl-req-row">
                                <div class="dl-req-label">空きストレージ</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span class="dl-tier is-min">最小</span><span>50 MB 以上</span></div>
                                    <div class="dl-req-line"><span class="dl-tier is-rec">推奨</span><span>100 MB 以上（キャッシュ・更新一時領域含む）</span></div>
                                </div>
                            </div>
                            <div class="dl-req-row">
                                <div class="dl-req-label">必須コンポーネント</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span>Google Play 開発者サービス（FCM プッシュ通知に必須）</span></div>
                                    <div class="dl-req-line"><span>Android System WebView（最新版推奨）</span></div>
                                </div>
                            </div>
                            <div class="dl-req-row">
                                <div class="dl-req-label">通信・おすすめ設定</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span>常時インターネット接続・通知権限の許可</span></div>
                                    <div class="dl-req-line"><span>バッテリー最適化（省電力制限）の除外を推奨</span></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Windows 要件 -->
                    <div class="dl-req-card is-windows">
                        <div class="dl-req-card-head">
                            <span class="dl-req-icon is-windows" aria-hidden="true"><i class="fa-brands fa-windows"></i></span>
                            <h3>Windows アプリ</h3>
                        </div>
                        <div class="dl-req-list">
                            <div class="dl-req-row">
                                <div class="dl-req-label">対応 OS</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span class="dl-tier is-min">最小</span><span>Windows 10 バージョン 1809（64bit）以降</span></div>
                                    <div class="dl-req-line"><span class="dl-tier is-rec">推奨</span><span>Windows 10（2004 以降）または Windows 11（64bit）</span></div>
                                </div>
                            </div>
                            <div class="dl-req-row">
                                <div class="dl-req-label">CPU</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span class="dl-tier is-min">最小</span><span>64bit（x64）対応プロセッサ</span></div>
                                    <div class="dl-req-line"><span class="dl-tier is-rec">推奨</span><span>デュアルコア（2コア）以上 ※ Windows 11 ARM64 の x64 互換動作にも対応</span></div>
                                </div>
                            </div>
                            <div class="dl-req-row">
                                <div class="dl-req-label">メモリ（RAM）</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span class="dl-tier is-min">最小</span><span>4 GB 以上</span></div>
                                    <div class="dl-req-line"><span class="dl-tier is-rec">推奨</span><span>8 GB 以上（WebView2 の複数タブ利用時）</span></div>
                                </div>
                            </div>
                            <div class="dl-req-row">
                                <div class="dl-req-label">空きストレージ</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span class="dl-tier is-min">最小</span><span>250 MB 以上</span></div>
                                    <div class="dl-req-line"><span class="dl-tier is-rec">推奨</span><span>500 MB 以上（展開本体＋WebView2 キャッシュ含む）</span></div>
                                </div>
                            </div>
                            <div class="dl-req-row">
                                <div class="dl-req-label">ランタイム・権限</div>
                                <div class="dl-req-val">
                                    <div class="dl-req-line"><span>Microsoft Edge WebView2 ランタイム（Windows 11 は標準搭載）</span></div>
                                    <div class="dl-req-line"><span>.NET 8・Windows App SDK は同梱済みのため追加導入不要 ／ 管理者権限不要</span></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- iOS / macOS 向け PWA 案内 -->
                <div class="dl-pwa-callout">
                    <div class="dl-pwa-icon" aria-hidden="true">
                        <i class="fa-brands fa-apple"></i>
                    </div>
                    <div class="dl-pwa-body">
                        <strong>iPhone / iPad・macOS をご利用の方へ</strong>
                        <p>Safari の共有メニューから「ホーム画面に追加」を行うと、Web アプリ（PWA）としてプッシュ通知を受け取れます（iOS / iPadOS 16.4 以降推奨）。詳しくは<a href="/guide/">使い方・対応一覧</a>をご覧ください。</p>
                    </div>
                </div>
            </section>

            <!-- インストールのヒント -->
            <section class="dl-band dl-help-band" aria-labelledby="dl-help-heading">
                <div class="dl-section-head">
                    <h2 id="dl-help-heading" class="dl-section-title">
                        <i class="fa-solid fa-circle-question" aria-hidden="true"></i> インストールのヒント
                    </h2>
                    <p class="dl-section-sub">初回導入時に迷いやすいポイントをまとめました。</p>
                </div>

                <div class="dl-help-grid">
                    <div class="dl-help-card">
                        <h3><i class="fa-brands fa-android is-android" aria-hidden="true"></i> Android の場合</h3>
                        <ol class="dl-step-list">
                            <li>ダウンロードした <code>mai-notification.apk</code> をタップしてインストールします。初回は「不明なアプリのインストール」の許可が必要です。</li>
                            <li>初回起動時に表示される通知権限（Android 13 以降）を許可してください。</li>
                            <li>配信アラームや通知の遅れを防ぐため、端末設定の「バッテリー最適化」から本アプリを除外するのがおすすめです。</li>
                        </ol>
                    </div>
                    <div class="dl-help-card">
                        <h3><i class="fa-brands fa-windows is-windows" aria-hidden="true"></i> Windows の場合</h3>
                        <ol class="dl-step-list">
                            <li><code>MaiPush-Setup</code> を実行してインストールします（管理者権限なしで導入でき、スタートメニューから起動できます）。</li>
                            <li>Windows Defender SmartScreen の警告が出た場合は、「詳細情報」→「実行」でインストールを進められます。</li>
                            <li>Google ログインを使うと、スマホやブラウザ版と通知設定・推し日数をそのまま引き継げます。</li>
                        </ol>
                    </div>
                </div>
            </section>

            <!-- 下部アクション帯 -->
            <div class="dl-actions">
                <a class="dl-action-btn is-secondary" href="/guide/">
                    <i class="fa-solid fa-book-open" aria-hidden="true"></i> 使い方・対応一覧を見る
                </a>
                <a class="dl-action-btn is-primary" href="/">
                    <i class="fa-solid fa-house" aria-hidden="true"></i> 通知ダッシュボードに戻る
                </a>
            </div>
        </div>
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
