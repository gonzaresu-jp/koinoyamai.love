"use strict";
// 回帰テスト [7]（scripts/ops/regression-test.js のランナーから呼ばれる）
/* eslint-disable no-unused-vars */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

module.exports = {
  id: 7,
  async run(ctx) {
    const { ok, request, hmacOf, openSse, sleep, dbAll, dbRun, waitForHealth, projectDir, child, TOKEN, HMAC_SECRET, DB_NAME } = ctx;
    // --- 7. YouTube フィード補助ロジック（RSS / Data API 代替ソース） ---
    // src/core/youtube-feed.js はネットワーク・DB 非依存の純粋モジュールなので
    // require しても副作用がない（src/scrapers/youtube.js は require すると
    // weekly → services/context 経由で data.db を開いてしまうため	require しない）
    console.log("[7] YouTube feed helpers");
    const feed = require(path.join(projectDir, "src", "core", "youtube-feed.js"));
    ok("deriveUploadsPlaylistId", feed.deriveUploadsPlaylistId("UCgttI8QfdWhvd3SRtCYcJzw") === "UUgttI8QfdWhvd3SRtCYcJzw",
        feed.deriveUploadsPlaylistId("UCgttI8QfdWhvd3SRtCYcJzw"));
    ok("deriveUploadsPlaylistId (空値)", feed.deriveUploadsPlaylistId("") === null);

    const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <entry><id>yt:video:VID001</id><yt:videoId>VID001</yt:videoId><yt:channelId>UCgttI8QfdWhvd3SRtCYcJzw</yt:channelId>
    <title>テスト配信A</title><published>2026-10-20T08:49:41+00:00</published></entry>
  <entry><id>yt:video:VID002</id><yt:videoId>VID002</yt:videoId>
    <title>テスト配信B</title><published>2026-10-20T09:00:00+00:00</published></entry>
</feed>`;
    const rssItems = await feed.parseRssEntries(RSS_XML, 15);
    ok("parseRssEntries (videoId/published/title)",
        rssItems.length === 2 && rssItems[0].videoId === "VID001" &&
        rssItems[0].published === "2026-10-20T08:49:41+00:00" && rssItems[0].title === "テスト配信A",
        JSON.stringify(rssItems[0]));
    ok("parseRssEntries (maxItems)", (await feed.parseRssEntries(RSS_XML, 1)).length === 1);

    const PLAYLIST_JSON = {
        items: [
            {
                snippet: { publishedAt: "2026-10-20T08:49:41Z", title: "テスト配信A", resourceId: { videoId: "VID001" } },
                contentDetails: { videoPublishedDate: "2026-10-20T08:49:41Z" }
            },
            {
                snippet: { publishedAt: "2026-10-20T09:00:00Z", title: "テスト配信B", resourceId: { videoId: "VID002" } },
                contentDetails: {}
            }
        ]
    };
    const plItems = feed.parsePlaylistItems(PLAYLIST_JSON, 15);
    ok("parsePlaylistItems (RSS と同じ形)",
        plItems.length === 2 && plItems[0].videoId === "VID001" && plItems[0].title === "テスト配信A" &&
        plItems[1].videoId === "VID002" && typeof plItems[0].published === "string",
        JSON.stringify(plItems[0]));
    ok("parsePlaylistItems (空レスポンス)", feed.parsePlaylistItems({}, 15).length === 0);

    // RSS とプレイリストの動画IDが一致すること（＝代替ソースが主経路と等価であることの前提）
    const rssIds = rssItems.map((x) => x.videoId).sort().join(",");
    const plIds = plItems.map((x) => x.videoId).sort().join(",");
    ok("RSS とプレイリストの videoId 一致", rssIds === plIds, `${rssIds} vs ${plIds}`);

    // 検知経路の状態判定（検知経路が壊れたことに気づける仕組みの前提）
    const st = feed.decideDetectionState({
        failedChannels: 0, totalChannels: 2, usedFallback: false, failStreak: 0, alertAfter: 3
    });
    ok("検知状態: 正常は success", st.status === "success" && st.alert === false, st.message);
    // RSS が失敗したが、プレイリスト代替で取得できたチャンネルがある状態
    // （failedChannels=0 = 両方とも失敗したチャンネルなし / rssFailedChannels=1）
    const stFallback = feed.decideDetectionState({
        failedChannels: 0, totalChannels: 2, rssFailedChannels: 1, usedFallback: true, failStreak: 0, alertAfter: 3
    });
    ok("検知状態: RSS失敗・代替成功は success", stFallback.status === "success" && stFallback.alert === false, stFallback.message);
    const stBroken = feed.decideDetectionState({
        failedChannels: 2, totalChannels: 2, usedFallback: false, failStreak: 3, alertAfter: 3
    });
    ok("検知状態: 両方失敗は error + アラート", stBroken.status === "error" && stBroken.alert === true, stBroken.message);
    const stBelow = feed.decideDetectionState({
        failedChannels: 2, totalChannels: 2, usedFallback: false, failStreak: 1, alertAfter: 3
    });
    ok("検知状態: 連続失敗が閾値未満ならアラートしない", stBelow.status === "error" && stBelow.alert === false, stBelow.message);
    // 一部チャンネルのみ両方失敗した場合は degraded（「成功」と嘘をつかない）
    const stPartial = feed.decideDetectionState({
        failedChannels: 1, totalChannels: 2, rssFailedChannels: 1, usedFallback: false, failStreak: 0, alertAfter: 3
    });
    ok("検知状態: 一部失敗は degraded", stPartial.status === "degraded" && stPartial.alert === false, stPartial.message);
    // RSS が失敗したが代替で取得できた場合は success（RSS 失敗数が別で数えられる）
    const stRssFail = feed.decideDetectionState({
        failedChannels: 0, totalChannels: 2, rssFailedChannels: 2, usedFallback: true, failStreak: 0, alertAfter: 3
    });
    ok("検知状態: RSS失敗・代替成功は success", stRssFail.status === "success" && stRssFail.alert === false, stRssFail.message);
  },
};
