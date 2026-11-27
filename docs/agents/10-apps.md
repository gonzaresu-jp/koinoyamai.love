# AGENTS §10 Windows / Android アプリ

> `AGENTS.md` から分割した詳細（§番号は AGENTS.md と共通）。索引と必読ルールは リポジトリ直下の `AGENTS.md`。

## 10. WinUI アプリ（Windows/mai-push-winui）デプロイ注意

- **実行ファイルはローカルドライブから起動すること（2回目の事故: 2026-10-13）**
  - `Q:\` などのネットワーク共有（UNC パス含む）から起動すると `EnsureCoreWebView2Async` が
    COMException で失敗し WebView2 が一切描画されない。
  - ビルド出力: `$(LOCALAPPDATA)\MaiPushWinUI\` に固定済み（`BaseOutputPath` + `PublishDir`）。
  - `dotnet publish` 後の正規パス: `%LOCALAPPDATA%\MaiPushWinUI\publish\まいちゃん通知.exe`
  - **ネットワークドライブ上の publish/ ディレクトリからは起動しないこと**。
- **トレイアイコンのパスは必ず `AppContext.BaseDirectory` 起点の絶対パスにすること（v1.8.2 教訓）**
  - Run キー（自動起動）で起動したプロセスの CWD は `C:\Windows\System32` になる。
    相対パス `Assets\tray-icon.ico` は File.Exists=false → TaskbarIcon.Icon=null のまま
    ForceCreate → Shell_NotifyIcon に空ハンドル → **トレイに「透明な空きアイコン」が残る**。
  - 同様に `_appWindow.SetIcon()` も相対パスは自動起動時に失敗する。
- **トースト表示（NotificationHelper.ShowToast）は例外を握りつぶすこと**
  - WinRT コールバック（CoreMessaging / DispatcherQueue 経由）内での未処理例外は
    stowed exception (0xc000027b) としてプロセスごと落ちる。WER では
    combase.dll (E_INVALIDARG/E_FAIL) × CoreMessagingXP.dll / Microsoft.UI.Xaml.dll の
    フォールトが多発していた（v1.8.2 で診断強化: `%LOCALAPPDATA%\MaiPush\log.txt` に例外ログ、
    WER LocalDumps でミニダンプ収集、RegisterApplicationRestart で自動再起動）。
- **UI コールバック（`DispatcherQueue` の Tick / `WndProc`）は例外境界で包むこと（2026-10-20, Issue #10）**
  - `StartHoverPoller` の `Tick` は try/catch 必須。例外は `%LOCALAPPDATA%\MaiPush\log.txt` に
    ウィンドウ状態（hwnd/alive/visible/minimized/DPI/カーソル/ストリップ状態）付きで記録し、
    ポーリングを停止する（`StopHoverPoller` / `DescribeWindowState`）。
    80ms 周期で例外が出続けてログが溢れるのを防ぐ。**停止は1セッション限り（再開しない）**。
  - `WndProc` は `WndProcCore` を呼ぶ薄い wrapper。例外時は `CallWindowProc` へフォールバックする
    （未処理例外はプロセスごと落ちる）。`WM_NCHITTEST`/`WM_SETCURSOR` は毎秒100回以上来るため、
    ログは `LogWndProcFault` で**5秒に1回**に制限し、抑制件数も併記する（同期ログでポンプが詰まる）。
  - 新しく `DispatcherQueue.TryEnqueue` で UI 処理を投げるときは `EnqueueUi(source, action)` を使う。
  - `_appWindow.Changed`（.AppWindow イベント）も UI スレッドのコールバック。例外境界を置き、
    `UpdateCaptionPadding` のように **最小化/復帰で不正値になり得る値**（`TitleBar.RightInset` は
    NaN/Infinity になり得る）を UI に代入する前に弾くこと（v1.8.5 教訓）。
  - **Google / Discord ログインは「システムブラウザ＋ループバック」で行う**（v1.8.8・2026-10-24 実測）:
    - Google は**埋め込みブラウザ（WebView）でのサインインをポリシーで止めている**。
      WebView2 内で `/auth/google` を進めると Google のページで止まって戻ってこない
      （実測: アプリからの開始 **7 回**・コールバック **0 回**／通常ブラウザでは成功）。
      UA を Chrome に偽装しても通らない。**WebView2 内で OAuth を進めようとしないこと**。
    - → `MainWindow.NavigationStarting` が `/auth/google`・`/auth/discord` を**キャンセル**し、
      **既定ブラウザ**で開く（`returnTo` を `http://127.0.0.1:&lt;空きポート&gt;/callback` に差し替え）。
    - サーバーは `returnTo` が loopback のとき **Cookie ではなく単発コード**（60 秒）を返す
      （`routes/user-auth.js` の `isAllowedDesktopCallback`。**サーバー側はもともと対応済み**）。
      アプリはそのコードを `POST /auth/token-exchange` でセッショントークンに交換し、
      `CoreWebView2.CookieManager.AddOrUpdateCookie` で WebView2 に注入して再読込する
      （実装は `Windows/mai-push-winui/DesktopLogin.cs`）。
    - **GCP 側の登録変更は不要**（`redirect_uri` は常に
      `https://koinoyamai.love/auth/google/callback`。loopback は `returnTo` にしか使わない）。
    - ループバックは **`TcpListener`**（`HttpListener` は非管理者での URL ACL 問題を避けるため使わない）。
      1 回限り・180 秒で失効。コードは base64url の書式チェックしてから交換する。
    - Cookie 期限は `JWT_EXPIRES_IN`（30d）に合わせる。Cookie 名は `AUTH_COOKIE_NAME`（既定 `session`）。
  - **通知をタップしたら「既定ブラウザ」で中身を開く**（v1.8.7 教訓・2026-10-22 実測）:
    - Windows アプリは web push / SSE を **ネイティブトースト**へ変換して表示する
      （`core.NotificationReceived` → `NotificationHelper.ShowToast`）。
      このとき **トーストの launch に URL を載せてください**
      （`builder.AddArgument("url", url)`）。
      載せないと通知をタップしても「アプリが前面に出る」だけで
      YouTube 等の中身が開かず、ユーザーが「開かない」と抱怨になります（実測）。
    - **URL を運ぶのは SSE 経路**（`MainWindow.HandleWebMessage`）です。
      `CoreWebView2Notification` に `data` / `AdditionalInfo` は**無い**ので、
      WebView2 由来の通知から URL を取り出そうとしてはいけません
      （`CS1061` でビルドが壊れます。独立レビューで検出）。
      そもそも WinUI アプリには**実 web push が届きません**
      （`pushManager` を `webview2://` で偽装しており、サーバーは非 http エンドポイントを
      弾く＝`services/notification.js`）。通知は **SSE 経由**でしか来ない
    - クリック時の処理は `App.xaml.cs` の `OnNotificationInvoked`。
      `Arguments["url"]` があれば **既定ブラウザ**（`Process.Start` + `UseShellExecute`）で開き、
      **アプリは前面に出さない**（ブラウザのフォーカスを奪わない）。
      「ブラウザを開いたか」は**ローカル変数**で持つこと（フィールドにすると
      一度開いた後、URL 無しの通知でアプリは前面に出なくなる）
    - アプリが起動していない状態で通知をタップされた場合も、
      `OnLaunched` は `AppInstance.GetCurrent().GetActivatedEventArgs()` で
      **AppNotification による起動か**を判定し（`ExtendedActivationKind.AppNotification`）、
      通知の到着を待ってから、ブラウザで開くだけならウィンドウを表示しない。
      判定は `AppInstance` が使えない環境（try/catch）で通常の起動にフォールバックする。
      タイムアウト（3秒）で「来なかった」判定にして permanently 待たないこと
    - `ShowToast` の第4引数は **http/https だけ**渡す（他の scheme を OS に渡さない）
  - **UI コールバックの例外ログは連発を制限する**（v1.8.6 教訓, Issue #17）。`AppWindow.Changed` や
    `EnqueueUi` の例外境界は繰り返し失敗しうるため、毎回 `Diagnostics.Log` すると
    UI スレッドの同期ファイル書き込みが連発して操作がもたくなり、`log.txt` も溢れる。
    `Diagnostics.ThrottledFault`（5 秒に 1 回へ制限し、抑制件数を 1 行で併記）を使うこと。
  - 非表示（トレイ格納）・**最小化中**はストリップを閉じた状態に戻す（`ResetTabStripHidden`）。
    最小化でも `IsWindowVisible` は true なので `IsIconic` も見ること。ドラッグ中に隠れた場合に備え
    ポインターキャプチャとドラッグ状態もここで畳む。
- **Release publish は self-contained（csproj の `<SelfContained>`）**
  - framework-dependent publish でインストールすると、グローバル .NET 構成が揃わない環境・
    InstallDelete 後のタイミングで「No frameworks were found」で自動起動失敗する。
- **待ちタイマーは連打で延長しないこと（v1.8.5 教訓, Issue #14）**
  - `DispatcherQueueTimer` を**毎回作り直して** `Stop()`→`Start()` すると、80ms 周期のポーリング
    （`OnHoverTick`）や `WM_NCMOUSEMOVE` から毎フレーム要求された場合に、待ちが 400ms を超えて
    永久に延長され、**折りたたみなどが一生起きない**（タブバーが出たままで問題）。
  - 「予約済み」フラグ（`_collapsePending`）で延長を止める。フラグは
    **予約= `StartCollapseTimer`／解除= Tick ハンドラ・`CancelCollapseTimer`・`ShowTabStrip`・
    `ResetTabStripHidden` の4経路**で必ずリセットすること（リセット漏れがあると
    以後折りたたみが起きない）。予約に失敗した場合もフラグを戻すこと。
  - **ドラッグ中は予約も Tick も畳まない**（`_tabStripPointerPressed` を見る）。ドラッグ終了時に
    `EndTabDrag` がカーソル位置を見て再予約する。ここを外すとドラッグ中にストリップが流れる。

### 10.1 アプリリリース手順（Windows / Android）— 2026-10-20（v1.8.3 / v1.7.2）で実施

- **バージョンは3箇所を揃える（Windows）**
  - `MaiPushWinUI.csproj` の `<Version>` / `installer.iss` の `#define MyAppVersion` /
    `UpdateChecker.cs` の `CurrentVersion`（`new(1, 8, 6)` のようにリリース版と揃える）。
  - `UpdateChecker.cs` を忘れると**最新版なのに「アップデートがあります」通知が出る**。
  - **機械検査が_parse可能になった**（2026-10-21 追加）:
    ```bash
    bash scripts/ops/check-app-version.sh    # 3箇所の整合（不一致で exit 1）
    ```
    - pre-push フックにも組み込み済み（`SKIP_PREPUSH_VERSION=1` でスキップ可）
    - GitHub Actions（`.github/workflows/ci.yml`）でも main へ push / PR 時に検査
      （バージョン整合・JS/PHP 構文・回帰テスト。Windows セッションからの push にも効く）
    - ビルド成果物を公開 repo に載せない運用なので、**CI 検査が唯一の守り**となる
- **Windows ビルド**
  - `dotnet publish MaiPushWinUI.csproj -c Release -r win-x64 -p:Platform=x64 --self-contained true`
    → `$(LOCALAPPDATA)\MaiPushWinUI\publish\`（csproj の `PublishDir` が固定）。
  - **ネットワークドライブ（`X:\`）からの `dotnet restore` が無応答になることがある**
    （2026-10-25、NuGet キャッシュが空の状態で 5 分以上進まなかった）。その場合は
    `bin` / `obj` を除いてプロジェクトをローカルドライブへコピーし、コピー先で publish する
    （`PublishDir` は csproj 固定なので出力先とインストーラ手順は変わらない）。
  - **publish ディレクトリはビルド前に空にする**（旧版 DLL が混ざると混在したままインストーラに入る）。
  - **ビルド中にアプリが publish 先の DLL を掴んでいると publish が失敗する**
    （`MSB3027: ... コピーできませんでした ... ファイルは ... によってロックされています`）。
    実機の exe が起動している場合は**必ず停止してから** publish する。失敗した publish のまま
    Inno Setup を回すと**修正前バイナリが混ざったインストーラ**ができるので、publish 失敗時は
    やり直すこと。
  - インストーラ: `"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss`
    → `Windows/mai-push-winui/installer/MaiPush-<ver>-Setup.exe`（`webui/dl/*.exe` は gitignore 対象）。
  - ⚠️ **`X:\`（SMB）への大容量ファイルのコピーは壊れることがある（2026-10-31 実測）**:
    `Copy-Item` で `webui/dl/MaiPush-1.8.9-Setup.exe` を置いたところ **19MB 以降が全てゼロ埋め**された
    （サイズは一致するので気づきにくい。そのまま配信するとインストーラが壊れる）。
    → **exe は `scp` でサーバへ送り、配置後に `sha256sum` がローカルのビルドと一致することを確認する**。
    さらに**公開 URL からダウンロードして再ハッシュ**する（Cloudflare/SMB 経路込みの確認）。
    一致するまで `webui/dl/desktop.json` を更新しないこと。
- **Android ビルドはネットワークドライブ（`Q:\`）では失敗する**
  - `:app:packageReleaseResources` が `dataBindingLayoutInfoOutFolder` の MD5 を作れず失敗する。
  - → **`mai_notification/` をローカルドライブへコピーして** `gradlew.bat assembleRelease` する
    （Gradle 8.13 / AGP 8.7.3 / JDK 21・`gradle/gradle-daemon-jvm.properties` 準拠）。
  - `mai_notification/local.properties`（`sdk.dir`）と `keystore.properties`（`storeFile`）は
    **マシン固有**（gitignore 対象）。Windows 側は Windows パスを書く
    （`C:/Users/<user>/AppData/Local/Android/Sdk` / `C:/Users/<user>/mai-keys/mai-notification-release.jks`）。
  - **署名鍵の SHA-256 が変わると上書きインストールできない**（`apksigner verify --print-certs` で
    既存 APK と一致することを確認してから配布する）。
- **配布の順序**: `webui/mai-notification.apk` と `webui/dl/MaiPush-<ver>-Setup.exe` を
  **先に配置してから** `webui/dl/android.json` / `desktop.json` を更新する
  （逆にすると更新フィードが 404 を指す）。
  - `desktop.json` の `url` の `?v=` は **サーバ側の ex の mtime**（`webui/dl/<exe>` の
    `filemtime`）に合わせる。`webui/download.php` が同じ基準で `?v=` を生成するため、
    ここだけ別の値になるとキャッシュキーが割れる（Windows 側のローカル mtime は
    JST 変換で 9 時間ずれるので使わない）。
  検証は `bash scripts/deploy/verify-deploy.sh webui/dl/desktop.json` 相当（配信バイト数 == ディスクのバイト数）。

### 10.2 配信開始アラーム（Android v1.7.3 で追加 / v1.7.4 で「止まるまで鳴らす」に強化）
- **目的**: 配信の 15 分前（など）に**端末内アラーム**を鳴らして、寝ていても起きて配信を見られるようにする。
  通知（FCM push）に頼らないので、push が届かない・遅延する環境でも鳴る。
- **方式は `AlarmManager.setAlarmClock()`**（`mai_notification/.../AlarmScheduler.kt`）:
  - 公式ドキュメント: 「the system never adjusts their delivery time / leaves low-power modes
    if necessary」→ **Doze（画面オフ・スリープ）でも正確な時刻に発火**する。
  - 「次のアラーム」としてシステムに登録されるので、ステータスバーにアラームアイコンが出る。
  - 権限: API 33+ は `USE_EXACT_ALARM`（自動付与・取り消し不可）／API 31/32 は
    `SCHEDULE_EXACT_ALARM`。**このアプリは Play ではなく APK 直配布**なので
    exact alarm の用途制限（Play ポリシー）は該当しない。
  - 権限が無い／取り消された場合は `canScheduleExactAlarms()` が false になり、
    アプリは**設定画面への誘導**に徹する（黙って不被にしない）。
  - 再起動でアラームは消えるため `RECEIVE_BOOT_COMPLETED` の receiver で再登録する。
- **スケジュールの取得**: サーバーの `GET /api/events?status=scheduled`（公開）。
  通知の `data.start_time` でも即時に登録できる（サーバーの `notifyPlannedFromRss` と
  `buildEventNotificationPayload` が `start_time` を載せる。`services/notification.js` の
  `buildFcmData` が `start_time` を FCM data に含める）。
- ⚠️ **サーバーの `start_time` はタイムゾーン表記が混在している**
  （`"2026-10-18T23:45:51"` = JST naive / `"...Z"` = UTC）。
  **オフセットが無いものは JST（+09:00）として解釈する**（`AlarmScheduler.parseServerTime`）。
  `§6.9` の smart-display と同じ前提。
- **設定 UI はサイト側**（`webui/js/stream-alarm.js` → `webui/dist/stream-alarm.min.js`）。
  アプリは WebView ラッパーなので、通知設定と同じ場所に UI を置いている。
  ブラウザ（Web のみ）では `window.MaiApp` が無いので非表示。
  - JS ブリッジ（`MaiWebBridge.kt`）: `getStreamAlarmState` / `setStreamAlarmEnabled` /
    `setStreamAlarmOffsetMin` / `openExactAlarmSettings` / `getNextStreamStartAt` /
    `openSystemAlarmSetScreen`
- **配信開始の通知はアラーム用チャネルで配信する**（`channel: "mai_stream_alarm"`）:
  - **ただし事前告知を送り済みの配信では鳴らさない（2026-10-24 追加）**:
    - 症状: 元々スケジュールにあった配信で「15 分前にアラームが鳴ったのに、開始でもう一度鳴った」
      （2026-10-23 の利用者報告）。開始 15 分前の端末内アラームと**二度鳴り**になり、
      逆に目覚めにくい。
    - 判定: **事前告知（`event_pre_*`）を 1 件でも送り済みかどうか**。送り済み＝予定どおりの配信
      → 通常チャネル。未送信＝事前告知が無い突然の配信 → アラーム用チャネル。
    - 実装は `src/core/notify-channel.js`（`startNotificationChannel(preNoticeSent)`・純関数）と
      `weekly/index.js` の `hasSentPreNotice(videoId)`（`events` × `scheduled_notifications`）。
    - **判定は送信直前に行う**。スケジューラ側は生成時に payload を JSON 化して保存するため、
      生成時に判定すると事前告知がまだ未送信の段階で「突然」に誤判定してアラームが付く
      （`dispatchDueEventNotifications` が送信直前に外す）。
    - `hasSentPreNotice` は **`platform` で絞らない**（`external_id` / `url` で照合）。予定が
      Twitter/Gemma 経由で先に作られ `platform='twitter'` のまま YouTube 配信と紐づく実データが
      ある（2026-10-23 の配信）。取り出せないときは **false（アラーム側）** に倒す
      （不鳴りは起きられないことにつながるため）。
    - **判断の規則は webhook / RSS フォールバック / スケジューラの 3 経路で共通**（経路で
      挙動を分けると「突然なのに鳴らない」が起きる＝検知の勝敗は毎回変わる）。
      照合関数は 2 経路が `hasSentPreNotice(videoId)`、スケジューラは `ref_id` を直接見る
      `hasSentPreNoticeForEvent(db, ref_id)`（生成時に JSON 化して保存するため送信直前判定）。
  - 突然に始まる配信（事前告知が無い）でも、**アラームと同じ音で起きれる**ようにする。
  - 通常のチャネル（`mai_default`）では「音は鳴るが画面は起こらない」だけだった。
  - 公式仕様: チャネルが未作成なら FCM はマニフェストの既定チャネルへフォールバックする
    （通知が drop されることはない）→ v1.7.2 のままの端末にも通知は届く。
  - 対象は **配信開始だけ**（`【ライブ】` と スケジュールの開始通知 `event_start`）。
    事前告知（`event_pre_*`＝30分前/3分前）は情報通知のまま。
  - サーバー側は `services/scheduler.js`（`isStart`）と `src/scrapers/youtube.js` が
    `channel: "mai_stream_alarm"` を付ける。アプリ側は FCM の `data.channel` を読む
    （フォアグラウンド時は自前の通知を描くため、ここで respect する）。
- **アラーム音は「ユーザーが止めるまで鳴らす」**（v1.7.4・2026-10-22 ユーザー報告で追加）:
  - 症状: 通知チャネルの音は**1 回鳴るだけ**で止まる →
    「アラームが鳴ったけど短い」「これじゃ起きれない」。
    チャネル音はループ再生できないため、**自前の再生**が必要。
  - 方式: `AlarmSoundService`（**フォアグラウンドサービス**）が
    MediaPlayer で端末のアラーム音（`RingtoneManager.TYPE_ALARM`）を `isLooping = true` で
    **ループ再生**し、バイブも繰り返す。`USAGE_ALARM` なのでマナーモード/消音でも鳴る。
  - 通知は **ongoing**（スワイプで消せない）＋ **「停止」アクション**（`AlarmReceiver` の
    `ACTION_STOP_ALARM` broadcast → `AlarmSoundService.stop()`）。
    アプリを開いたとき（`MainActivity.onResume`）も自動で止まる（「起きた＝止める」）。
    ⚠️ ただし **アラームの full-screen intent で起動したときは止めない**
    （`EXTRA_FROM_ALARM` フラグ）。止めると「鳴って数秒後に自分で止まる」→
    ユーザー報告の主要ケースが残ってしまうため。
    停止は「停止」ボタン／アプリ内 `stopStreamAlarm()`／通常の起動時に限定する。
  - **最大 15 分で自動停止**（放置で鳴りっぱなしにならない安全弁）。
    既定のオフセット（15分前）と同程度にしてある。
  - 発火経路は 2 つ: ① `AlarmManager.setAlarmClock()` の exact alarm
    （バックグラウンド FGS 起動制限の**免除対象**＝AOSP の alarm-clock allowlist なので確実）
    ② FCM の配信開始通知（`channel == "mai_stream_alarm"`）。
    ② で FGS 起動が拒否された場合は**通常の通知（1 回鳴る）にフォールバック**する
    （黙って無音にしない）。
  - ★ **アラーム用チャネルの FCM は data-only で送る**（サーバー側 `services/notification.js` の
    `isAlarmChannel` 分岐）。`notification` ブロックを付けると**バックグラウンド時に
    FCM SDK 自身が描画して `onMessageReceived` が呼ばれない** → アプリ側の
    「ループ再生」に到達できないため。`android.priority: "high"` なのでアプリは起きて処理する。
    他の通知（一般通知・画像つき）は従来どおり `notification` 付きのままである。
  - サービスの通知は**無音チャネル**（`mai_stream_alarm_loop`）を使う。
    音はサービスが鳴らすので、チャネル音と二重に鳴らさない。
    ※ 既存の `mai_stream_alarm`（アラーム音つき）は事前通知用に残す。
  - 権限: `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MEDIA_PLAYBACK`（Android 14+ の
    タイプ別権限）/ `VIBRATE`。FGS のタイプは `mediaPlayback`。
  - アプリ内から止めるなら `MaiWebBridge.stopStreamAlarm()`。
- **「標準のアラーム時計に設定」は補助手段**（`ACTION_SET_ALARM`）:
  ⚠️ 公式ドキュメント: `EXTRA_SKIP_UI` は **API 19 以降無視され、アラームアプリが必ず
  確認 UI を出す**（＝ユーザーの 1 タップが必須）。確認画面を開くだけなので、
  「確実に目視でセットしたい」場合の補助として使う。
- ビルド・署名は Windows 側（`§10.1`）。`webui/dl/android.json` の更新は
  **APK を `webui/mai-notification.apk` に配置した後**に行う（先に更新すると 404 を指す）。

