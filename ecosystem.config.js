module.exports = {
  apps: [{
    name: 'mai-push-worker',
    script: './main.js',
    cwd: '/var/www/html/mai-push',
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PORT: '3002',
      NOTIFY_API_URL: 'http://localhost:8080/api/notify',
      // Twitch等の認証情報は .env (dotenv) から供給する（GitHub公開リポジトリに直書きしない）
    }
  },
  {
    name: 'discord-bot',
    script: './discord-bot.js',
    cwd: '/var/www/html/mai-push',
    // メモリ上限での自動再起動（2026-09-27 の global OOM 対策）
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production'
    }
  },
  {
    name: 'mai-push-api',
    script: './server.js',
    cwd: '/var/www/html/mai-push',
    // sharp@0.35 は Node >= 20.9 が必須のため 22 系に固定 (system node 18 では起動クラッシュする)
    interpreter: '/home/yuzuki/.nvm/versions/node/v22.12.0/bin/node',
    env: {
      NODE_ENV: 'production',
      PORT: '8080'
    },
    max_memory_restart: '1G'
  },
  // ===== テスト環境（staging）: 本番と同居・DB/通知/定期タスクを分離 =====
  // 使い方:
  //   bash scripts/deploy/sync-test-db.sh               # 本番data.db  -> data-test.db スナップショット
  //   pm2 start ecosystem.config.js --only mai-push-api-test
  //   pm2 stop  mai-push-api-test
  {
    name: 'mai-push-api-test',
    script: './server.js',
    cwd: '/home/yuzuki/mai-push-test',   // staging worktree（git worktree: stagingブランチ）
    interpreter: '/home/yuzuki/.nvm/versions/node/v22.12.0/bin/node',
    env: {
      NODE_ENV: 'development',              // server.js が .env.test / 定期タスクskip判定に使用
      PORT: '8081',
      DB_FILE_NAME: 'data-test.db',         // staging用スナップショットDB
      ADMIN_DB_PATH: '/home/yuzuki/mai-push-test/data-test.db',
      DISABLE_NOTIFICATIONS: '1',           // 実push完全抑止（routes/notify.js がmimic応答）
      NOTIFY_API_URL: 'http://localhost:8081/api/notify'
    },
    max_memory_restart: '1G',
    exec_mode: 'fork',
    instances: 1
  },
  {
    name: 'mai-push-worker-test',
    script: './main.js',
    cwd: '/home/yuzuki/mai-push-test',
    env: {
      NODE_ENV: 'development',
      PORT: '3003',
      DB_FILE_NAME: 'data-test.db',
      DISABLE_NOTIFICATIONS: '1',
      NOTIFY_API_URL: 'http://localhost:8081/api/notify'
    },
    max_memory_restart: '2G',
    instances: 1,
    // スクレイパーが本番同時稼働でx.com等に負荷をかけるため、テストのworkerは必要時のみ手動起動
    autorestart: true,
    restart_delay: 5000
  }]
};
