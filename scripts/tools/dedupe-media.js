// scripts/tools/dedupe-media.js
// 既存メディアの知覚ハッシュ(media_hash)をDBにバックフィルし、
// 類似画像(重複)を検出してファイルとDBレコードを削除する一括処理
//
// 使い方:
//   node scripts/tools/dedupe-media.js              # ドライラン(何も削除しない)
//   node scripts/tools/dedupe-media.js --apply      # 実際に重複を削除
//
// 動作:
//   1. twitter_media の全画像レコードを走査
//   2. 各画像の dHash を計算して media_hash に保存(未計算分のみ)
//   3. ハミング距離が HAMMING_THRESHOLD 以下の重複グループを検出
//   4. グループ内で最も古い1件を残し、他を削除(--apply時)

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const sharp = require('sharp');

const DB_PATH = path.join(__dirname, '../..', 'data.db');
const APPLY = process.argv.includes('--apply');
const HAMMING_THRESHOLD = parseInt(process.env.MEDIA_HAMMING_THRESHOLD || '8', 10);

const db = new sqlite3.Database(DB_PATH);

function hashToHex(hash) {
  return hash.toString(16).padStart(16, '0');
}

function hexToHash(hex) {
  if (!hex) return null;
  try {
    return BigInt('0x' + hex);
  } catch {
    return null;
  }
}

function hammingDistance(a, b) {
  let diff = a ^ b;
  let count = 0;
  while (diff) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

async function computeImageHash(filePath) {
  try {
    const data = await sharp(filePath, { failOn: 'none' })
      .resize(9, 8, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();
    let hash = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const left = data[y * 9 + x];
        const right = data[y * 9 + x + 1];
        hash = (hash << 1n) | (left < right ? 1n : 0n);
      }
    }
    return hash;
  } catch (e) {
    console.warn(`  [skip] ハッシュ計算失敗: ${filePath} (${e.message})`);
    return null;
  }
}

async function main() {
  console.log(`=== メディア重複掃除 ${APPLY ? '[実際に削除]' : '[ドライラン]'} ===`);
  console.log(`ハミング閾値: ${HAMMING_THRESHOLD}`);

  // media_hash カラムが無ければ追加
  const columns = await new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(twitter_media)', [], (err, r) => (err ? reject(err) : resolve(r)));
  });
  if (!columns.some(c => c.name === 'media_hash')) {
    await new Promise((resolve, reject) => {
      db.run('ALTER TABLE twitter_media ADD COLUMN media_hash TEXT', (err) => (err ? reject(err) : resolve()));
    });
    console.log('media_hash カラムを追加しました');
  }

  const rows = await new Promise((resolve, reject) => {
    db.all(
      `SELECT id, tweet_id, username, media_type, local_path, media_hash, created_at
       FROM twitter_media
       WHERE media_type = 'image'
       ORDER BY created_at ASC`,
      (err, r) => (err ? reject(err) : resolve(r))
    );
  });

  console.log(`画像レコード: ${rows.length}件`);

  // 1. media_hash のバックフィル
  let backfilled = 0;
  const records = [];
  for (const row of rows) {
    let hash = hexToHash(row.media_hash);
    if (hash == null) {
      if (!row.local_path || !fs.existsSync(row.local_path)) {
        console.warn(`  [missing] ファイル不在: id=${row.id} ${row.local_path}`);
        records.push({ ...row, hash: null, missing: true });
        continue;
      }
      hash = await computeImageHash(row.local_path);
      if (hash != null) {
        await new Promise((resolve) => {
          db.run('UPDATE twitter_media SET media_hash = ? WHERE id = ?', [hashToHex(hash), row.id], () => resolve());
        });
        backfilled++;
      }
    }
    records.push({ ...row, hash });
  }
  console.log(`media_hash バックフィル: ${backfilled}件`);

  // 2. 重複グループ検出（O(n^2)だが画像数が数千でも問題ない範囲）
  //    同一ツイート内の画像同士(tweet_id同じ)は連続ショットの可能性があるため比較対象外
  const compared = new Set();
  const duplicates = []; // { keep, drop }
  const keptSet = new Set();

  for (let i = 0; i < records.length; i++) {
    const a = records[i];
    if (a.hash == null || a.missing) continue;
    if (keptSet.has(a.id)) continue;
    for (let j = i + 1; j < records.length; j++) {
      const b = records[j];
      if (b.hash == null || b.missing) continue;
      if (keptSet.has(b.id)) continue;
      if (a.tweet_id === b.tweet_id) continue; // 同一ツイート内は比較しない
      const key = a.id + '-' + b.id;
      if (compared.has(key)) continue;
      compared.add(key);

      const dist = hammingDistance(a.hash, b.hash);
      if (dist <= HAMMING_THRESHOLD) {
        duplicates.push({ keep: a, drop: b, distance: dist });
        keptSet.add(b.id);
      }
    }
  }

  console.log(`検出された重複: ${duplicates.length}件`);

  let removedFiles = 0;
  let removedRecords = 0;
  for (const dup of duplicates) {
    const keepName = path.basename(dup.keep.local_path || '?');
    const dropName = path.basename(dup.drop.local_path || '?');
    console.log(`  [dup] ${dropName} (id=${dup.drop.id}) → ${keepName} (id=${dup.keep.id}) 距離=${dup.distance}`);

    if (APPLY) {
      if (dup.drop.local_path && fs.existsSync(dup.drop.local_path)) {
        fs.unlinkSync(dup.drop.local_path);
        removedFiles++;
      }
      await new Promise((resolve) => {
        db.run('DELETE FROM twitter_media WHERE id = ?', [dup.drop.id], (err) => {
          if (err) console.error(`  [error] DB削除失敗 id=${dup.drop.id}:`, err.message);
          else removedRecords++;
          resolve();
        });
      });
    }
  }

  if (APPLY) {
    console.log(`\n完了: ファイル削除 ${removedFiles}件 / レコード削除 ${removedRecords}件`);
  } else {
    console.log('\nドライランのため何も削除していません。実際に削除するには --apply を付けて再実行してください。');
  }

  db.close();
}

main().catch((e) => {
  console.error('処理エラー:', e);
  db.close();
});
