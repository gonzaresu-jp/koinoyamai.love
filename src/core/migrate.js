#!/usr/bin/env node

/**
 * データベースマイグレーションスクリプト
 * イベントテーブルを作成し、サンプルデータを投入します
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

console.log('📊 Database Migration Starting...');
console.log(`Database: ${DB_PATH}`);

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  console.log('\n1️⃣ Creating events table...');
  
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME,
    url TEXT,
    thumbnail_url TEXT,
    platform TEXT,
    event_type TEXT DEFAULT 'live',
    description TEXT,
    status TEXT DEFAULT 'scheduled',
    external_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, function(err) {
    if (err) {
      console.error('❌ Error creating events table:', err.message);
    } else {
      console.log('✅ Events table created successfully');
    }
  });

  console.log('\n2️⃣ Creating indexes...');

  db.run(`CREATE INDEX IF NOT EXISTS idx_events_start_time ON events (start_time DESC)`, (err) => {
    if (err) console.error('❌ Error creating idx_events_start_time:', err.message);
    else console.log('✅ Index idx_events_start_time created');
  });

  db.run(`CREATE INDEX IF NOT EXISTS idx_events_status ON events (status)`, (err) => {
    if (err) console.error('❌ Error creating idx_events_status:', err.message);
    else console.log('✅ Index idx_events_status created');
  });

  db.run(`CREATE INDEX IF NOT EXISTS idx_events_platform ON events (platform)`, (err) => {
    if (err) console.error('❌ Error creating idx_events_platform:', err.message);
    else console.log('✅ Index idx_events_platform created');
  });

  console.log('\n3️⃣ Checking for sample data...');

  db.get('SELECT COUNT(*) as count FROM events', [], (err, row) => {
    if (err) {
      console.error('❌ Error checking events:', err.message);
      return;
    }

    const count = row.count || 0;
    console.log(`Current events count: ${count}`);

    if (count === 0 && process.env.INSERT_SAMPLE_DATA === 'true') {
      console.log('\n4️⃣ Inserting sample data...');
      insertSampleData();
    } else if (count === 0) {
      console.log('\n💡 Tip: Set INSERT_SAMPLE_DATA=true to insert sample data');
      finishMigration();
    } else {
      console.log('✅ Events already exist, skipping sample data');
      finishMigration();
    }
  });
});

function insertSampleData() {
  const now = new Date();
  const samples = [];

  // 今日のイベント
  const today = new Date(now);
  today.setHours(20, 0, 0, 0);
  samples.push({
    title: '【雑談配信】まいちゃんとおしゃべり',
    start_time: today.toISOString(),
    platform: 'youtube',
    event_type: 'live',
    status: 'scheduled',
    url: 'https://youtube.com/@example',
    description: '今日の出来事をお話しします！'
  });

  // 明日のイベント
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(21, 0, 0, 0);
  samples.push({
    title: 'ゲーム配信: Apexやります！',
    start_time: tomorrow.toISOString(),
    platform: 'youtube',
    event_type: 'live',
    status: 'scheduled',
    url: 'https://youtube.com/@example',
    description: 'ランクマ頑張ります'
  });

  // 3日後のイベント
  const dayAfter = new Date(now);
  dayAfter.setDate(dayAfter.getDate() + 3);
  dayAfter.setHours(19, 30, 0, 0);
  samples.push({
    title: 'ツイキャス: 弾き語り配信',
    start_time: dayAfter.toISOString(),
    platform: 'twitcasting',
    event_type: 'live',
    status: 'scheduled',
    url: 'https://twitcasting.tv/example',
    description: 'リクエストも受け付けます♪'
  });

  // 動画投稿予定
  const videoDay = new Date(now);
  videoDay.setDate(videoDay.getDate() + 2);
  videoDay.setHours(18, 0, 0, 0);
  samples.push({
    title: '【新曲MV】オリジナル曲公開',
    start_time: videoDay.toISOString(),
    platform: 'youtube',
    event_type: 'video',
    status: 'scheduled',
    url: 'https://youtube.com/@example',
    description: '新しいオリジナル曲のMVをプレミア公開！'
  });

  const stmt = db.prepare(`
    INSERT INTO events (title, start_time, platform, event_type, status, url, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  samples.forEach((sample, index) => {
    stmt.run(
      sample.title,
      sample.start_time,
      sample.platform,
      sample.event_type,
      sample.status,
      sample.url,
      sample.description,
      function(err) {
        if (err) {
          console.error(`❌ Error inserting sample ${index + 1}:`, err.message);
        } else {
          inserted++;
          console.log(`✅ Sample event ${index + 1} inserted (ID: ${this.lastID})`);
        }

        if (inserted + (samples.length - inserted) === samples.length) {
          stmt.finalize();
          console.log(`\n✅ Inserted ${inserted}/${samples.length} sample events`);
          finishMigration();
        }
      }
    );
  });
}

function finishMigration() {
  db.close((err) => {
    if (err) {
      console.error('\n❌ Error closing database:', err.message);
      process.exit(1);
    } else {
      console.log('\n✅ Migration completed successfully!');
      console.log('\n📝 Next steps:');
      console.log('  1. Restart your server: node server.js');
      console.log('  2. Access admin panel: http://localhost:8080/admin/events.html');
      console.log('  3. View events API: http://localhost:8080/api/events');
      console.log('  4. View RSS feed: http://localhost:8080/api/events/rss');
      process.exit(0);
    }
  });
}

// エラーハンドリング
process.on('uncaughtException', (err) => {
  console.error('\n❌ Uncaught Exception:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ Unhandled Rejection:', reason);
  process.exit(1);
});