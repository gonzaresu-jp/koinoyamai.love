<!doctype html>
<html lang="ja">

<head>
    <?php
    $pageTitle = "今後の開発予定";
    $pageDesc = "まいちゃん通知の今後の開発予定、新機能追加、既知の問題に対する修正などをまとめています。";
    $extraHead = '<link rel="stylesheet" href="/css/future.css?v=' . @filemtime(__DIR__ . '/css/future.css') . '" />';
    include __DIR__ . '/head.php';
    ?>
</head>

<body id="app-body">
    <div id="header-slot">
        <?php include __DIR__ . '/header.php'; ?>
    </div>

    <main>
        <section class="future-intro">
            <h2>新機能追加予定</h2>
            <ul class="plan-list">
                <li>
                    <strong>他配信プラットフォームのアーカイブ対応とデータ分析</strong>
                    <span class="note">Twitch・TwitCasting等のアーカイブ追加と横断分析。字幕・アーカイブ保存にコストがかかるため、資金状況を見ながら段階的に検討。</span>
                </li>
                <li>
                    <strong>まいちゃんwikiの追加</strong>
                    <span class="note">衣装・用語・登場人物・配信史などの項目を順次追加し、アーカイブや要約と相互リンクさせて人物wikiを拡充。</span>
                </li>
            </ul>

            <h2>実装済み</h2>
            <ul class="plan-list done-list">
                <li>
                    <strong>登録者推移データの自動更新</strong>
                    <span class="note">毎日0:05にYouTube Data APIから登録者数を取得し、推移グラフへ自動反映。手動更新は不要になりました。</span>
                </li>
                <li>
                    <strong>配信アーカイブのカテゴリ自動分類</strong>
                    <span class="note">配信タイトル・タグ・概要欄・字幕からカテゴリを自動判定して付与。確信度の高いものだけを対象にし、手動設定は尊重します。</span>
                </li>
                <li>
                    <strong>まいちゃんの状態予測</strong>
                    <span class="note">投稿時刻・曜日・感情などの統計から、配信意欲・体調サイン・今後7日間の配信見込みを「活動傾向（推定）」として管理画面に表示。</span>
                </li>
                <li>
                    <strong>字幕生成の精度向上</strong>
                    <span class="note">Whisperによる自動字幕生成を導入し、字幕の無い配信も順次テキスト化。アーカイブ検索・要約の対象を拡大しました。</span>
                </li>
                <li>
                    <strong>LLM処理の精度・速度向上</strong>
                    <span class="note">解析モデルを刷新（Gemini 3.5 flash-lite・Groqフォールバック等）し、分類・要約・流行語抽出の精度と安定性を向上。</span>
                </li>
            </ul>

            <h2>既知の問題</h2>
            <ul class="plan-list">
                <li>
                    <strong><s>登録者推移グラフの更新遅延</s></strong>
                    <span class="note"><s>登録者推移データの自動更新により、グラフが最新日まで反映されるようになったため解消しました。</s></span>
                </li>
                <li>
                    <strong><s>PubSubHubbub障害でYTの通知が届かなくなる</s></strong>
                    <span class="note"><s>YouTubeの配信枠（待機所）・配信開始の検知はpubsubhubbub（Webhook購読）に依存しており、このサービスが障害になると通知が届かなくなる問題を調査中でした。対策として、RSSフィード＋videos APIによる定期ポーリング（配信枠を取得する仕組みは実装済み）を併用し、PubSubHubbubより先に枠を検知してまだ通知していない場合はこちらから通知する仕組みへの変更を検討していました。RSSフォールバックスキャンを5分間隔で常時稼働させ、配信枠【予定】と配信開始【ライブ】の通知を冗長化する実装を完了しました（webhook と records フラグを共有するため重複通知なし）。</s></span>
                </li>
                <li>
                    <strong><s>YTコミュニティやbilibiliの検出</s></strong>
                    <span class="note"><s>これらのプラットフォームの検出ができていない問題を調査中でしたが、通知への対応を実装しました。</s></span>
                </li>
                <li>
                    <strong><s>Fanboxの誤検知</s></strong>
                    <span class="note"><s>公式バナーを新規投稿として検知してしまう問題を修正しました。</s></span>
                </li>
                <li>
                    <strong><s>Twitterリポストの誤処理</s></strong>
                    <span class="note"><s>リポストに対してスケジュールを追加してしまう問題を修正しました。</s></span>
                </li>
                <li>
                    <strong><s>AIスケジュール追加の制限</s></strong>
                    <span class="note"><s>YouTube以外のプラットフォームでもタイトル・URLが付与されるよう対応しました（Twitch・TwitCasting等）。</s></span>
                </li>
                <li>
                    <strong><s>記念日通知の重複</s></strong>
                    <span class="note"><s>記念日通知が重複して送信されてしまう不具合を修正しました。</s></span>
                </li>
                <li>
                    <strong><s>リンク先カスタム設定</s></strong>
                    <span class="note"><s>リンク先カスタム設定の動作確認が完了し、クローム用のカスタムスキームにも対応しました。</s></span>
                </li>
                <li>
                    <strong><s>ヒートマップのスクロール不具合</s></strong>
                    <span class="note"><s>スマートフォン環境でヒートマップのスクロールが正常に動作しない問題を修正しました。</s></span>
                </li>
                <li>
                    <strong><s>プロセスステータス</s></strong>
                    <span class="note"><s>プロセスステータスの表示が不完全な問題を修正しました。</s></span>
                </li>
            </ul>
        </section>

        <a href="/" style="text-decoration:none; color:inherit; display:block;">
            <div style="
                background-color:#FFF;
                min-height:60px;
                display:flex;
                align-items:center;
                justify-content:center;
                padding:10px 20px;
                border-radius: 12px;
            ">
                <h3 style="margin:0;">通知ダッシュボードに戻る</h3>
            </div>
        </a>
    </main>

    <div id="footer-slot">
        <?php include __DIR__ . '/footer.php'; ?>
    </div>

    <!-- iOS Helper -->
    <script src="/ios-helper.js" defer></script>
    <script type="module" src="/dist/main.bundle.min.js?v=<?= @filemtime(__DIR__ . '/dist/main.bundle.min.js') ?: time(); ?>" defer></script>

</body>

</html>