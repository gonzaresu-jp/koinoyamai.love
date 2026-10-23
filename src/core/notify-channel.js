"use strict";
// 配信開始通知のチャネル選択（2026-10-24 追加）。
//
// 配信開始の通知をアラーム用チャネル（mai_stream_alarm）で送ると、Android アプリは
// 端末の中でアラーム音をループ再生する（AGENTS.md §10.2）。
//
// しかし **スケジュールにあった配信**では、30分前/3分前の事前告知を受け取った時点で
// アプリが端末内アラーム（setAlarmClock）を予約しており、開始 15 分前に一度鳴っている。
// そのうえ開始時にもう一度鳴ると「二度鳴り」になり、逆に目覚めにくい
// （2026-10-23 の利用者報告: 「元々スケジュールにあって15分前に鳴ったのに、
// 開始でもう一度鳴った」）。
//
// そこで「事前告知を送り済みかどうか」で分ける:
//   - 送り済み（＝予定どおりの配信。利用者は既に知っている） → **通常チャネル**（鳴らさない）
//   - 未送信（＝事前告知が無い突然の配信）                  → **アラーム用チャネル**
//
// この判断は「どの経路（webhook / RSS フォールバック / スケジューラ）が先に配信開始を
// 検知したか」に依存させない。依存させると、同じ配信でも検知経路次第で挙動が変わり、
// 「突然始まった配信なのに鳴らなかった」/「予定通りなのに二度鳴った」の両方が起きる。

/** 配信開始通知に使うアラーム用チャネル名（Android アプリがデータとして読む）。 */
const START_ALARM_CHANNEL = "mai_stream_alarm";

/**
 * 配信開始通知のチャネルを返す。
 * @param {boolean} preNoticeSent 事前告知（event_pre_*）を送り済みなら true
 * @returns {string|undefined} 通常チャネルなら undefined（キー自体を付けない）
 */
function startNotificationChannel(preNoticeSent) {
  return preNoticeSent ? undefined : START_ALARM_CHANNEL;
}

module.exports = { START_ALARM_CHANNEL, startNotificationChannel };
