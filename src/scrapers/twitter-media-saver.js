// twitter-media-saver.js
// ツイートの画像・動画を /mnt/hs-ssd/twitter-mai/ にダウンロード保存し、DBで管理する

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const sharp = require('sharp');

// 知覚ハッシュ(dHash)で画像の類似度を判定し、重複保存を防ぐ
// HAMMING_THRESHOLD 以下のハミング距離なら「同じ画像」とみなす
const HAMMING_THRESHOLD = parseInt(process.env.MEDIA_HAMMING_THRESHOLD || '8', 10);
const IMAGE_HASH_SIZE = 8; // 8x8 -> 64bit hash

// 保存先ベースディレクトリ
const MEDIA_BASE_DIR = process.env.TWITTER_MEDIA_DIR || '/mnt/hs-ssd/twitter-mai';

// yt-dlp パス
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';

// DB参照（外部から注入）
let _db = null;

/**
 * DB初期化: twitter_media テーブルを作成
 */
function initMediaDb(db) {
  _db = db;
  db.run(`CREATE TABLE IF NOT EXISTS twitter_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT NOT NULL,
    username TEXT NOT NULL,
    media_type TEXT NOT NULL,
    original_url TEXT,
    local_path TEXT NOT NULL,
    file_size INTEGER,
    tweet_text TEXT,
    tweet_date DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    media_hash TEXT,
    UNIQUE(tweet_id, original_url)
  )`, (err) => {
    if (err) console.error('[TwitterMedia] テーブル作成エラー:', err.message);
    else console.log('[TwitterMedia] twitter_media テーブル確認済み');
  });

  // 既存テーブルに media_hash カラムが無ければ追加
  db.all(`PRAGMA table_info(twitter_media)`, [], (pragmaErr, columns) => {
    if (pragmaErr) return;
    const hasHash = columns.some(c => c.name === 'media_hash');
    if (!hasHash) {
      db.run(`ALTER TABLE twitter_media ADD COLUMN media_hash TEXT`, (alterErr) => {
        if (alterErr) console.error('[TwitterMedia] media_hashカラム追加エラー:', alterErr.message);
        else console.log('[TwitterMedia] media_hashカラムを追加しました');
      });
    }
  });

  // インデックス
  db.run(`CREATE INDEX IF NOT EXISTS idx_twitter_media_username ON twitter_media (username, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_twitter_media_tweet_id ON twitter_media (tweet_id)`);
}

/**
 * 画像の知覚ハッシュ(dHash)を計算する
 * リサイズ・再圧縮されても同一/類似画像なら近い値になる
 * @param {string|Buffer} input 画像ファイルパスまたはBuffer
 * @returns {Promise<bigint|null>} 64bitハッシュ(失敗時はnull)
 */
async function computeImageHash(input) {
  try {
    // 8x8グレースケールに縮小 → 隣接ピクセルの明度差で64bitハッシュ
    const data = await sharp(input, { failOn: 'none' })
      .resize(IMAGE_HASH_SIZE + 1, IMAGE_HASH_SIZE, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();

    let hash = 0n;
    for (let y = 0; y < IMAGE_HASH_SIZE; y++) {
      for (let x = 0; x < IMAGE_HASH_SIZE; x++) {
        const left = data[y * (IMAGE_HASH_SIZE + 1) + x];
        const right = data[y * (IMAGE_HASH_SIZE + 1) + x + 1];
        hash = (hash << 1n) | (left < right ? 1n : 0n);
      }
    }
    return hash;
  } catch (e) {
    console.warn('[TwitterMedia] 画像ハッシュ計算失敗:', e.message);
    return null;
  }
}

/**
 * 2つの64bitハッシュのハミング距離(異なるビット数)を計算
 */
function hammingDistance(a, b) {
  let diff = a ^ b;
  let count = 0;
  while (diff) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/**
 * 画像ハッシュを16桁hex文字列に変換
 */
function hashToHex(hash) {
  return hash.toString(16).padStart(16, '0');
}

/**
 * 16桁hex文字列をBigIntに変換
 */
function hexToHash(hex) {
  if (!hex) return null;
  try {
    return BigInt('0x' + hex);
  } catch {
    return null;
  }
}

/**
 * 指定ハッシュが既存の画像と類似しているかチェック
 * @param {bigint} hash 判定対象のハッシュ
 * @param {string} username 対象アカウント(指定時はそのアカウント内のみ比較)
 * @param {string|null} excludeTweetId 同じツイート内の画像同士は比較しない(連続ショット誤判定防止)
 * @returns {Promise<{duplicate: boolean, match: {id:number, local_path:string, distance:number}|null}>}
 */
function isDuplicateImage(hash, username, excludeTweetId) {
  return new Promise((resolve) => {
    if (!_db || hash == null) return resolve({ duplicate: false, match: null });

    const conditions = ["media_type = 'image'", "media_hash IS NOT NULL", "media_hash != ''"];
    const params = [];
    if (username) {
      conditions.push('username = ?');
      params.push(username);
    }
    if (excludeTweetId) {
      conditions.push('tweet_id != ?');
      params.push(excludeTweetId);
    }
    const sql = `SELECT id, local_path, media_hash FROM twitter_media WHERE ${conditions.join(' AND ')}`;

    _db.all(sql, params, (err, rows) => {
      if (err || !rows || rows.length === 0) return resolve({ duplicate: false, match: null });

      let best = null;
      let bestDistance = HAMMING_THRESHOLD + 1;
      for (const row of rows) {
        const existingHash = hexToHash(row.media_hash);
        if (existingHash == null) continue;
        const distance = hammingDistance(hash, existingHash);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = row;
        }
      }
      if (best && bestDistance <= HAMMING_THRESHOLD) {
        resolve({ duplicate: true, match: { id: best.id, local_path: best.local_path, distance: bestDistance } });
      } else {
        resolve({ duplicate: false, match: null });
      }
    });
  });
}

/**
 * ディレクトリを再帰的に作成
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 保存先ディレクトリを取得 (username/YYYY-MM/)
 */
function getMediaDir(username, tweetDate) {
  const d = tweetDate ? new Date(tweetDate) : new Date();
  const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(MEDIA_BASE_DIR, username, yearMonth);
  ensureDir(dir);
  return dir;
}

/**
 * URLから拡張子を推測
 */
function getExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    // Twitter 画像は ?format=jpg&name=orig のパターンもある
    const formatMatch = url.match(/[?&]format=(\w+)/);
    if (formatMatch) return formatMatch[1];
    const ext = path.extname(pathname).replace('.', '').split('?')[0];
    return ext || 'jpg';
  } catch {
    return 'jpg';
  }
}

/**
 * 画像URLを最高画質に変換
 * pbs.twimg.com/media/xxx?format=jpg&name=small → name=orig
 */
function toOrigQuality(url) {
  if (!url) return url;
  // name=XXX を name=orig に置換
  if (url.includes('name=')) {
    return url.replace(/name=\w+/, 'name=orig');
  }
  // ?format がなければ :orig を付与
  if (url.includes('pbs.twimg.com/media/') && !url.includes('format=')) {
    return url + (url.includes('?') ? '&' : '?') + 'name=orig';
  }
  return url;
}

/**
 * HTTP(S)で画像をダウンロード
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, { timeout: 30000 }, (res) => {
      // リダイレクト対応
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          const stats = fs.statSync(destPath);
          resolve(stats.size);
        });
      });
      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Timeout downloading ${url}`));
    });
  });
}

/**
 * yt-dlp で動画をダウンロード
 * @returns {Promise<{filePath: string, fileSize: number}|null>}
 */
function downloadVideoWithYtdlp(tweetUrl, destDir, tweetId) {
  return new Promise((resolve) => {
    const outputTemplate = path.join(destDir, `${tweetId}_vid_%(autonumber)s.%(ext)s`);

    const args = [
      '--no-check-certificates',
      '--no-warnings',
      '-o', outputTemplate,
      '--no-playlist',
      '--format', 'best[ext=mp4]/best',
      '--socket-timeout', '30',
      '--retries', '3',
      tweetUrl
    ];

    console.log(`[TwitterMedia] yt-dlp 実行: ${tweetUrl}`);

    const proc = execFile(YTDLP_PATH, args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        // 動画がないツイートでは正常にエラーになるので warn レベル
        console.warn(`[TwitterMedia] yt-dlp エラー (${tweetId}):`, error.message);
        return resolve(null);
      }

      // ダウンロードされたファイルを探す
      try {
        const files = fs.readdirSync(destDir)
          .filter(f => f.startsWith(`${tweetId}_vid_`))
          .map(f => {
            const fullPath = path.join(destDir, f);
            const stats = fs.statSync(fullPath);
            return { filePath: fullPath, fileSize: stats.size, fileName: f };
          })
          .filter(f => f.fileSize > 0);

        if (files.length === 0) {
          console.log(`[TwitterMedia] yt-dlp: 動画ファイルなし (${tweetId})`);
          return resolve(null);
        }

        console.log(`[TwitterMedia] yt-dlp: ${files.length}件の動画をダウンロード (${tweetId})`);
        resolve(files);
      } catch (e) {
        console.warn(`[TwitterMedia] yt-dlp 後処理エラー:`, e.message);
        resolve(null);
      }
    });
  });
}

/**
 * DBにメディアレコードを挿入（重複はスキップ）
 */
function insertMediaRecord(tweet, username, mediaType, originalUrl, localPath, fileSize, mediaHash) {
  return new Promise((resolve) => {
    if (!_db) return resolve(false);

    _db.run(
      `INSERT OR IGNORE INTO twitter_media 
       (tweet_id, username, media_type, original_url, local_path, file_size, tweet_text, tweet_date, media_hash) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tweet.id,
        username,
        mediaType,
        originalUrl || '',
        localPath,
        fileSize || 0,
        (tweet.text || '').substring(0, 500),
        tweet.datetime || null,
        mediaHash ? hashToHex(mediaHash) : null
      ],
      function(err) {
        if (err) {
          console.error(`[TwitterMedia] DB挿入エラー (${tweet.id}):`, err.message);
          resolve(false);
        } else {
          resolve(this.changes > 0);
        }
      }
    );
  });
}

/**
 * このツイートのメディアが既にDB登録済みかチェック
 */
function isAlreadySaved(tweetId) {
  return new Promise((resolve) => {
    if (!_db) return resolve(false);
    _db.get(
      'SELECT COUNT(*) as cnt FROM twitter_media WHERE tweet_id = ?',
      [tweetId],
      (err, row) => {
        if (err) return resolve(false);
        resolve(row && row.cnt > 0);
      }
    );
  });
}

/**
 * 単一ツイートのメディアを保存
 */
async function saveMediaForTweet(tweet, username) {
  const tweetId = tweet.id;
  if (!tweetId) return;

  // 既に保存済みならスキップ
  const alreadySaved = await isAlreadySaved(tweetId);
  if (alreadySaved) {
    return;
  }

  const mediaDir = getMediaDir(username, tweet.datetime);
  let savedCount = 0;

  // 1. 画像のダウンロード
  const imageUrls = tweet.media_urls || [];
  for (let i = 0; i < imageUrls.length; i++) {
    const origUrl = toOrigQuality(imageUrls[i]);
    const ext = getExtFromUrl(origUrl);
    const fileName = `${tweetId}_img_${i}.${ext}`;
    const filePath = path.join(mediaDir, fileName);

    // 既にファイルがある場合スキップ
    if (fs.existsSync(filePath)) {
      console.log(`[TwitterMedia] スキップ（ファイル存在）: ${fileName}`);
      continue;
    }

    try {
      const fileSize = await downloadFile(origUrl, filePath);
      // 画像の知覚ハッシュを計算し、既存メディアと類似していないか判定
      const imgHash = await computeImageHash(filePath);
      if (imgHash != null) {
        const dupCheck = await isDuplicateImage(imgHash, username, tweetId);
        if (dupCheck.duplicate) {
          console.log(`[TwitterMedia] 重複画像のためスキップ: ${fileName} (類似度 ${dupCheck.match.distance}bit, 既存: ${path.basename(dupCheck.match.local_path)})`);
          try { fs.unlinkSync(filePath); } catch {}
          continue;
        }
      }
      const inserted = await insertMediaRecord(tweet, username, 'image', origUrl, filePath, fileSize, imgHash);
      if (inserted) {
        savedCount++;
        console.log(`[TwitterMedia] 画像保存: ${fileName} (${(fileSize / 1024).toFixed(1)}KB)`);
      }
    } catch (err) {
      console.error(`[TwitterMedia] 画像DLエラー (${tweetId}, ${i}):`, err.message);
      // 途中までダウンロードしたファイルを削除
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  // 2. 動画のダウンロード（yt-dlp）
  if (tweet.hasVideo) {
    const tweetUrl = `https://x.com/${username}/status/${tweetId}`;
    const videoFiles = await downloadVideoWithYtdlp(tweetUrl, mediaDir, tweetId);

    if (videoFiles && videoFiles.length > 0) {
      for (const vf of videoFiles) {
        const inserted = await insertMediaRecord(tweet, username, 'video', tweetUrl, vf.filePath, vf.fileSize);
        if (inserted) {
          savedCount++;
          console.log(`[TwitterMedia] 動画保存: ${vf.fileName} (${(vf.fileSize / 1024 / 1024).toFixed(1)}MB)`);
        }
      }
    }
  }

  if (savedCount > 0) {
    console.log(`[TwitterMedia] ✅ ツイート ${tweetId}: ${savedCount}件のメディアを保存`);
  }
}

/**
 * 複数ツイートのメディアを一括保存（リポスト除外）
 */
async function saveAllMedia(tweets, username) {
  if (!tweets || tweets.length === 0) return;
  if (!_db) {
    console.warn('[TwitterMedia] DB未初期化のためメディア保存をスキップ');
    return;
  }

  // ベースディレクトリの存在確認
  try {
    ensureDir(MEDIA_BASE_DIR);
  } catch (err) {
    console.error(`[TwitterMedia] ベースディレクトリ作成エラー (${MEDIA_BASE_DIR}):`, err.message);
    return;
  }

  for (const tweet of tweets) {
    // リポストは除外
    if (tweet.isRepost) continue;

    // メディアがないツイートはスキップ
    const hasImages = tweet.media_urls && tweet.media_urls.length > 0;
    const hasVideo = tweet.hasVideo;
    if (!hasImages && !hasVideo) continue;

    try {
      await saveMediaForTweet(tweet, username);
    } catch (err) {
      console.error(`[TwitterMedia] ツイート ${tweet.id} のメディア保存に失敗:`, err.message);
    }
  }
}

/**
 * メディア一覧をDBから取得（WebUI用）
 */
function getMediaList(username, limit = 50, offset = 0, callback) {
  if (!_db) return callback(new Error('DB not initialized'), []);

  _db.all(
    `SELECT id, tweet_id, username, media_type, original_url, local_path, file_size, tweet_text, tweet_date, created_at
     FROM twitter_media
     WHERE username = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [username, limit, offset],
    callback
  );
}

/**
 * メディア総数を取得（WebUI用）
 */
function getMediaCount(username, callback) {
  if (!_db) return callback(new Error('DB not initialized'), 0);

  _db.get(
    'SELECT COUNT(*) as total FROM twitter_media WHERE username = ?',
    [username],
    (err, row) => {
      callback(err, row ? row.total : 0);
    }
  );
}

/**
 * メディア統計を取得（WebUI用）
 */
function getMediaStats(username, callback) {
  if (!_db) return callback(new Error('DB not initialized'), null);

  _db.get(
    `SELECT 
       COUNT(*) as total,
       SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) as images,
       SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) as videos,
       SUM(file_size) as total_size
     FROM twitter_media
     WHERE username = ?`,
    [username],
    (err, row) => {
      callback(err, row || null);
    }
  );
}

module.exports = {
  initMediaDb,
  saveAllMedia,
  saveMediaForTweet,
  getMediaList,
  getMediaCount,
  getMediaStats,
  MEDIA_BASE_DIR
};
