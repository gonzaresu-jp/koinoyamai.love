// platformFetch/index.js
const twitch = require('./twitch');
const twitcasting = require('./twitcasting');
const youtube = require('./youtube');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
// DB は環境ごとに分ける（main.js / server.js と同じ規則）。
// 従来は data.db 固定で、staging では API が読む data-test.db と別の DB に
// 週間スケジュールを別 DB に書いていた（回帰テストでも tree に data.db を作っていた）。
const db = new sqlite3.Database(
    path.join(__dirname, '..', process.env.DB_FILE_NAME || 'data.db')
);
// 書き込みロックの競合を待つ（AGENTS.md §11: DB 書込ロック耐性）。
// これが無いと、同一 DB に別接続で書き込んでいる最中に
// SQLITE_BUSY で落ちて「Uncaught Exception」になる（2026-10-21 回帰テストで実測）。
db.configure('busyTimeout', 5000);
// コールバックなしの文のエラーでプロセスを落とさない
db.on('error', (err) => console.error('[db:weekly] error:', err.message));

const YOUTUBE_LOOKAHEAD_MS     = 14 * 24 * 60 * 60 * 1000; // 2週間
const NEAR_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;            // ±10分

function toJstNaive(dateStr) {
    if (!dateStr) return dateStr;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}`;
}

async function updateSchedule() {
    console.log('[Schedule Update] Start');

    const [twitchEvents, twitEvents, ytEvents] = await Promise.all([
        twitch.fetchLatest().catch(e => { console.error('[Schedule Update] Twitch error:', e.message); return []; }),
        twitcasting.fetchLatest().catch(e => { console.error('[Schedule Update] TwitCasting error:', e.message); return []; }),
        youtube.fetchLatest().catch(e => { console.error('[Schedule Update] YouTube error:', e.message); return []; })
    ]);

    console.log(`[Schedule Update] Twitch: ${twitchEvents.length}, TwitCasting: ${twitEvents.length}, YouTube: ${ytEvents.length}`);

    for (const ev of [...twitchEvents, ...twitEvents, ...ytEvents]) {
        // YouTube: scheduled/live のみ処理（ended は無視して重複防止）
        if (ev.platform === 'youtube' && ev.status !== 'scheduled' && ev.status !== 'live') continue;
        await upsertEvent(ev);
    }

    console.log('[Schedule Update] Done');
}

async function upsertEvent(ev) {
    if (!ev.start_time) return;

    // YouTube/外部プラットフォームのUTC文字列をJST naiveに変換
    if (ev.platform === 'youtube') {
        ev.start_time = toJstNaive(ev.start_time);
        if (ev.end_time) ev.end_time = toJstNaive(ev.end_time);
    }

    // YouTube イベントは現在時刻から2週間以内のものだけ登録する
    if (ev.platform === 'youtube') {
        const startMs = new Date(ev.start_time).getTime();
        const now = Date.now();
        if (startMs > now + YOUTUBE_LOOKAHEAD_MS) {
            console.log(`[upsertEvent] YouTube event too far ahead, skip: ${ev.title} (${ev.start_time})`);
            return;
        }
    }

    const sqlSelect = `SELECT id FROM events WHERE external_id = ? AND platform = ?`;
    const sqlInsert = `
        INSERT INTO events (title, start_time, end_time, url, thumbnail_url, platform, event_type, description, status, external_id, confirmed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const sqlUpdate = `
        UPDATE events SET title=?, start_time=?, end_time=?, url=?, thumbnail_url=?, event_type=?, description=?, status=?
        WHERE id=?
    `;

    // YouTube: ±10分以内の近似重複レコードの候補を取得するクエリ。
    // 以前は platform = 'youtube' の行だけを対象にしていたため、Twitter/Gemma解析
    // 経由で先に作られた同一配信の予定（platform = 'twitter' 等）が対象外になり、
    // 重複が作られていた。ここでは event_type = 'live' の行を広く候補にする。
    // ※ ended の行は対象外（古い動画が未来の予定を誤上書き防止）
    // ※ status は scheduled だけでなく live も対象。ライブ開始後に別プラットフォーム
    //    経由で登録された同行程（platform='twitter' 等）が published 済みのまま残ると、
    //    YouTube版が重複INSERTされていたため。
    const sqlNearDuplicateCandidates = `
        SELECT id, start_time FROM events
        WHERE event_type = 'live'
          AND status IN ('scheduled', 'live')
          AND (external_id IS NULL OR external_id != ?)
    `;

    // time_period 付きの推定イベント検索（±10分の近似重複が見つからなかった場合のフォールバック）。
    // Gemma が「夜ごろ」等の時間帯推定で作成した予定は start_time が仮置き（例: 22:00）のため、
    // YouTube の実際の時刻（例: 21:00）と±10分を超える場合がある。这种情况下は time_period が
    // 設定されている既存イベントを重複候補として扱い、確定時刻で上書きする。
    const sqlEstimatedCandidates = `
        SELECT id, start_time, time_period FROM events
        WHERE event_type = 'live'
          AND status IN ('scheduled', 'live')
          AND time_period IS NOT NULL
          AND (external_id IS NULL OR external_id != ?)
    `;

    // confirmed の判定：具体的な時刻がある予定は確認定は確認済み扱い。
    // 時間帯のみ（time_period）で時刻未定のもののみ null（未定）。
    let confirmed = null;
    if (ev.status === 'ended') {
        confirmed = 1;
    } else if (ev.start_time && /T\d{2}:\d{2}/.test(ev.start_time)) {
        confirmed = 1;
    }

    // UPDATE時に external_id も更新するクエリ（近似重複の上書き用）。
    // time_period を null にクリアし、confirmed を 1 に設定することで、
    // Gemma の推定「未定」イベントが YouTube の確定時刻で上書きされたことを反映する。
    const sqlUpdateFull = `
        UPDATE events SET title=?, start_time=?, end_time=?, url=?, thumbnail_url=?,
                          event_type=?, description=?, status=?, external_id=?,
                          time_period=null, confirmed=?
        WHERE id=?
    `;

    return new Promise((resolve, reject) => {
        db.get(sqlSelect, [ev.external_id, ev.platform], (err, row) => {
            if (err) return reject(err);

            if (row) {
                // external_id が一致 → 通常の UPDATE
                const params = [
                    ev.title,
                    ev.start_time,
                    ev.end_time || null,
                    ev.url || null,
                    ev.thumbnail_url || null,
                    ev.event_type || 'live',
                    ev.description || null,
                    ev.status || 'scheduled',
                    row.id
                ];
                db.run(sqlUpdate, params, err => err ? reject(err) : resolve());

            } else {
                // external_id 不一致 → URL一致チェック（同じ配信の別プラットフォームからの登録を検出）。
                // Gemma がツイートURLで、YouTube が動画URLで作成している場合でも重複を防止する。
                const startMs = new Date(ev.start_time).getTime();

                const checkUrlMatch = (callback) => {
                    if (!ev.url) return callback(null);
                    db.get(
                        "SELECT id FROM events WHERE url = ? AND url IS NOT NULL AND url != '' AND event_type = 'live' AND status IN ('scheduled', 'live')",
                        [ev.url],
                        callback
                    );
                };

                checkUrlMatch((err, urlRow) => {
                    if (err) return reject(err);

                    if (urlRow) {
                        // URL 一致 → 重複として上書き UPDATE
                        console.log(`[upsertEvent] URL-duplicate found (id=${urlRow.id}), overwriting: ${ev.title}`);
                        const params = [
                            ev.title,
                            ev.start_time,
                            ev.end_time || null,
                            ev.url || null,
                            ev.thumbnail_url || null,
                            ev.event_type || 'live',
                            ev.description || null,
                            ev.status || 'scheduled',
                            ev.external_id || null,
                            confirmed,
                            urlRow.id
                        ];
                        db.run(sqlUpdateFull, params, err => err ? reject(err) : resolve());

                    } else {
                        // ±10分以内の近似重複を検索（全プラットフォーム共通）。
                        db.all(sqlNearDuplicateCandidates, [ev.external_id || ''], (err, candidates) => {
                            if (err) return reject(err);

                            const nearRow = (candidates || []).find(c => {
                                const cMs = new Date(c.start_time).getTime();
                                return Number.isFinite(cMs) && Math.abs(cMs - startMs) <= NEAR_DUPLICATE_WINDOW_MS;
                            });

                            if (nearRow) {
                                // 近似重複が見つかった → external_id ごと上書き UPDATE
                                console.log(`[upsertEvent] Near-duplicate found (id=${nearRow.id}), overwriting: ${ev.title}`);
                                const params = [
                                    ev.title,
                                    ev.start_time,
                                    ev.end_time || null,
                                    ev.url || null,
                                    ev.thumbnail_url || null,
                                    ev.event_type || 'live',
                                    ev.description || null,
                                    ev.status || 'scheduled',
                                    ev.external_id || null,
                                    confirmed,
                                    nearRow.id
                                ];
                                db.run(sqlUpdateFull, params, err => err ? reject(err) : resolve());

                            } else {
                                // ±10分以内に近似重複なし → time_period 付きの推定イベントを検索。
                                db.all(sqlEstimatedCandidates, [ev.external_id || ''], (err, estimatedCandidates) => {
                                    if (err) return reject(err);

                                    const sameDayPeriodRow = (estimatedCandidates || []).find(c => {
                                        const cDate = c.start_time ? c.start_time.substring(0, 10) : '';
                                        const evDate = ev.start_time ? ev.start_time.substring(0, 10) : '';
                                        return cDate === evDate;
                                    });
                                    const nearbyRow = sameDayPeriodRow || (estimatedCandidates || []).find(c => {
                                        const cMs = new Date(c.start_time).getTime();
                                        return Number.isFinite(cMs) && Math.abs(cMs - startMs) <= 6 * 60 * 60 * 1000;
                                    });

                                    if (nearbyRow) {
                                        console.log(`[upsertEvent] Estimated-event duplicate found (id=${nearbyRow.id}, time_period=${nearbyRow.time_period}), overwriting with confirmed time: ${ev.title}`);
                                        const params = [
                                            ev.title,
                                            ev.start_time,
                                            ev.end_time || null,
                                            ev.url || null,
                                            ev.thumbnail_url || null,
                                            ev.event_type || 'live',
                                            ev.description || null,
                                            ev.status || 'scheduled',
                                            ev.external_id || null,
                                            confirmed,
                                            nearbyRow.id
                                        ];
                                        db.run(sqlUpdateFull, params, err => err ? reject(err) : resolve());

                                    } else {
                                        // 近似重複なし → 新規 INSERT
                                        const params = [
                                            ev.title,
                                            ev.start_time,
                                            ev.end_time || null,
                                            ev.url || null,
                                            ev.thumbnail_url || null,
                                            ev.platform || 'other',
                                            ev.event_type || 'live',
                                            ev.description || null,
                                            ev.status || 'scheduled',
                                            ev.external_id || null,
                                            confirmed
                                        ];
                                        db.run(sqlInsert, params, err => err ? reject(err) : resolve());
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });
    });
}

/**
 * 事前告知（event_pre_*）を送り済みかどうか。
 *
 * 配信開始通知のチャネル選択（`src/core/notify-channel.js` / AGENTS.md §10.2）で使う。
 * 「スケジュールにあって利用者が既に知っている配信」かどうかを判定する。
 *
 * 判定は `external_id`（＝YouTube の videoId）と `url` の両方で行う。直近の実データでは
 * 配信予定が **Twitter/Gemma 経由で先に作られ `platform = 'twitter'` のまま**になることが
 * あり（2026-10-23 の配信 event #216 が該当）、`platform = 'youtube'` で絞ると取りこぼす。
 *
 * 取り出せない場合（DB エラー・イベント未登録）は `false`（＝アラーム側に倒す）。
 * 突然の配信でアラームが鳴らないことを避ける優先判断（誤鳴りは不便、不鳴りは起きられない）。
 *
 * @param {string} videoId YouTube の videoId
 * @returns {Promise<boolean>} 事前告知を 1 件でも送り済みなら true
 */
function hasSentPreNotice(videoId) {
    return new Promise((resolve) => {
        if (!videoId) return resolve(false);
        const sql = `
            SELECT 1 AS hit FROM scheduled_notifications sn
            JOIN events e ON e.id = sn.ref_id
            WHERE (e.external_id = ? OR e.url LIKE '%' || ? || '%')
              AND sn.kind LIKE 'event_pre_%'
              AND sn.sent = 1
            LIMIT 1`;
        db.get(sql, [videoId, videoId], (err, row) => {
            if (err) {
                console.error('[weekly] hasSentPreNotice err:', err.message);
                return resolve(false);
            }
            resolve(!!row);
        });
    });
}

module.exports = { updateSchedule, upsertEvent, hasSentPreNotice };