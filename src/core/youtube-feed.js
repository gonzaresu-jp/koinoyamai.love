/**
 * YouTube フィード取得の純粋ロジック（副作用なし・DB/API 非依存）
 *
 * ここに置く理由:
 *   - RSS と Data API（アップロードプレイリスト）の**取得結果を同じ形**に揃える
 *     ことで、フォールバック経路が主経路と等価であることを保証する
 *   - ネットワークや DB に依存しないため、回帰テストから require して
 *     アサートできる（src/scrapers/youtube.js を require すると
 *     weekly → services/context 経由で data.db が開いてしまう）
 */

const { parseStringPromise } = require('xml2js');

/**
 * チャンネルのアップロードプレイリストIDを導出する。
 * チャンネルIDは "UC" + 22文字、アップロードプレイリストは "UU" + 同じ22文字。
 * 例: UCgttI8QfdWhvd3SRtCYcJzw → UUgttI8QfdWhvd3SRtCYcJzw
 */
function deriveUploadsPlaylistId(channelId) {
    if (!channelId) return null;
    return `UU${String(channelId).replace(/^UC/, '')}`;
}

/**
 * RSS フィード（XML文字列）→ [{ videoId, published, title }]
 * 既存コードと同じ形（published は RSS の <published>）を返す。
 */
async function parseRssEntries(xml, maxItems = 15) {
    const parsed = await parseStringPromise(xml);
    const entries = parsed?.feed?.entry || [];
    const list = [];
    for (const entry of entries.slice(0, maxItems)) {
        const videoId = entry?.['yt:videoId']?.[0];
        if (!videoId) continue;
        list.push({
            videoId,
            published: entry?.published?.[0] || null,
            title: entry?.title?.[0] || null
        });
    }
    return list;
}

/**
 * Data API playlistItems.list のレスポンス → [{ videoId, published, title }]
 * RSS と同じ形にする。published は「動画の公開日時」を優先し、
 * 無ければプレイリストに追加された日時を使う。
 */
function parsePlaylistItems(data, maxItems = 15) {
    const items = data?.items || [];
    const list = [];
    for (const it of items.slice(0, maxItems)) {
        const videoId = it?.snippet?.resourceId?.videoId || it?.contentDetails?.videoId;
        if (!videoId) continue;
        list.push({
            videoId,
            published: it?.contentDetails?.videoPublishedDate || it?.snippet?.publishedAt || null,
            title: it?.snippet?.title || null
        });
    }
    return list;
}

/**
 * 検知経路の状態判定（純粋関数・副作用なし）
 *
 * status:
 *   - success  … すべてのチャンネルで取得できた
 *   - degraded … 一部のチャンネルで **RSS もプレイリスト代替も** 取得できなかった
 *   - error    … 全チャンネルで 両方とも 取得できなかった（検知が完全に止まる）
 *
 * @param {Object} p
 * @param {number} p.failedChannels      RSS もプレイリスト代替も取得できなかったチャンネル数
 * @param {number} p.totalChannels       監視対象のチャンネル数
 * @param {number} p.rssFailedChannels   RSS 取得に失敗したチャンネル数（代替で補えたもの含む）
 * @param {boolean} p.usedFallback       プレイリスト代替で取得できたか
 * @param {number} p.failStreak          連続失敗回数（アラート判定用）
 * @param {number} p.alertAfter          アラートを鳴らす連続失敗回数
 * @returns {{status: 'success'|'degraded'|'error', message: string, alert: boolean}}
 */
function decideDetectionState({
    failedChannels,
    totalChannels,
    rssFailedChannels = 0,
    usedFallback = false,
    failStreak = 0,
    alertAfter = 3
}) {
    const allFailed = totalChannels > 0 && failedChannels >= totalChannels;
    const someFailed = !allFailed && failedChannels > 0;
    let message;
    if (allFailed) {
        message = `RSS と Data API プレイリストの両方が失敗（${failedChannels}/${totalChannels} チャンネル）。` +
            `この間 YouTube の配信開始・配信予定を検知できない`;
    } else if (someFailed) {
        message = `${failedChannels}/${totalChannels} チャンネルで RSS・プレイリスト代替の両方が失敗` +
            (usedFallback ? `（RSS 失敗 ${rssFailedChannels} チャンネルは代替で取得）` : '') +
            `。当該チャンネルの配信開始・配信予定を検知できない`;
    } else if (usedFallback || rssFailedChannels > 0) {
        message = `RSS 取得失敗 → Data API プレイリスト代替で取得（RSS 失敗 ${rssFailedChannels}/${totalChannels} チャンネル）`;
    } else {
        message = `RSS 取得成功（${totalChannels} チャンネル）`;
    }
    return {
        status: allFailed ? 'error' : (someFailed ? 'degraded' : 'success'),
        message,
        alert: allFailed && failStreak >= alertAfter
    };
}

module.exports = {
    deriveUploadsPlaylistId,
    parseRssEntries,
    parsePlaylistItems,
    decideDetectionState
};
