const { analyzeTweet, extractUrlsFromTweet } = require('../scrapers/gemma-analyzer');
const { fetchVideoStatus } = require('../scrapers/youtube');
const { sendDiscordAlert } = require('./discord-alert');

/**
 * ツイート情報とYouTube情報を比較して、差異があればDiscord通知する
 * @param {Object} tweet - { id, text, datetime }
 */
async function checkScheduleDrift(tweet) {
  if (!tweet || !tweet.text) return;

  // 1. Gemma AI でツイートを解析
  const analysis = await analyzeTweet(tweet.text);
  
  // 配信予定ツイート（LIVE_SOON または TIME_CHANGE）でなければ終了
  if (analysis.category !== 'LIVE' || (analysis.status !== 'LIVE_SOON' && analysis.status !== 'TIME_CHANGE')) {
    return;
  }

  if (!analysis.start_time) {
    return; // 時刻が抽出できなければ比較不能
  }

  // 2. YouTube URL を抽出
  const urls = extractUrlsFromTweet(tweet.text);
  const ytUrl = urls.find(u => u.includes('youtube.com/watch?v=') || u.includes('youtu.be/'));
  
  if (!ytUrl) {
    return;
  }

  // videoId 抽出
  let videoId = null;
  try {
    if (ytUrl.includes('watch?v=')) {
      const urlObj = new URL(ytUrl);
      videoId = urlObj.searchParams.get('v');
    } else {
      videoId = ytUrl.split('/').filter(Boolean).pop();
    }
  } catch (e) {
    console.warn('[DriftMonitor] Invalid YouTube URL:', ytUrl);
    return;
  }

  if (!videoId) return;

  try {
    // 3. YouTube Data API で実際の開始予定時刻を取得
    const ytStatus = await fetchVideoStatus(videoId);
    if (!ytStatus) {
      await sendDiscordAlert(
        '🚨 待機所未発見アラート',
        `ツイートで告知されたYouTube待機所が見つかりません。\nツイート本文: "${tweet.text.substring(0, 60)}..."\nURL: ${ytUrl}`,
        'WARN',
        `not_found_${videoId}`
      );
      return;
    }

    const ytScheduledStr = ytStatus.liveStreamingDetails?.scheduledStartTime;
    if (!ytScheduledStr) {
      // 待機所はあるが開始予定時刻が設定されていない（または既に開始・終了している）
      return;
    }

    const ytDate = new Date(ytScheduledStr);
    
    // 4. ツイート側の時刻を Date オブジェクトに変換
    const [hh, mm] = analysis.start_time.split(':').map(Number);
    const twBaseDate = tweet.datetime ? new Date(tweet.datetime) : new Date();
    const twDate = new Date(twBaseDate);
    twDate.setHours(hh, mm, 0, 0);

    // ツイート投稿時刻より前（例えば深夜0時に投稿して「2時に配信」など）の場合、翌日とみなす
    if (twDate.getTime() < twBaseDate.getTime() - (1000 * 60 * 60)) { // 1時間以上の余裕
      twDate.setDate(twDate.getDate() + 1);
    }

    // 5. 比較 (ミリ秒差)
    const diffMs = Math.abs(ytDate.getTime() - twDate.getTime());
    const diffMin = diffMs / (1000 * 60);
    
    if (diffMin >= 5) {
      const formatTime = (d) => d.toLocaleTimeString('ja-JP', { 
        hour: '2-digit', minute: '2-digit', 
        timeZone: 'Asia/Tokyo' 
      });
      
      await sendDiscordAlert(
        '⏰ 配信予定時刻の差異検知',
        `ツイート告知とYouTube待機所の時刻に **${Math.round(diffMin)}分** の差異があります。\n\n` +
        `🔹 **ツイート告知**: ${formatTime(twDate)}\n` +
        `🔸 **YouTube待機所**: ${formatTime(ytDate)}\n\n` +
        `対象ツイート: https://x.com/koinoya_mai/status/${tweet.id}\n` +
        `YouTube URL: ${ytUrl}`,
        'WARN',
        `drift_${tweet.id}`
      );
      console.log(`[DriftMonitor] ⚠️ 差異検知 (${Math.round(diffMin)}分): ${tweet.id}`);
    } else {
      console.log(`[DriftMonitor] ✅ 時刻一致確認済み (差: ${Math.round(diffMin)}分): ${tweet.id}`);
    }

  } catch (err) {
    console.error('[DriftMonitor] 差異チェック失敗:', err.message);
  }
}

module.exports = { checkScheduleDrift };
