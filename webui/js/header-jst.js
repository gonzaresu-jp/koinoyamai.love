/* 端末が日本時間(JST)以外のタイムゾーンにいるときだけ、
   ヘッダーに現在の日本時間（JST HH:MM）を表示する。
   - 日本国内(TZ=Asia/Tokyo / UTC+9)の端末では表示しない。
   - 表示先は header.php の #header-jst（初期状態は hidden）。
   - CSP は script-src 'self' のため、この外部ファイルとして読み込む。 */
(function () {
  "use strict";
  try {
    var tz = "";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) { /* Intl 不可の環境ではオフセット判定のみで行う */ }

    // 日本端末判定: タイムゾーン名が Asia/Tokyo なら日本の端末。
    // Intl が使えず名前が取れない場合のみ、+9:00（-540分）を日本とみなす。
    var isJapan = (tz === "Asia/Tokyo") ||
      (tz === "" && new Date().getTimezoneOffset() === -540);
    if (isJapan) return; // 日本国内の端末には表示しない

    var root = document.getElementById("header-jst");
    var timeEl = document.getElementById("header-jst-time");
    if (!root || !timeEl) return;

    var render = function () {
      // JST は夏時間が無いため UTC+9 固定で正確に算出できる
      var d = new Date(Date.now() + 9 * 60 * 60 * 1000);
      var hh = ("0" + d.getUTCHours()).slice(-2);
      var mm = ("0" + d.getUTCMinutes()).slice(-2);
      timeEl.textContent = hh + ":" + mm;
    };

    render();
    root.hidden = false;
    // 毎分更新（分境界のズレ防止のため20秒間隔で再計算する）
    window.setInterval(render, 20000);
  } catch (e) {
    /* 失敗時は非表示のまま（ヘッダーのレイアウトに影響させない） */
  }
})();
