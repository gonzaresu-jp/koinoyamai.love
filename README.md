# まいちゃんWeb通知サービス (README)

このリポジトリは「まいちゃん」に関する通知を確実に受け取るための Web 通知サービスの説明と設定手順をまとめたものです。  
サイト本体は WebUI を介して通知の購読設定を行います。

[![CI](https://github.com/gonzaresu-jp/koinoyamai.love/actions/workflows/ci.yml/badge.svg)](https://github.com/gonzaresu-jp/koinoyamai.love/actions/workflows/ci.yml)
[![サイト稼働中](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fkoinoyamai.love%2Fapi%2Fhealth&query=%24.status&label=%E3%82%B5%E3%82%A4%E3%83%88&color=green)](https://koinoyamai.love/)
[![PWA](https://img.shields.io/badge/PWA-%E5%B0%8E%E5%85%A5%E5%8F%AF-6A1FB2?logo=googlechrome&logoColor=white)](https://koinoyamai.love/)
[![Windows版](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fgonzaresu-jp%2Fkoinoyamai.love%2Fmain%2Fwebui%2Fdl%2Fdesktop.json&query=%24.version&label=Windows%E7%89%88&color=0078D6)](https://koinoyamai.love/download.php)
[![Android版](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fgonzaresu-jp%2Fkoinoyamai.love%2Fmain%2Fwebui%2Fdl%2Fandroid.json&query=%24.versionName&label=Android%E7%89%88&color=3DDC84)](https://koinoyamai.love/mai-notification.apk)

---

## <a href="#user-content-iphoneios">iPhone(iOS)の設定</a>

## 目次

- [概要](#概要)
- [受け取れる通知](#受け取れる通知)
- <a href="#user-content-iphoneios">iPhone(iOS)</a>
- [PC・Android](#pcandroid)
  - [Android設定](#Android設定)
  - [Androidをホーム画面に追加(Webアプリ化)](#Androidをホーム画面に追加Webアプリ化)
- [トラブルシューティング](#トラブルシューティング)
- [運用・注意点](#運用・注意点)
- [不具合報告](#不具合報告)
- [開発者メモ](#開発者メモ)
---

## 概要

このサービスは、まいちゃん関連（配信・投稿・記念日等）の通知を遅延少なく受け取ることを目的に開発されています。Web プッシュ（ブラウザ通知）を用いて端末に直接通知を送信します。

---

## 受け取れる通知

* ツイキャス配信
* YouTube（配信・動画・コミュニティ投稿）
  ※コミュニティ投稿のみ現在使用不可
* Twitter（投稿）
  - 仕組み上タイムラインの新規投稿しか通知しないので、まいちゃん自身のリツイート、リプは通知に含まれません。まいちゃんの投稿に対するまいちゃんのリプだけは来ます。
  - 他アカウントのリツイートは来ます。
* Pixiv Fanbox（ファンクラブ投稿）
* 記念日通知（デビュー日からの日数、お誕生日、周年など）

> 配信・動画（ツイキャス / YouTube）は5~10秒の遅延で届きます。Twitter は約1分、YouTubeコミュニティ / Pixiv Fanbox は約3分の遅延が発生する場合があります。

[![YouTube](https://img.shields.io/badge/YouTube-%E3%81%BE%E3%81%84%E3%81%A1%E3%82%83%E3%82%93-FF0000?logo=youtube&logoColor=white)](https://www.youtube.com/@koinoyamaich)
[![TwitCasting](https://img.shields.io/badge/TwitCasting-%E3%81%BE%E3%81%84%E3%81%A1%E3%82%83%E3%82%93-F5A623?logo=twitcasting&logoColor=white)](https://twitcasting.tv/c:koinoya_mai)
[![X](https://img.shields.io/badge/X-%E3%81%BE%E3%81%84%E3%81%A1%E3%82%83%E3%82%93-000000?logo=x&logoColor=white)](https://x.com/koinoya_mai)
[![Pixiv Fanbox](https://img.shields.io/badge/Pixiv%20Fanbox-%E3%81%BE%E3%81%84%E3%81%A1%E3%82%83%E3%82%93-FF69B4?logo=pixiv&logoColor=white)](https://www.fanbox.cc/@koinoya-mai)

---

# iPhone(iOS)

1. Safari で URL を開く。
   * [https://koinoyamai.love/](https://koinoyamai.love/)
2. 画面下の共有ボタン⎙をタップ。

   <img src="./img/IMG_3205.png" width="300">
3. 「ホーム画面に追加」を選択して、任意のアプリ名で追加。

   <img src="./img/IMG_3213.png" width="300">
   <img src="./img/IMG_3214.png" width="300">
4. ホーム画面に追加したアイコンをタップして起動する。

   <img src="./img/IMG_3215.png" width="300">
5. 右上のハンバーガーメニューを開く（または横スワイプでメニュー表示）。

<img src="./img/IMG_3216.png" width="300">

6. 「通知を受信する」をオンにして、通知の許可ダイアログで許可する。
   * ユーザーネームは任意で入力可能。
  
<img src="./img/IMG_3217.png" width="300"><img src="./img/IMG_3219.png" width="300"><img src="./img/IMG_3221.png" width="300">
   
7. 「テスト通知」ボタンを押して、受信と指定ページ遷移が正常に動作するか確認する。

   <img src="./img/IMG_3221.png" width="300">

> ※ テストページは実際に開いてからのお楽しみ。

---

## PC・Android

1. 共通 URL を開く。

   * [https://koinoyamai.love/](https://koinoyamai.love/)
  ![ホーム](./img/image.png)

2. 右上のハンバーガーメニューを開く。

<img src="./img/image 1.png" width="300">
3. 「通知を受信する」をオンにして、表示される各プラットフォーム設定を必要に応じて有効化する。

<img src="./img/image 2.png" width="300">
4. 「テスト通知を送信」を実行し、デバイス側で通知が表示されること、通知から指定 URL に遷移できることを確認する。

<img src="./img/image 3.png" width="300">
#### 注意点

* テスト通知が失敗する場合はサイトの通知許可をしてください。ちなみにEdgeは何故かできません。

---

## Android設定

# 推奨ブラウザ

* Chrome を推奨（Brave,Firefox 等でも可）。

### Chrome の通知設定確認手順

1. Chrome を開き、右上のメニュー（3点） → **設定** → **通知** を選択。

   <img src="./img/Screenshot_20251116-231344.png" width="300">

2. サイト一覧から `elza.poitou-mora.ts.net` を選択して詳細設定を行う。

   <img src="./img/Screenshot_20251116-231405.png" width="300">
3. 推奨設定例（参考）：

   * 通知表示をデフォルトに設定
   * ポップアップ通知をオン
   * 音は任意（運用方針に合わせて）
   * 通知ドット表示をオン
   * 重要な通知をオン

これらの設定により、Android では遅延なく通知を受け取れることが多いです。

<img src="./img/Screenshot_20251116-231437.png" width="300">

---

## Androidをホーム画面に追加(Webアプリ化)

* Chrome のメニューから「ホーム画面に追加」で Web アプリ化可能です。Web アプリ化した場合、通知の管理はブラウザ（Chrome）ではなくアプリ単位の通知設定になります。
* アプリ化した後は、端末のアプリ通知設定または当該ウェブアプリ内の通知設定から調整してください。
* Chromeの場合は通知設定の中のウェブアプリで通知設定ができます。
<img src="./img/Screenshot_20251124-200626.png" width="300">

---

## トラブルシューティング

* **通知が来ない**
  - データベースとの連携が切れていると思われるので、通知テストで通知が来なかった場合は再度通知をオンにし直してください。

---

## 運用・注意点

- プラットフォーム側の API 制限や障害、サーバーメンテによって遅延が発生する場合があります。  
- 通知が来ない場合は、ブラウザの通知設定・PWA 設定・権限を確認してください。  
- 修正対応には時間がかかることがあります。

---

## 不具合報告

不具合は以下から送信可能です。  
使用端末・ブラウザ・スクショがあると非常に助かります。

- WebUI 内の「不具合報告」
- フォーム:  
  https://form.jotform.com/253191048959063

---

## ライセンス / 注意事項

本サービスの利用は自己責任で行ってください。  
プライバシー・セキュリティに関する問い合わせは不具合報告フォームへ。

---

## 開発者メモ

### 技術スタック

[![Node.js](https://img.shields.io/badge/Node.js-22.12.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Web Push](https://img.shields.io/badge/Web%20Push-%E9%80%9A%E7%9F%A5%E5%B0%8E%E5%85%A5-ff69b4)](https://developer.mozilla.org/docs/Web/API/Push_API)

# pm2

- log
```
pm2 logs mai-push-api --lines 100
pm2 logs mai-push-worker --lines100
```
- start restart
```
pm2 start server.js --name mai-push-api
pm2 start main.js --name mai-push-worker

pm2 restart all --env production
```
- info
```
pm2 describe mai-push
```

# DB

```
sqlite3 data.db

.tables
.headers on
.mode column
.mode csv
SELECT * FROM subscription;

# delete
DELETE FROM notifications
WHERE id IN (32, 35, 36, 37, 38);


```

```
# 特定プロファイルでの立ち上げ
firefox --no-remote -profile /var/lib/mai-push/puppeteer-profile

```
