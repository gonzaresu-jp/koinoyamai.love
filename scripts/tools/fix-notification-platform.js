#!/usr/bin/env node
/**
 * notifications.platform の正規化（1回きりの移行スクリプト）
 *
 * 各スクレイパが notify に渡す settingKey が platform 列にそのまま保存されるが、
 * 一部が DEFAULT_PLATFORM_SETTINGS の正規キーと食い違っていた。
 *
 *   twitcasting.js  settingKey: screenId   -> 'c:koinoya_mai' が保存されていた
 *   ytcommunity.js  settingKey なし        -> type の 'ytcommunity' が保存されていた
 *   （過去の twitter.js）                  -> 小文字 'twittermain' が残っている
 *
 * 送信側は修正済み。このスクリプトは既存行を正規キーに揃える。
 *
 *   確認のみ: node scripts/tools/fix-notification-platform.js
 *   実行     : node scripts/tools/fix-notification-platform.js --apply
 *
 * --apply を付けるまで DB は一切変更しない（dry-run が既定）。
 * 何度実行しても安全（対象が無ければ何もしない）。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.argv.find(a => a.startsWith('--db='))?.slice(5)
  || path.join(__dirname, '../..', 'data.db');

// SQLite の = は既定で大文字小文字を区別するので、小文字表記だけを狙い撃ちできる
const RULES = [
  { to: 'twitcasting',      where: "platform LIKE 'c:%'",          desc: 'ツイキャス screenId' },
  { to: 'youtubeCommunity', where: "LOWER(platform) = 'ytcommunity'", desc: 'YTコミュニティ' },
  { to: 'twitterMain',      where: "platform = 'twittermain'",     desc: 'X(メイン) 小文字' },
  { to: 'twitterSub',       where: "platform = 'twittersub'",      desc: 'X(サブ) 小文字' },
];

const db = new sqlite3.Database(DB_PATH);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

(async () => {
  console.log(`DB: ${DB_PATH}`);
  console.log(`モード: ${APPLY ? '★実行（DBを更新します）' : 'dry-run（変更しません）'}\n`);

  await run('PRAGMA busy_timeout = 10000');

  console.log('■ 変更対象');
  let total = 0;
  const pending = [];
  for (const rule of RULES) {
    const rows = await all(
      `SELECT platform, COUNT(*) AS c, MIN(created_at) AS first, MAX(created_at) AS last
       FROM notifications WHERE ${rule.where} AND platform <> ? GROUP BY platform ORDER BY c DESC`,
      [rule.to]
    );
    for (const r of rows) {
      total += r.c;
      console.log(`  ${JSON.stringify(r.platform)} -> ${JSON.stringify(rule.to)}  ${r.c}件  (${r.first} 〜 ${r.last})  [${rule.desc}]`);
    }
    if (rows.length) pending.push(rule);
  }

  if (!total) {
    console.log('  なし（移行済み）');
    db.close();
    return;
  }
  console.log(`  合計 ${total}件\n`);

  if (!APPLY) {
    console.log('実際に更新するには --apply を付けて再実行してください。');
    db.close();
    return;
  }

  await run('BEGIN IMMEDIATE');
  try {
    let changed = 0;
    for (const rule of pending) {
      const r = await run(
        `UPDATE notifications SET platform = ? WHERE ${rule.where} AND platform <> ?`,
        [rule.to, rule.to]
      );
      console.log(`  ${rule.to.padEnd(18)} ${r.changes}件`);
      changed += r.changes;
    }
    await run('COMMIT');
    console.log(`\n■ 更新完了: 合計 ${changed}件`);
  } catch (e) {
    await run('ROLLBACK').catch(() => {});
    console.error('■ 失敗（ロールバック済み）:', e.message);
    db.close();
    process.exitCode = 1;
    return;
  }

  const after = await all(
    `SELECT COALESCE(NULLIF(TRIM(platform), ''), '(empty)') AS platform, COUNT(*) AS c
     FROM notifications GROUP BY platform ORDER BY c DESC`
  );
  console.log('\n■ 移行後の platform 内訳');
  for (const r of after) console.log(`  ${String(r.platform).padEnd(20)} ${r.c}`);

  console.log('\nAPIを再起動すると history.json も自動で作り直されます: npm run restart:api');
  db.close();
})().catch(e => {
  console.error('エラー:', e);
  process.exitCode = 1;
});
