const ctx = require("./context");

function initDatabase() {
  const db = ctx.db;
  db.serialize(() => {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA temp_store = MEMORY");

    db.run(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, body TEXT, url TEXT, icon TEXT,
      platform TEXT, status TEXT DEFAULT 'success',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, data TEXT
    )`, (err) => { if (err) console.error("notifications create err:", err.message); });

    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, client_id TEXT NOT NULL UNIQUE,
      endpoint TEXT NOT NULL UNIQUE,
      subscription_json TEXT, settings_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("subscriptions create err:", err.message); });

    db.run(`CREATE TABLE IF NOT EXISTS android_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, client_id TEXT NOT NULL,
      fcm_token TEXT NOT NULL UNIQUE, device_name TEXT,
      settings_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_seen_at DATETIME
    )`, (err) => { if (err) console.error("android_devices create err:", err.message); });

    db.run(`CREATE TABLE IF NOT EXISTS scraper_status (
      id TEXT PRIMARY KEY, name TEXT, last_run DATETIME,
      status TEXT, message TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("scraper_status create err:", err.message); });

    db.run(`CREATE TABLE IF NOT EXISTS scheduled_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at INTEGER NOT NULL, payload_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent INTEGER DEFAULT 0, sent_at INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, start_time DATETIME, end_time DATETIME,
      url TEXT, thumbnail_url TEXT, platform TEXT,
      event_type TEXT DEFAULT 'live',
      description TEXT, status TEXT DEFAULT 'scheduled',
      external_id TEXT,
      time_period TEXT,
      confirmed INTEGER NOT NULL DEFAULT 1 CHECK (confirmed IN (0,1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("events create err:", err.message); });

    db.run(`CREATE INDEX IF NOT EXISTS idx_events_start_time ON events (start_time DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_start_time_asc ON events (start_time ASC, status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_status ON events (status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_platform ON events (platform)`);

    db.run(`CREATE TABLE IF NOT EXISTS weekly_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL UNIQUE,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("weekly_messages create err:", err.message); });
    db.run(`CREATE INDEX IF NOT EXISTS idx_weekly_messages_week_start ON weekly_messages (week_start)`);

    // YT字幕原文キャッシュ（1動画1行）
    db.run(`CREATE TABLE IF NOT EXISTS video_transcripts (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT,
      title TEXT,
      lang TEXT DEFAULT 'ja',
      transcript TEXT NOT NULL,
      raw_json TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("video_transcripts create err:", err.message); });
    db.run(`CREATE INDEX IF NOT EXISTS idx_video_transcripts_fetched_at ON video_transcripts (fetched_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_video_transcripts_channel ON video_transcripts (channel_id)`);

    // 年別流行語キャッシュ（再計算で置き換え）
    db.run(`CREATE TABLE IF NOT EXISTS yearly_buzzwords (
      year INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      word TEXT NOT NULL,
      score REAL NOT NULL,
      count INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (year, rank)
    )`, (err) => { if (err) console.error("yearly_buzzwords create err:", err.message); });
    db.run(`CREATE INDEX IF NOT EXISTS idx_yearly_buzzwords_year ON yearly_buzzwords (year)`);

    // ベクトルDB同期の進捗（source 毎に最後に同期した行ID）
    db.run(`CREATE TABLE IF NOT EXISTS vector_sync_state (
      source TEXT PRIMARY KEY,
      last_id INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("vector_sync_state create err:", err.message); });

    // 配信ごとの要約（字幕チャンク要約）。source='minutes' としてベクトルDBへ埋め込まれる。
    // カラム定義は scripts/minutes-gen.js の ensureSchema と完全一致させること（互いに冪等ALTERで補完）。
    db.run(`CREATE TABLE IF NOT EXISTS video_minutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      topic TEXT,
      summary TEXT,
      facts TEXT,
      title TEXT,
      stream_date_jst TEXT,
      url TEXT,
      section TEXT,
      chunk_start_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("video_minutes create err:", err.message); });
    db.run(`CREATE INDEX IF NOT EXISTS idx_video_minutes_video_id ON video_minutes (video_id)`);
    // 既存DBへ章立て用カラムを追加（旧DBは topics のみ・section 無しのため）
    db.all(`PRAGMA table_info(video_minutes)`, [], (err, cols) => {
      if (err) return console.error("video_minutes pragma err:", err.message);
      const names = new Set((cols || []).map(c => c.name));
      const alters = [];
      if (!names.has("topic")) alters.push(`ALTER TABLE video_minutes ADD COLUMN topic TEXT`);
      if (!names.has("section")) alters.push(`ALTER TABLE video_minutes ADD COLUMN section TEXT`);
      if (!names.has("chunk_start_ms")) alters.push(`ALTER TABLE video_minutes ADD COLUMN chunk_start_ms INTEGER`);
      alters.forEach(sql => db.run(sql, e => { if (e) console.error("video_minutes alter err:", e.message); }));
      // 旧形式の行は start_ms がそのまま5分チャンク先頭だったため後付けする
      db.run(`UPDATE video_minutes SET chunk_start_ms = start_ms WHERE chunk_start_ms IS NULL AND section IS NULL`,
        e => { if (e) console.error("video_minutes backfill err:", e.message); });
    });

    // まいAIチャットの会話セッション（管理者ユーザー別）
    db.run(`CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user TEXT NOT NULL,
      title TEXT,
      r18 INTEGER NOT NULL DEFAULT 0,
      prefs TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("chat_sessions create err:", err.message); });
    db.run(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_admin ON chat_sessions (admin_user, updated_at)`);
    // 全セッション共通の「だーりんのお願い・好み」（管理者ユーザー別・1行）
    db.run(`CREATE TABLE IF NOT EXISTS chat_prefs (
      admin_user TEXT PRIMARY KEY,
      prefs TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("chat_prefs create err:", err.message); });
    // 既存DBのマイグレーション: 旧スキーマに prefs カラムが無ければ追加
    db.all(`PRAGMA table_info(chat_sessions)`, (err, cols) => {
      if (err) { console.error("chat_sessions PRAGMA err:", err.message); return; }
      if (!cols.some(c => c.name === "prefs")) {
        db.run(`ALTER TABLE chat_sessions ADD COLUMN prefs TEXT`, (e2) => {
          if (e2) console.error("chat_sessions add prefs err:", e2.message);
          else console.log("migration: chat_sessions.prefs added");
        });
      }
    });
    db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sources_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.error("chat_messages create err:", err.message); });
    db.run(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, id)`);

    ensureNotificationsSchema();
    ensureScheduledSchema();
    ensureEventsSchema();
    ensureSubscriptionsSchema();
    ensureAndroidSchema();
    ensureIndexes();
    cleanupDuplicates();
    backfillPlatformSettingsDefaults();

    const userRoutes = require("../src/core/user-routes");
    userRoutes.initUserTables(db);

    const twitterMediaSaver = require("../src/scrapers/twitter-media-saver");
    twitterMediaSaver.initMediaDb(db);
  });

  process.on("SIGINT", () => {
    console.log("SIGINT received: closing DB and exiting");
    db.close((err) => {
      if (err) console.error("DB close err:", err.message);
      else console.log("DB closed");
      process.exit(err ? 1 : 0);
    });
  });
}

function ensureNotificationsSchema() {
  const db = ctx.db;
  db.all("PRAGMA table_info(notifications)", [], (err, columns) => {
    if (err) { console.error("PRAGMA notifications err:", err.message); return; }
    const colNames = columns.map(c => c.name);
    if (!colNames.includes("platform")) {
      db.run("ALTER TABLE notifications ADD COLUMN platform TEXT");
      console.log("notifications.platform added");
    }
    if (!colNames.includes("tweet_id")) {
      db.run("ALTER TABLE notifications ADD COLUMN tweet_id TEXT");
      console.log("notifications.tweet_id added");
    }
    if (!colNames.includes("status")) {
      db.run("ALTER TABLE notifications ADD COLUMN status TEXT");
      db.run("UPDATE notifications SET status='success' WHERE status IS NULL");
      console.log("notifications.status added");
    }
    if (!colNames.includes("image")) {
      db.run("ALTER TABLE notifications ADD COLUMN image TEXT");
      console.log("notifications.image added");
    }
  });
}

function ensureEventsSchema() {
  const db = ctx.db;
  db.all("PRAGMA table_info(events)", [], (err, columns) => {
    if (err) { console.error("PRAGMA events err:", err.message); return; }
    const colNames = columns.map(c => c.name);
    if (!colNames.includes("confirmed")) {
      db.run("ALTER TABLE events ADD COLUMN confirmed INTEGER");
      console.log("events.confirmed added");
    }
    if (!colNames.includes("time_period")) {
      db.run("ALTER TABLE events ADD COLUMN time_period TEXT");
      console.log("events.time_period added");
    }
  });
}

function ensureScheduledSchema() {
  const db = ctx.db;
  db.all("PRAGMA table_info(scheduled_notifications)", [], (err, columns) => {
    if (err) { console.error("PRAGMA scheduled_notifications err:", err.message); return; }
    const colNames = columns.map(c => c.name);
    if (!colNames.includes("sent_at")) {
      db.run("ALTER TABLE scheduled_notifications ADD COLUMN sent_at INTEGER", (alterErr) => {
        if (alterErr) console.error("scheduled_notifications.sent_at add failed:", alterErr.message);
        else console.log("scheduled_notifications.sent_at added");
      });
    }

    // (kind, ref_id, sent) のインデックスは、この2列が揃ってから作る。
    // 従来は initDatabase() の直後に ensureIndexes() が走り、ALTER より先に
    // インデックスを作ろうとして "no such column: kind" になる。
    // その失敗はコールバック無しの db.run から uncaughtException として放出され、
    // uncaughtException ハンドラが 1 秒後にプロセスを落としていた
    //（新規DBを作るたび＝回帰テスト毎回・新規クローン初回に発生していた）。
    const needKind = !colNames.includes("kind");
    const needRefId = !colNames.includes("ref_id");
    let pending = (needKind ? 1 : 0) + (needRefId ? 1 : 0);
    const afterAlter = () => {
      pending -= 1;
      if (pending === 0) ensureScheduledEventIndex();
    };
    if (needKind) {
      db.run("ALTER TABLE scheduled_notifications ADD COLUMN kind TEXT", (alterErr) => {
        if (alterErr) console.error("scheduled_notifications.kind add failed:", alterErr.message);
        else console.log("scheduled_notifications.kind added");
        afterAlter();
      });
    }
    if (needRefId) {
      db.run("ALTER TABLE scheduled_notifications ADD COLUMN ref_id INTEGER", (alterErr) => {
        if (alterErr) console.error("scheduled_notifications.ref_id add failed:", alterErr.message);
        else console.log("scheduled_notifications.ref_id added");
        afterAlter();
      });
    }
    if (pending === 0) ensureScheduledEventIndex(); // 両列とも既存の DB
  });
}

function ensureScheduledEventIndex() {
  ctx.db.run(
    "CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_event_ref ON scheduled_notifications (kind, ref_id, sent)",
    (err) => {
      if (err) console.error("idx_scheduled_notifications_event_ref create err:", err.message);
    },
  );
}

function ensureSubscriptionsSchema() {
  const db = ctx.db;
  db.all("PRAGMA table_info(subscriptions)", [], (err, columns) => {
    if (err) { console.error("PRAGMA subscriptions err:", err.message); return; }
    const colNames = columns.map(c => c.name);
    if (!colNames.includes("user_id")) {
      db.run("ALTER TABLE subscriptions ADD COLUMN user_id INTEGER", (alterErr) => {
        if (alterErr) console.error("subscriptions.user_id add failed:", alterErr.message);
        else console.log("subscriptions.user_id added");
      });
    }
  });
}

function ensureAndroidSchema() {
  const db = ctx.db;
  db.all("PRAGMA table_info(android_devices)", [], (err, columns) => {
    if (err) { console.error("PRAGMA android_devices err:", err.message); return; }
    const colNames = columns.map(c => c.name);
    if (!colNames.includes("user_id")) {
      db.run("ALTER TABLE android_devices ADD COLUMN user_id INTEGER", (alterErr) => {
        if (alterErr) console.error("android_devices.user_id add failed:", alterErr.message);
        else console.log("android_devices.user_id added");
      });
    }
  });
}

function ensureIndexes() {
  const db = ctx.db;
  // コールバックを付けないと、失敗が uncaughtException として process を殺す。
  // インデックス作成の失敗は（後から直せばよい）致命扱いにせず、ログに残すだけにする。
  const createIndex = (sql) => {
    db.run(sql, (err) => {
      if (err) console.error("index create err:", err.message, "|", sql);
    });
  };
  createIndex("CREATE INDEX IF NOT EXISTS idx_subscriptions_client_id ON subscriptions (client_id)");
  createIndex("CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions (user_id)");
  createIndex("CREATE INDEX IF NOT EXISTS idx_android_devices_client_id ON android_devices (client_id)");
  createIndex("CREATE INDEX IF NOT EXISTS idx_android_devices_user_id ON android_devices (user_id)");
  createIndex("CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC)");
  createIndex("CREATE INDEX IF NOT EXISTS idx_notifications_platform_created ON notifications (platform, created_at)");
  createIndex("CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_due ON scheduled_notifications (sent, run_at)");
  // (kind, ref_id, sent) のインデックスは ensureScheduledEventIndex() が
  // 列追加完了後に作る（ここでは作らない — 上記の順序バグの原因だったため）
  console.log("indexes ensured");
}

function cleanupDuplicates() {
  const db = ctx.db;
  db.all("SELECT client_id, COUNT(*) c FROM subscriptions GROUP BY client_id HAVING c > 1", [], (err, duplicates) => {
    if (err || !duplicates?.length) return;
    console.log("duplicates:", duplicates.length);
    db.run("BEGIN");
    let pending = duplicates.length;
    duplicates.forEach((d) => {
      db.run("DELETE FROM subscriptions WHERE client_id = ? AND id NOT IN (SELECT MAX(id) FROM subscriptions WHERE client_id = ?)", [d.client_id, d.client_id], function () {
        pending--;
        if (pending === 0) db.run("COMMIT");
      });
    });
  });
}

function backfillPlatformSettingsDefaults() {
  const db = ctx.db;
  db.all("SELECT id, settings_json FROM subscriptions", [], (err, rows) => {
    if (err || !rows?.length) return;
    const targets = [];
    for (const row of rows) {
      let parsed = {};
      if (row.settings_json && typeof row.settings_json === "string") {
        try { parsed = JSON.parse(row.settings_json); } catch { parsed = {}; }
      }
      const merged = { ...ctx.DEFAULT_PLATFORM_SETTINGS, ...parsed };
      if (!merged.customLinks || typeof merged.customLinks !== "object") merged.customLinks = {};
      const mergedJson = JSON.stringify(merged);
      if (mergedJson !== (row.settings_json || "")) targets.push({ id: row.id, settingsJson: mergedJson });
    }
    if (!targets.length) return;
    let pending = targets.length;
    let updated = 0;
    for (const target of targets) {
      db.run("UPDATE subscriptions SET settings_json = ? WHERE id = ?", [target.settingsJson, target.id], function (updateErr) {
        if (!updateErr) updated += this.changes || 0;
        pending--;
        if (pending === 0) console.log("subscriptions.settings_json backfilled:", updated);
      });
    }
  });
}

module.exports = { initDatabase };
