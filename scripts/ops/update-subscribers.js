#!/usr/bin/env node
// 登録者数の日次自動更新
//
// YouTube Data API (channels.list, 1ユニット/回) から登録者数を取得し、
// webui/data/*.txt（subscribers.js が読むグラフ用データ）に「YYYY/MM/DD:万人」形式で追記する。
//   - 1日1行。同じ日に再実行した場合はその日の行を上書き（冪等）
//   - API の登録者数は有効数字3桁に丸められて返る（29.9万 / 2.48万 など）ので、手入力時代と同じ精度
//   - 書き込みは一時ファイル → rename で行い、グラフ側が途中の状態を読まないようにする
//
// 使い方:
//   node scripts/ops/update-subscribers.js            # 取得して追記
//   node scripts/ops/update-subscribers.js --dry-run  # 追記内容を表示するだけ
// cron（elza）: 5 0 * * * （JST 0:05 に前日分ではなく「その日の値」を記録）
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../..', '.env'), quiet: true });

const ROOT = path.join(__dirname, '../..');
const API_KEY = process.env.YOUTUBE_API_KEY || '';
const DRY_RUN = process.argv.includes('--dry-run');

// channel_id → グラフ用データファイル
const TARGETS = [
  { channelId: 'UCgttI8QfdWhvd3SRtCYcJzw', file: 'webui/data/koinoyamaich.txt' },  // メイン（koinoyamai ch.）
  { channelId: 'UCElHA6-5CBmgWODVWNxS8VA', file: 'webui/data/koinoyamaisub.txt' }, // サブ（koinoyamai subch.）
];

function jstDate(d = new Date()) {
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())}`;
}

// 人数 → 万人（末尾の 0 は落とす: 299000→29.9, 24800→2.48, 906→0.0906）
function toMan(count) {
  return String(Number((count / 10000).toFixed(4)));
}

async function fetchCounts() {
  if (!API_KEY) throw new Error('YOUTUBE_API_KEY が .env にありません');
  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', 'statistics,snippet');
  url.searchParams.set('id', TARGETS.map((t) => t.channelId).join(','));
  url.searchParams.set('key', API_KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}: ${body?.error?.message || ''}`);
  const out = {};
  for (const item of body.items || []) {
    const st = item.statistics || {};
    if (st.hiddenSubscriberCount) continue;
    const n = parseInt(st.subscriberCount, 10);
    if (Number.isFinite(n) && n > 0) out[item.id] = { count: n, title: item.snippet?.title || '' };
  }
  return out;
}

function upsertLine(file, date, value) {
  const abs = path.join(ROOT, file);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const last = lines[lines.length - 1] || '';
  const [lastDate, lastVal] = last.split(':');
  const line = `${date}:${value}`;
  let action;
  if (lastDate === date) {
    if (lastVal === value) return { action: 'unchanged', line };
    lines[lines.length - 1] = line;
    action = 'replaced';
  } else if (lastDate && lastDate > date) {
    return { action: 'skipped (file has a newer date)', line };
  } else {
    lines.push(line);
    action = 'appended';
  }
  if (!DRY_RUN) {
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, abs);
  }
  return { action, line };
}

(async () => {
  const date = jstDate();
  const counts = await fetchCounts();
  let failed = 0;
  for (const t of TARGETS) {
    const c = counts[t.channelId];
    if (!c) {
      console.error(`[subscribers] ${t.channelId}: 登録者数を取得できませんでした（非公開 or 取得失敗）`);
      failed++;
      continue;
    }
    const r = upsertLine(t.file, date, toMan(c.count));
    console.log(`[subscribers] ${date} ${c.title} ${c.count} -> ${t.file}: ${r.action} (${r.line})${DRY_RUN ? ' [dry-run]' : ''}`);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('[subscribers] error:', e.message || e);
  process.exit(1);
});
