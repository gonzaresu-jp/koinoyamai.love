<!doctype html>
<html lang="ja">

<head>
    <?php
    $pageTitle = "使い方・対応一覧";
    $pageDesc = "恋乃夜まい（まいちゃん）の配信・活動をまとめて通知できるサービス「まいちゃん通知」の使い方解説。YouTube・TwitCasting・Twitch・Twitter・Pixiv Fanbox・bilibili の配信を、PCやスマホ（PWA・Androidアプリ）でまとめて受け取れます。対応プラットフォーム・通知の設定方法・よくある質問を紹介。";

    // FAQ 構造化データ（検索のリッチリザルト対策）
    $faqJsonLd = json_encode(array(
        '@context' => 'https://schema.org',
        '@type' => 'FAQPage',
        'mainEntity' => array(
            array(
                '@type' => 'Question',
                'name' => 'まいちゃん通知は何のサービスですか？',
                'acceptedAnswer' => array(
                    '@type' => 'Answer',
                    'text' => 'バーチャルYouTuber「恋乃夜まい（まいちゃん）」の配信・活動をリアルタイムでお知らせしてくれる非公式の通知サービスです。配信の開始やツイート、動画の投稿を、ブラウザ通知やスマホへのプッシュ通知で受け取れます。',
                ),
            ),
            array(
                '@type' => 'Question',
                'name' => '利用するのに料金はかかりますか？',
                'acceptedAnswer' => array(
                    '@type' => 'Answer',
                    'text' => '無料です。ブラウザで通知を許可するだけで、登録なしで利用できます。Googleアカウントでのログインは、通知設定を別の端末へ引き継ぐために使えます（任意）。',
                ),
            ),
            array(
                '@type' => 'Question',
                'name' => '対応している配信プラットフォームは？',
                'acceptedAnswer' => array(
                    '@type' => 'Answer',
                    'text' => 'YouTube（配信・動画・コミュニティ）、TwitCasting、Twitch、Twitter（メイン・サブ）、Pixiv Fanbox、bilibili に対応しています。配信の差し込みやコミュニティ投稿などもお知らせします。',
                ),
            ),
            array(
                '@type' => 'Question',
                'name' => 'スマホでも通知を受け取れますか？',
                'acceptedAnswer' => array(
                    '@type' => 'Answer',
                    'text' => 'はい。ホーム画面に追加して使うPWA（Webアプリ）として利用でき、ブラウザのプッシュ通知に対応しています。Android向けには専用アプリも配布しています。',
                ),
            ),
            array(
                '@type' => 'Question',
                'name' => '過去の配信アーカイブを探せますか？',
                'acceptedAnswer' => array(
                    '@type' => 'Answer',
                    'text' => '「配信アーカイブ検索」ページで、恋乃夜まいの過去の配信をタイトル・文字起こし・コメント・ライブチャットから全文検索できます。検索結果からYouTubeの該当時刻に直接ジャンプ可能です。',
                ),
            ),
            array(
                '@type' => 'Question',
                'name' => '公式のサービスですか？',
                'acceptedAnswer' => array(
                    '@type' => 'Answer',
                    'text' => 'いいえ。ファン有志による非公式のサービスです。開発の様子はGitHubで公開しています。',
                ),
            ),
        ),
    ), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG);

    $extraHead = '<link rel="stylesheet" href="/css/guide.css?v=' . @filemtime(__DIR__ . '/css/guide.css') . '" />';
    include __DIR__ . '/head.php';
    ?>
    <?php if ($faqJsonLd !== ''): ?>
    <script type="application/ld+json"><?= $faqJsonLd ?></script>
    <?php endif; ?>
</head>

<body id="app-body">
    <div id="header-slot">
        <?php include __DIR__ . '/header.php'; ?>
    </div>

    <main>
        <section class="service-intro">
            <h1>まいちゃん通知の使い方（対応プラットフォーム・設定方法）</h1>

            <p>
                <strong>まいちゃん通知</strong> は、バーチャルYouTuber <strong>恋乃夜まい</strong>（Koinoya Mai / まいちゃん）の
                <strong>配信・活動をお知らせしてくれる非公式の通知サービス</strong>です。
                YouTube や TwitCasting などの配信が始まると、PCやスマホへリアルタイムで通知を届けます。
            </p>

            <h2>できること</h2>
            <ul>
                <li>配信が始まったらすぐに通知（YouTube / TwitCasting / Twitch / bilibili）</li>
                <li>動画の投稿・コミュニティ投稿・ツイート（メイン/サブ）も通知</li>
                <li>Pixiv Fanbox（ファンクラブ）の新着投稿通知</li>
                <li>まいちゃんの配信スケジュール・記念日（推し日数）の表示</li>
                <li>過去の配信を文字起こし・コメントから全文検索できるアーカイブ検索</li>
            </ul>

            <h2>使い方（3ステップ）</h2>
            <ol class="step-list">
                <li>トップページ（通知ダッシュボード）を開く</li>
                <li>「通知を受信する」をONにする（ブラウザの許可を求められたら許可する）</li>
                <li>受け取りたいプラットフォームだけON/OFFを調整して完了</li>
            </ol>
            <p>ホーム画面に追加（PWA）すれば、アプリのように使えてスマホにもプッシュ通知を送れます。Android向けには専用アプリも配布しています。</p>

            <h2>対応プラットフォーム一覧</h2>
            <ul>
                <li><strong>YouTube</strong> ─ 配信・動画・コミュニティ投稿（ほぼ無遅延）</li>
                <li><strong>TwitCasting</strong> ─ 配信通知（ほぼ無遅延）</li>
                <li><strong>Twitch</strong> ─ 配信通知</li>
                <li><strong>bilibili</strong> ─ 投稿通知</li>
                <li><strong>Twitter（X）</strong> ─ メイン（@koinoya_mai）・サブ（@koinoyamai17）のツイート（約1分）</li>
                <li><strong>Pixiv Fanbox</strong> ─ ファンクラブの新着投稿（約3分）</li>
                <li><strong>記念日（ミルストーン）</strong> ─ 登録者数など節目のお知らせ</li>
            </ul>

            <h2>アーカイブや過去の配信を探したい場合</h2>
            <p>
                恋乃夜まいの過去の配信は、<a href="/archive">配信アーカイブ検索</a>ページから検索できます。
                タイトルはもちろん、<strong>配信の文字起こし・コメント・ライブチャット</strong>まで全文検索できるので、
                「この歌枠で何を歌ってた？」といった探し方もできます。ツイートに載せられたメディア（画像・動画）のアーカイブは
                <a href="/twitter-media/">メディアアーカイブ</a>をご覧ください。
            </p>

            <h2>よくある質問</h2>
            <div class="faq-list">
                <?php foreach (json_decode($faqJsonLd, true)['mainEntity'] as $q): ?>
                <details>
                    <summary><?= htmlspecialchars($q['name']) ?></summary>
                    <div class="faq-a"><?= htmlspecialchars($q['acceptedAnswer']['text']) ?></div>
                </details>
                <?php endforeach; ?>
            </div>

            <h2>関連ページ</h2>
            <div class="link-row">
                <a href="/">通知ダッシュボード</a>
                <a href="/archive">配信アーカイブ検索</a>
                <a href="/twitter-media/">メディアアーカイブ</a>
                <a href="/logs/">更新履歴</a>
                <a href="/status">システム稼働状況</a>
                <a href="/info/">このサービスについて</a>
                <a href="/future/">今後の開発予定</a>
                <a href="/download/">アプリダウンロード（Android / Windows）</a>
            </div>
        </section>

        <a href="/" style="text-decoration:none; color:inherit; display:block;">
            <div style="background-color:#FFF; min-height:60px; display:flex; align-items:center; justify-content:center; padding:10px 20px;">
                <h3 style="margin:0;">通知ダッシュボードに戻る</h3>
            </div>
        </a>
    </main>

    <div id="footer-slot">
        <?php include __DIR__ . '/footer.php'; ?>
    </div>

    <script src="/ios-helper.js" defer></script>
    <script type="module" src="/dist/main.bundle.min.js?v=<?= @filemtime(__DIR__ . '/dist/main.bundle.min.js') ?: time(); ?>" defer></script>
</body>

</html>