// Node.js ランタイムの固定（2026-10-21 / v24.22.0 に統一）
//
// なぜ全プロセスで明示指定するか:
//   - 既定 node（nvm の alias）に依存すると、alias を変えた時に
//     プロセスごとに違うバージョンが混在する（実際に v20 / v22 が混在していた）
//   - 2026-04-30 で Node 20 が EOL、Node 22 も 2027-04-30 で EOL になる
//   - cron の PATH は /usr/bin/node（v18）を見るので、PATH 依存は最悪 EOL を掴む
//
// なぜ exec_mode も明示指定するか:
//   - pm2 の **cluster モードでは interpreter が無視される**
//     （pm2 デーモン自身の Node で動く → /usr/bin/node = v18 を掴む）。
//     fork モードの既定に任せると、既存定義とのマージで cluster になりうる。
//   - pm2 jlist / /proc/<pid>/exe で実体を必ず確認すること。
//
// 変更時は AGENTS.md §5 / docs/ARCHITECTURE.md §2 も同時に更新すること。
const NODE_BIN = '/home/yuzuki/.nvm/versions/node/v24.22.0/bin/node';

module.exports = {
  apps: [{
    name: 'mai-push-worker',
    script: './main.js',
    cwd: '/var/www/html/koinoyamai.love',
    interpreter: NODE_BIN,
    exec_mode: 'fork',
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
    cwd: '/var/www/html/koinoyamai.love',
    interpreter: NODE_BIN,
    exec_mode: 'fork',
    // メモリ上限での自動再起動（2026-09-27 の global OOM 対策）
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production'
    }
  },
  {
    name: 'mai-push-api',
    script: './server.js',
    cwd: '/var/www/html/koinoyamai.love',
    // sharp@0.35 は Node >= 20.9 が必須（それ未満では起動クラッシュする）
    interpreter: NODE_BIN,
    exec_mode: 'fork',
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
    cwd: '/home/yuzuki/koinoyamai.love-test',   // staging worktree（git worktree: stagingブランチ）
    interpreter: NODE_BIN,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'development',              // server.js が .env.test / 定期タスクskip判定に使用
      PORT: '8081',
      DB_FILE_NAME: 'data-test.db',         // staging用スナップショットDB
      ADMIN_DB_PATH: '/home/yuzuki/koinoyamai.love-test/data-test.db',
      DISABLE_NOTIFICATIONS: '1',           // 実push完全抑止（routes/notify.js がmimic応答）
      NOTIFY_API_URL: 'http://localhost:8081/api/notify'
    },
    max_memory_restart: '1G',
    instances: 1
  },
  {
    name: 'mai-push-worker-test',
    script: './main.js',
    cwd: '/home/yuzuki/koinoyamai.love-test',
    interpreter: NODE_BIN,
    exec_mode: 'fork',
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
