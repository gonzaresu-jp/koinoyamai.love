const path = require("path");

// sqlite3 の「コールバックなし文」エラーでプロセスが落ちないよう保護を先に差し込む
require("./db-guard");

const context = {
  app: null,
  db: null,
  dbPath: path.join(__dirname, "..", "data.db"),
  sseClients: new Set(),
  recentNotifications: new Map(),
  DUPLICATE_WINDOW_MS: 60 * 1000,
  vapidConfig: {},
  fcmMessaging: null,
  fcmInitAttempted: false,
  NOTIFY_API_TOKEN: process.env.NOTIFY_API_TOKEN || null,
  NOTIFY_HMAC_SECRET: process.env.NOTIFY_HMAC_SECRET || null,
  // トークン分離（2026-09 セキュリティ改修）: 通知/内部APIは NOTIFY_API_TOKEN のみ。
  // 旧互換フォールバック（ADMIN_NOTIFY_TOKEN / LOCAL_API_TOKEN）は廃止した。
  LOCAL_API_TOKEN: process.env.LOCAL_API_TOKEN || null,
  DEFAULT_PLATFORM_SETTINGS: Object.freeze({
    twitcasting: true,
    youtube: true,
    youtubeCommunity: true,
    fanbox: true,
    twitterMain: true,
    twitterSub: true,
    milestone: true,
    schedule: true,
    gipt: true,
    twitch: true,
    bilibili: false,
    customLinks: {},
  }),
  // 通知履歴JSONの出力先。
  // DB_FILE_NAME が指定されている場合（staging の data-test.db、回帰テストの一時DBなど）、
  // そのままでは本番の webui/history.json を上書きしてしまう。
  // 公開サイトは /history.json を主要ソースとして読むため、回帰テストを1回走らせるだけで
  // 通知履歴が「テスト1件」だけになり、公開サイトの表示が壊れる（2026-09-26 に発生）。
  // 一時DBのときはその隣に分離したファイルへ出力する。
  HISTORY_JSON_PATH: (() => {
    const dbName = process.env.DB_FILE_NAME;
    if (!dbName) return path.join(__dirname, "..", "webui", "history.json");
    // data-test.db → history-test.json のように、DB名から導出する
    const ext = path.extname(dbName);                       // ".db" / ".sqlite"
    const base = path.basename(dbName, ext);                // "data-test" / "regression-test-123"
    return path.join(__dirname, "..", "webui", `history-${base}.json`);
  })(),
  HISTORY_JSON_LIMIT: 50,
  HISTORY_JSON_DEBOUNCE_MS: 5000,
  _cpuUsagePercent: 0,
  _cpuPrev: null,
  milestoneScheduler: null,
};

module.exports = context;
