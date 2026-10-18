<header>
    <div class="header-left">
        <img src="/icon.webp" alt="まいちゃんロゴ" class="logo fade" fetchpriority="high" />
        <a href="/" rel="noopener noreferrer" style="text-decoration: none; color: inherit;">
            <h2 class="fade">まいちゃん通知</h2>
        </a>
        <a href="/status" class="header-status-link fade" id="header-status-indicator" title="システムの稼働状況">
            <span class="status-dot"></span>
        </a>
        <!-- 日本時間（端末が日本TZ以外のときだけ header-jst.js が表示する） -->
        <span class="header-jst" id="header-jst" hidden title="日本時間（JST）">
            <span class="header-jst-label">JST</span>
            <span class="header-jst-time" id="header-jst-time">--:--</span>
        </span>
    </div>

    <!-- ログインボタン（ヘッダー右側に常時表示） -->
    <div class="header-auth fade" id="header-auth">
        <!-- 未ログイン時 -->
        <button class="auth-login-btn google" id="header-login-btn" style="display:none;" onclick="headerLoginWithGoogle()"
            aria-label="Googleでログイン">
            <svg width="16" height="16" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true">
                <path
                    d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
                    fill="#4285F4" />
                <path
                    d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
                    fill="#34A853" />
                <path
                    d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"
                    fill="#FBBC05" />
                <path
                    d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z"
                    fill="#EA4335" />
            </svg>
        </button>

        <!-- ログイン済み時 -->
        <div class="auth-user-chip" id="header-user-chip" style="display:none;">
            <img class="auth-avatar" id="header-avatar" src="" alt="ユーザーアバター" width="28" height="28" />
        </div>

        <!-- 読み込み中 -->
        <div class="auth-loading" id="header-auth-loading">
            <span class="auth-loading-dot"></span>
        </div>
    </div>

    <div class="hamburger-icon fade" id="hamburger-toggle" role="button" tabindex="0" aria-label="メニューを開く"
        aria-controls="nav-menu" aria-expanded="false">
        <span></span>
        <span></span>
        <span></span>
    </div>

    <nav id="nav-menu" aria-label="ハンバーガーメニュー">
        <ul class="nav-list">
            <li><button id="btn-send-test">テスト通知を送信</button></li>

            <li class="menu-notification-toggle">
                <!-- 画像切り替えコンテナ -->
                <div class="toggle-image-container">
                    <img src="/off.webp" alt="通知オフ" class="toggle-image off" loading="lazy" decoding="async" />
                    <img src="/on.webp" alt="通知オン" class="toggle-image on" loading="lazy" decoding="async" />
                </div>

                <div class="toggle-controls-wrapper">
                    <span>通知を受信する</span>
                    <div class="toggle-notify">
                        <input id="toggle-notify" type="checkbox" aria-label="通知を受信する" />
                        <span class="slider" aria-hidden="true"></span>
                    </div>
                </div>
            </li>

            <!-- ナビメニュー内のログイン情報（ログイン済み時のみ表示） -->
            <li class="nav-setting-item nav-auth-info" id="nav-auth-info" style="display:none;">
                <div class="nav-user-info">
                    <img class="nav-auth-avatar" id="nav-avatar" src="" alt="ユーザーアバター" width="36" height="36" />
                    <div class="nav-user-text">
                        <span class="nav-user-name" id="nav-display-name"></span>
                        <span class="nav-user-email" id="nav-email"></span>
                    </div>
                </div>
                <!-- 推し日数（ログイン時はサーバー保存値を表示） -->
                <div class="nav-oshi-info" id="nav-oshi-info" style="display:none;">
                    <i class="fa-solid fa-heart" style="color:#e75480;font-size:0.8rem;"></i>
                    <span id="nav-oshi-days-text"></span>
                </div>
            </li>

            <!-- ログインCTA（未ログイン時のみ表示） -->
            <li class="nav-setting-item nav-login-cta" id="nav-login-cta">
                <div class="nav-login-prompt">
                    <p class="nav-login-desc">ログインするとどのデバイスからでも<br>通知設定や推し日数を引き継げます</p>
                    <div class="nav-login-btns">
                        <button class="nav-auth-btn google" onclick="headerLoginWithGoogle()">
                            <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" fill="#4285F4" />
                                <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853" />
                                <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05" />
                                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z" fill="#EA4335" />
                            </svg>
                            Googleでログイン
                        </button>
                    </div>
                </div>
            </li>
            <!-- ログアウトボタン（ログイン済み時のみ） -->
            <li id="nav-logout-item" style="display:none;">
                <button onclick="headerLogout()" class="nav-logout-btn">
                    <img id="nav-logout-avatar" class="nav-logout-avatar" src="" alt="ユーザーアバター">
                    <i class="fa-solid fa-right-from-bracket" style="margin-right:6px;"></i>ログアウト
                </button>
            </li>

            <li class="nav-setting-item">
                <div id="subscriber-name-settings" class="platform-subscriber-name-section">

                    <div class="platform-name-row">
                        <div class="platform-name-label">ユーザー名</div>
                    </div>

                    <div class="platform-name-controls">
                        <div class="subscriber-input-wrapper">
                            <input id="subscriber-name-input" type="text" class="platform-name-input"
                                placeholder="ユーザー名を入力">

                            <img id="subscriber-linked-icon" class="subscriber-linked"
                                src="https://img.icons8.com/?size=100&id=sz8cPVwzLrMP&format=png&color=000000"
                                alt="連携済みアイコン" style="display:none;">
                        </div>

                        <button id="subscriber-name-submit" class="platform-setting-button">保存</button>
                    </div>

                    <label for="start" class="platform-name-row">推し始め</label>
                    <input type="date" id="start" name="trip-start" min="2020-01-01" max="2099-12-31"
                        title="推し始めの日付を選択してください" />

                    <div id="subscriber-name-status" class="platform-name-status"></div>
                </div>
            </li>




            <li class="nav-setting-item">
                <div id="platform-settings">
                    <ul class="platform-settings-list">
                        <li>
                            <button id="toggle-twitcasting" class="platform-setting-button is-on">
                                TwitCasting: ON
                            </button>
                        </li>
                        <li>
                            <button id="toggle-youtube" class="platform-setting-button is-on">
                                YouTube: ON
                            </button>
                        </li>
                        <li>
                            <button id="toggle-youtube-community" class="platform-setting-button is-on">
                                YouTube Community: ON
                            </button>
                        </li>
                        <li>
                            <button id="toggle-twitch" class="platform-setting-button is-on">
                                Twitch: ON
                            </button>
                        </li>
                        <li>
                            <button id="toggle-bilibili" class="platform-setting-button is-on">
                                Bilibili: ON
                            </button>
                        </li>
                        <li>
                            <button id="toggle-fanbox" class="platform-setting-button is-on">
                                Pixiv Fanbox: ON
                            </button>
                        </li>
                        <li>
                            <button id="toggle-twitter-main" class="platform-setting-button is-on">
                                Twitter(@koinoya_mai): ON
                            </button>
                        </li>
                        <li>
                            <button id="toggle-twitter-sub" class="platform-setting-button is-on">
                                Twitter(@koinoyamai17): ON
                            </button>
                        </li>
                        <!--<li>
                                <button id="toggle-gipt" class="platform-setting-button is-on">
                                    Gipt: ON
                                </button>
                            </li>-->
                        <li>
                            <button id="toggle-milestone" class="platform-setting-button is-on">
                                記念日通知: ON
                            </button>
                        </li>
                        <li>
                            <button id="toggle-schedule" class="platform-setting-button is-on">
                                スケジュール: ON
                            </button>
                        </li>
                    </ul>
                </div>
            </li>

            <li class="nav-section-label"><i class="fa-solid fa-play" aria-hidden="true"></i>コンテンツ</li>
            <li><a href="/archive" rel="noopener noreferrer"><i class="fa-solid fa-film" aria-hidden="true"></i>配信アーカイブ検索</a></li>
            <li><a href="/twitter-media/" rel="noopener noreferrer"><i class="fa-solid fa-images" aria-hidden="true"></i>メディアアーカイブ</a></li>

            <li class="nav-section-label"><i class="fa-solid fa-circle-info" aria-hidden="true"></i>情報</li>
            <li><a href="/guide.php" rel="noopener noreferrer"><i class="fa-solid fa-book-open" aria-hidden="true"></i>使い方・対応一覧</a></li>
            <li><a href="/logs/" rel="noopener noreferrer"><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i>Update logs</a></li>
            <li><a href="/future/" rel="noopener noreferrer"><i class="fa-solid fa-rocket" aria-hidden="true"></i>今後の開発予定</a></li>

            <li class="nav-section-label"><i class="fa-solid fa-life-ring" aria-hidden="true"></i>サポート</li>
            <li><a href="/status" rel="noopener noreferrer"><i class="fa-solid fa-heart-pulse" aria-hidden="true"></i>システム稼働状況</a></li>
            <li><a href="https://form.jotform.com/253191048959063" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-bug" aria-hidden="true"></i>不具合報告</a></li>
            <li><a href="/download/" rel="noopener noreferrer"><i class="fa-solid fa-download" aria-hidden="true"></i>アプリをダウンロード（Android / Windows）</a></li>
            <li><a href="https://github.com/gonzaresu-jp/Mai-notification" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-github" aria-hidden="true"></i>GitHubページ(使用方法)</a></li>


        </ul>
    </nav>

    <div id="menu-overlay" style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 999; display: none;">
    </div>
</header>



<script src="/js/header-auth.js?v=<?= @filemtime(__DIR__ . '/js/header-auth.js') ?: time(); ?>"></script>
<script src="/js/header-jst.js?v=<?= @filemtime(__DIR__ . '/js/header-jst.js') ?: time(); ?>" defer></script>