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

module.exports = {
    deriveUploadsPlaylistId,
    parseRssEntries,
    parsePlaylistItems
};
