const axios = require('axios');
const os = require('os');
const path = require('path');

// レート制限用の状態保持 (メモリ上に保持)
const alertLimits = new Map();
// 同じキーでの通知を制限する期間 (ミリ秒) - 1時間
const LIMIT_DURATION_MS = 60 * 60 * 1000;

// 定期的に古いエントリをクリーンアップ（5分ごと）
setInterval(() => {
  const cutoff = Date.now() - LIMIT_DURATION_MS;
  for (const [key, timestamp] of alertLimits.entries()) {
    if (timestamp < cutoff) alertLimits.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * Discord Webhook へメッセージを送信する
 * @param {string} title - 通知の太字タイトル
 * @param {string} description - 通知の詳細メッセージ
 * @param {string} level - 'ERROR' | 'WARN' | 'INFO'
 * @param {string} limitKey - スパム防止用のキー（省略可能）
 */
async function sendDiscordAlert(title, description, level = 'WARN', limitKey = null) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  if (!token || !channelId) {
    console.debug('[Discord] Bot Token or Channel ID is not set. Skipping alert.');
    return;
  }

  // スパム防止
  if (limitKey) {
    const lastSent = alertLimits.get(limitKey);
    if (lastSent && Date.now() - lastSent < LIMIT_DURATION_MS) {
      console.log(`[Discord] スパム防止のため通知をスキップしました (key: ${limitKey})`);
      return;
    }
  }

  const colors = {
    'ERROR': 16711680, // 赤
    'WARN': 16776960,  // 黄
    'INFO': 65280      // 緑
  };

  // マシン名を取得してどこからの通知かわかるようにする
  const hostName = os.hostname();

  const embed = {
    title: title,
    description: description,
    color: colors[level] || colors['INFO'],
    footer: {
      text: `Host: ${hostName} | mai-push system alert`
    },
    timestamp: new Date().toISOString()
  };

  const payload = {
    embeds: [embed]
  };

  try {
    // Discord Bot API を使用してメッセージを投稿
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bot ${token.replace(/"/g, '')}`, // 念のため引用符を除去
          'Content-Type': 'application/json',
          // Discord の Cloudflare は Python/Node の既定 User-Agent を 1010 で遮断する
          'User-Agent': 'mai-push-alert (' + (process.env.PUBLIC_URL || 'https://mai.honna-yuzuki.com') + ', 1.0)'
        }
      }
    );

    if (limitKey) {
      alertLimits.set(limitKey, Date.now());
    }
    console.log(`[Discord] アラートを送信しました: ${title}`);
  } catch (err) {
    console.error('[Discord] Bot送信に失敗しました:', err.response ? err.response.data : err.message);
  }
}

/**
 * 簡易的なCPU使用率計算
 */
let lastCpuInfo = os.cpus();
function getCpuUsagePercent() {
  const cpus = os.cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;

  for (let cpu in cpus) {
    user += cpus[cpu].times.user;
    nice += cpus[cpu].times.nice;
    sys += cpus[cpu].times.sys;
    irq += cpus[cpu].times.irq;
    idle += cpus[cpu].times.idle;
  }

  let lastUser = 0, lastNice = 0, lastSys = 0, lastIdle = 0, lastIrq = 0;
  for (let cpu in lastCpuInfo) {
    lastUser += lastCpuInfo[cpu].times.user;
    lastNice += lastCpuInfo[cpu].times.nice;
    lastSys += lastCpuInfo[cpu].times.sys;
    lastIrq += lastCpuInfo[cpu].times.irq;
    lastIdle += lastCpuInfo[cpu].times.idle;
  }

  const total = (user - lastUser) + (nice - lastNice) + (sys - lastSys) + (irq - lastIrq) + (idle - lastIdle);
  const totalIdle = idle - lastIdle;
  const usage = 100 - ~~(100 * totalIdle / total);

  lastCpuInfo = cpus;
  return usage;
}

/**
 * 定期的にシステムリソースを監視する
 * @param {number} checkIntervalMs - デフォルトは5分 (300000)
 */
function startSystemMonitor(checkIntervalMs = 5 * 60 * 1000) {
  console.log('[System Monitor] システムリソースの監視を開始しました');

  // CPU計算の初期化バッファ
  setTimeout(getCpuUsagePercent, 1000);

  setInterval(async () => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round(usedMem / totalMem * 100);
    const cpuPercent = getCpuUsagePercent();

    // 90%以上の場合は Discord に警告を投げる
    if (memPercent >= 90) {
      await sendDiscordAlert(
        '⚠️ サーバーメモリ枯渇 警告',
        `物理メモリの使用率が **${memPercent}%** に達しています。\n\n**詳細:**\n- 空きメモリ: ${(freeMem / 1024 / 1024 / 1024).toFixed(2)} GB\n- 使用中メモリ: ${(usedMem / 1024 / 1024 / 1024).toFixed(2)} GB\n- 合計: ${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB\n\nプロセス停止やPM2の再起動が発生する可能性があります。`,
        'WARN',
        'sys_mem_alert'
      );
    }

    if (cpuPercent >= 90) {
      await sendDiscordAlert(
        '🔥 サーバー高負荷 警告',
        `CPUの使用率が **${cpuPercent}%** に達しています。\nシステムが重くなっている可能性があります。`,
        'WARN',
        'sys_cpu_alert'
      );
    }
  }, checkIntervalMs).unref();
}

/**
 * 致命的エラー発生時に遺言を残す
 */
function attachGlobalCrashHandlers() {
  process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await sendDiscordAlert(
      '💥 重大なクラッシュ (Uncaught Exception)',
      `サーバープロセスが致命的なエラーでダウンします！\n\`\`\`js\n${error.stack || error.message}\n\`\`\``,
      'ERROR'
    );
    setTimeout(() => process.exit(1), 1000); // ログを確実に送るために少し待つ
  });

  process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    const msg = reason instanceof Error ? reason.stack : String(reason);
    await sendDiscordAlert(
      '💥 重大なクラッシュ (Unhandled Rejection)',
      `処理されないPromiseのエラーが発生しました。\n\`\`\`js\n${msg}\n\`\`\``,
      'ERROR'
    );
    // Unhandled Rejection は即死させないことが多いが、要件次第で exit
  });
}

module.exports = {
  sendDiscordAlert,
  startSystemMonitor,
  attachGlobalCrashHandlers
};
