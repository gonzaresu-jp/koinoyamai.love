<?php
require __DIR__ . "/updatelogs.php";
$lastUpdatedDate = "";
foreach ($updateLogs as $log) {
    if (!empty($log["date"]) && strcmp($log["date"], $lastUpdatedDate) > 0) {
        $lastUpdatedDate = $log["date"];
    }
}
?>
<footer id="siteFooter">

  <p>Mai's Platform</p>

  <div class="footer-links icon-row">

    <!-- YouTube (main) -->
    <a class="icon-link" href="https://www.youtube.com/@koinoyamaich" target="_blank" rel="noopener noreferrer"
      aria-label="YouTube (main)" data-tooltip="YouTube (main)">
      <picture>
        <source srcset="/logo/yt-main.webp" type="image/webp">
        <img src="/assets/icons/youtube-sub.svg" alt="YouTube">
      </picture>
    </a>

    <!-- YouTube (sub) -->
    <a class="icon-link" href="https://www.youtube.com/@koinoyamaich" target="_blank" rel="noopener noreferrer"
      aria-label="YouTube (sub)" data-tooltip="YouTube (sub)">
      <picture>
        <source srcset="/logo/yt-sub.webp" type="image/webp">
        <img src="/assets/icons/youtube-sub.svg" alt="YouTube">
      </picture>
    </a>

    <!-- X -->
    <a class="icon-link" href="https://x.com/koinoya_mai" target="_blank" rel="noopener noreferrer"
      aria-label="X (Twitter)" data-tooltip="X (Twitter)">
      <picture>
        <img src="/logo/twitter.svg" alt="twitter">
      </picture>
    </a>

    <!-- Fanbox -->
    <a class="icon-link" href="https://www.fanbox.cc/@koinoya-mai" target="_blank" rel="noopener noreferrer"
      aria-label="Pixiv Fanbox" data-tooltip="Pixiv Fanbox">
      <picture>
        <source srcset="/logo/fanbox.webp" type="image/webp">
        <img src="/assets/icons/fanbox.svg" alt="Pixiv Fanbox">
      </picture>
    </a>

    <!-- TwitCasting -->
    <a class="icon-link" href="https://twitcasting.tv/c:koinoya_mai" target="_blank" rel="noopener noreferrer"
      aria-label="TwitCasting" data-tooltip="TwitCasting">
      <picture>
        <source srcset="https://twitcasting.tv/img/top/icon_application02.png" type="image/png">
        <img src="https://twitcasting.tv/img/top/icon_application02.png" alt="TwitCasting">
      </picture>
    </a>

    <!-- Twitch -->
    <a class="icon-link" href="https://www.twitch.tv/koinoya_mai" target="_blank" rel="noopener noreferrer"
      aria-label="Twitch" data-tooltip="Twitch">
      <picture>
        <source srcset="https://assets.twitch.tv/assets/favicon-32-e29e246c157142c94346.png" type="image/png">
        <img src="https://assets.twitch.tv/assets/favicon-32-e29e246c157142c94346.png" alt="Twitch">
      </picture>
    </a>

    <!-- bilibili -->
    <a class="icon-link" href="https://space.bilibili.com/1900434152" target="_blank" rel="noopener noreferrer"
      aria-label="bilibili" data-tooltip="bilibili">
      <picture>
        <source srcset="https://www.bilibili.com/favicon.ico" type="image/ico">
        <img src="https://www.bilibili.com/favicon.ico" alt="bilibili">
      </picture>
    </a>

    <!-- マシュマロ -->
    <a class="icon-link" href="https://marshmallow-qa.com/koinoya_mai?t=HBJBYN" target="_blank"
      rel="noopener noreferrer" aria-label="マシュマロ" data-tooltip="マシュマロ">
      <picture>
        <source srcset="/logo/mashumaro.webp" type="image/webp">
        <img src="/logo/mashumaro.svg" alt="マシュマロ">
      </picture>
    </a>

    <!-- booth -->
    <a class="icon-link" href="https://koinoyamai.booth.pm/" target="_blank" rel="noopener noreferrer"
      aria-label="booth" data-tooltip="booth">
      <picture>
        <source srcset="https://asset.booth.pm/favicon.ico" type="image/ico">
        <img src="https://asset.booth.pm/favicon.ico" alt="booth">
      </picture>
    </a>

    <!-- Gipt -->
    <a class="icon-link" href="https://gi-pt.com/main/wishlist/fan-view/3a0fdc24-209e-d962-896b-cdd7d7828943"
      target="_blank" rel="noopener noreferrer" aria-label="Gipt" data-tooltip="Gipt">
      <picture>
        <source srcset="/logo/gipt.ico" type="image/ico">
        <img src="/logo/gipt.ico" alt="Gipt">
      </picture>
    </a>

    <!-- DLsite -->
    <a class="icon-link" href="https://www.dlsite.com/maniax/circle/profile/=/maker_id/RG01060252.html" target="_blank"
      rel="noopener noreferrer" aria-label="DLsite" data-tooltip="DLsite">
      <picture>
        <source srcset="https://www.dlsite.com/images/web/common/favicon.ico" type="image/ico">
        <img src="https://www.dlsite.com/images/web/common/favicon.ico" alt="DLsite">
      </picture>
    </a>

  </div>
  <nav class="footer-site-nav" aria-label="サイト内リンク">
    <div class="footer-nav-group">
      <p class="footer-nav-heading"><i class="fa-solid fa-play" aria-hidden="true"></i>コンテンツ</p>
      <ul class="footer-nav-list">
        <li><a href="/"><i class="fa-solid fa-house" aria-hidden="true"></i>ホーム</a></li>
        <li><a href="/archive/"><i class="fa-solid fa-film" aria-hidden="true"></i>配信アーカイブ検索</a></li>
        <li><a href="/twitter-media/"><i class="fa-solid fa-images" aria-hidden="true"></i>メディアアーカイブ</a></li>
      </ul>
    </div>
    <div class="footer-nav-group">
      <p class="footer-nav-heading"><i class="fa-solid fa-circle-info" aria-hidden="true"></i>情報</p>
      <ul class="footer-nav-list">
        <li><a href="/guide/"><i class="fa-solid fa-book-open" aria-hidden="true"></i>使い方・対応一覧</a></li>
        <li><a href="/logs/"><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i>アップデート履歴</a></li>
        <li><a href="/future/"><i class="fa-solid fa-rocket" aria-hidden="true"></i>今後の開発予定</a></li>
        <li><a href="/info/"><i class="fa-solid fa-circle-question" aria-hidden="true"></i>このサービスについて</a></li>
      </ul>
    </div>
    <div class="footer-nav-group">
      <p class="footer-nav-heading"><i class="fa-solid fa-life-ring" aria-hidden="true"></i>サポート</p>
      <ul class="footer-nav-list">
        <li><a href="/status/"><i class="fa-solid fa-heart-pulse" aria-hidden="true"></i>システム稼働状況</a></li>
        <li><a href="/download/"><i class="fa-solid fa-download" aria-hidden="true"></i>アプリをダウンロード</a></li>
        <li><a href="https://form.jotform.com/253191048959063" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-bug" aria-hidden="true"></i>不具合報告</a></li>
        <li><a href="https://github.com/gonzaresu-jp/Mai-notification" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-github" aria-hidden="true"></i>GitHubページ</a></li>
      </ul>
    </div>
  </nav>
  <p><a href="/logs/">Last updated <?= htmlspecialchars($lastUpdatedDate) ?></a></p>
</footer>
