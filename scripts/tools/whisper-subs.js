// whisper-subs.js - ASMR/コラボ配信の字幕を Groq Whisper で生成し video_whisper_segments に保存
//
// 使い方:
//   node scripts/tools/whisper-subs.js --vids "id1 id2" [--audio-dir /tmp/...] [--compare-only]
//   node scripts/tools/whisper-subs.js --audio /path/to/audio.mp3 --id <video_id> [--title "..."]
//   node scripts/tools/whisper-subs.js --recent 10            # .70カタログからASMR/コラボを検出して未処理分を実行
//   node scripts/tools/whisper-subs.js --compare <video_id>   # YT字幕との比較レポートのみ
//
// 前提:
//   - GROQ_API_KEY (.env): Groq Whisper (whisper-large-v3-turbo) 用
//   - yt-dlp / ffmpeg が PATH にあること（サーバーIPがYTにブロックされる場合は
//     YTDLP_COOKIES_FILE にブラウザからエクスポートした cookies.txt を指定）
//   - 話者分離 (speaker列) は未実装。コラボ本採用時に pyannote 等の方式確定後に埋める。
require("dotenv").config({ path: "/var/www/html/koinoyamai.love/.env" });
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const DB_PATH = process.env.RAG_DB_PATH || path.join(__dirname, "../..", "data.db");
const ARCHIVE_API_BASE = (process.env.ARCHIVE_API_BASE || "http://192.168.1.70:8766").replace(/\/+$/, "");
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const COOKIES = process.env.YTDLP_COOKIES_FILE || "";
const CHUNK_SEC = parseInt(process.env.WHISPER_CHUNK_SEC || "600", 10); // 10分/chunk (25MB制限対策)
const WORK_DIR = process.env.WHISPER_WORK_DIR || path.join(os.tmpdir(), "whisper-subs");
const aiQuota = require(path.join(__dirname, "../..", "services", "ai-quota"));

// curl -D で吐いたヘッダファイルを Response 相当に変換する（status 行 + ヘッダ行）。
// リダイレクトでブロックが積むため、末尾ブロックだけを採用する。
function readCurlHeaders(hdrFile) {
  try {
    const raw = fs.readFileSync(hdrFile, "utf8");
    const block = raw.split(/\r?\n\r?\n/).filter(s => s.trim()).pop() || raw;
    const lines = block.split(/\r?\n/);
    const statusLine = lines.find(l => /^HTTP\/\S+\s+\d{3}/.test(l));
    const status = statusLine ? parseInt((statusLine.match(/(\d{3})\s*$/) || [])[1], 10) : 0;
    const headers = new Map();
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
    return { status, headers };
  } catch (e) {
    return null;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${(stderr || err.message).slice(0, 500)}`));
      resolve(stdout);
    });
  });
}

const dbOpen = () => new Promise((res, rej) => {
  const db = new sqlite3.Database(DB_PATH, (e) => (e ? rej(e) : res(db)));
});
const dbRun = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const dbGet = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r || null))));
const dbAll = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));

async function ensureTables(db) {
  await dbRun(db, `CREATE TABLE IF NOT EXISTS video_whisper_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    speaker TEXT,
    model TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_whisper_video_id ON video_whisper_segments (video_id)`);
}

// --- ASMR/コラボ判定 (.70カタログ) ---
async function fetchVideoRecord(videoId) {
  const res = await fetch(`${ARCHIVE_API_BASE}/api/videos?q=${encodeURIComponent(videoId)}&limit=20`);
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const j = await res.json();
  return (j.videos || []).find((v) => v.video_id === videoId) || null;
}
function detectKind(record, title = "") {
  const t = `${record?.title || ""} ${title}`;
  const cats = Array.isArray(record?.categories) ? record.categories : [];
  const collab = Array.isArray(record?.collaborators) ? record.collaborators : [];
  if (collab.length > 0 || /collab|コラボ/i.test(t) || cats.some((c) => /コラボ|collab/i.test(c))) return "collab";
  if (cats.some((c) => /asmr/i.test(c)) || /【[^】]*asmr[^】]*】/i.test(t)) return "asmr";
  return "other";
}

// --- 音声取得 ---
async function downloadAudio(videoId, outDir) {
  const outTpl = path.join(outDir, `${videoId}.%(ext)s`);
  const args = ["-4", "-f", "bestaudio", "-x", "--audio-format", "mp3", "--audio-quality", "48k",
    "--no-playlist", "-o", outTpl];
  if (COOKIES) args.push("--cookies", COOKIES);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  console.log(`[dl] yt-dlp ${videoId}`);
  await sh(YTDLP, args);
  const mp3 = path.join(outDir, `${videoId}.mp3`);
  if (!fs.existsSync(mp3)) throw new Error("mp3 not produced (blocked? set YTDLP_COOKIES_FILE)");
  return mp3;
}

// --- チャンク分割 (10分ずつmp3再エンコード) ---
async function splitAudio(mp3, outDir, videoId) {
  const pat = path.join(outDir, `${videoId}-chunk-%03d.mp3`);
  await sh("ffmpeg", ["-y", "-v", "error", "-i", mp3, "-ar", "16000", "-ac", "1", "-b:a", "32k",
    "-f", "segment", "-segment_time", String(CHUNK_SEC), "-reset_timestamps", "1", pat]);
  return fs.readdirSync(outDir)
    .filter((f) => f.startsWith(`${videoId}-chunk-`) && f.endsWith(".mp3"))
    .sort()
    .map((f) => path.join(outDir, f));
}

// --- Groq Whisper (curl multipart; キーはログに出さない) ---
// 429 (ASPH等のレート制限) は "try again in XmYs" をパースして待機し、回数消費なしでリトライ
function parseRetryAfter(msg) {
  let m = /try again in ([\d.]+)m([\d.]+)s/i.exec(msg || "");
  if (m) return (parseFloat(m[1]) * 60 + parseFloat(m[2])) * 1000;
  m = /try again in ([\d.]+)s/i.exec(msg || "");
  if (m) return parseFloat(m[1]) * 1000;
  return 0;
}
async function transcribeChunk(mp3Path) {
  const hdrFile = path.join(os.tmpdir(), `groq-whisper-${process.pid}-${Date.now()}.hdr`);
  const args = ["-s", "-X", "POST", "https://api.groq.com/openai/v1/audio/transcriptions",
    "-H", "Authorization: Bearer " + GROQ_API_KEY,
    "-D", hdrFile,
    "-F", `file=@${mp3Path}`,
    "-F", `model=${GROQ_MODEL}`,
    "-F", "language=ja",
    "-F", "response_format=verbose_json",
    "-F", "temperature=0"];
  let fails = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const out = await sh("curl", args, { timeout: 300000 });
      const res = readCurlHeaders(hdrFile);
      const j = JSON.parse(out);
      if (j.error) {
        const msg = j.error.message || JSON.stringify(j.error).slice(0, 200);
        aiQuota.record("groq", res, null, { kind: "whisper", model: GROQ_MODEL, error: msg });
        const wait = parseRetryAfter(msg);
        if (/rate.?limit|429|try again/i.test(msg) && wait > 0 && wait < 45 * 60 * 1000) {
          console.log(`  rate limited, waiting ${(wait / 1000).toFixed(0)}s+margin...`);
          await sleepMs(wait + 30000);
          continue; // 回数消費なし
        }
        throw new Error(msg);
      }
      aiQuota.record("groq", res, j, { kind: "whisper", model: GROQ_MODEL });
      try { fs.unlinkSync(hdrFile); } catch (_) {}
      return j;
    } catch (e) {
      if (/rate.?limit|try again/i.test(e.message)) {
        const wait = parseRetryAfter(e.message) || 60000;
        console.log(`  rate limited, waiting ${(Math.min(wait, 20 * 60 * 1000) / 1000).toFixed(0)}s...`);
        await sleepMs(Math.min(wait + 30000, 20 * 60 * 1000));
        continue;
      }
      if (++fails >= 3) throw new Error("transcribe failed after 3 attempts: " + e.message);
      console.warn(`  chunk retry ${fails}: ${e.message}`);
      await sleepMs(5000 * fails);
    }
  }
  throw new Error("transcribe failed (rate limit retries exhausted)");
}

// --- 1本処理 ---
async function processVideo(db, videoId, opts = {}) {
  const workDir = fs.mkdtempSync(path.join(WORK_DIR, videoId + "-"));
  try {
    let record = null;
    try { record = await fetchVideoRecord(videoId); } catch (e) { console.warn(`[catalog] ${e.message}`); }
    const kind = opts.kind || detectKind(record);
    console.log(`=== ${videoId} kind=${kind} title=${(record?.title || opts.title || "").slice(0, 50)}`);
    if (!opts.force && kind !== "asmr" && kind !== "collab") {
      console.log(`skip (not asmr/collab)`);
      return { skipped: true };
    }
    const done = await dbGet(db, "SELECT COUNT(*) n FROM video_whisper_segments WHERE video_id=?", [videoId]);
    // 全体スキップはしない（チャンク単位で冪等にスキップするため）。
    // 完全に処理済みでも各チャンクの skip ログだけ出て高速に終わる。
    if (done && done.n > 0) console.log(`[resume] have ${done.n} segments`);
    let mp3 = opts.audio || null;
    if (!mp3) mp3 = await downloadAudio(videoId, workDir);
    const chunks = await splitAudio(mp3, workDir, videoId);
    console.log(`[split] ${chunks.length} chunks`);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const offsetMs = i * CHUNK_SEC * 1000;
      const endMs = offsetMs + CHUNK_SEC * 1000;
      // チャンク単位の冪等性: 既存があればスキップ (--reset 時のみ再生成)
      const have = await dbGet(db,
        "SELECT COUNT(*) n FROM video_whisper_segments WHERE video_id=? AND start_ms>=? AND start_ms<?",
        [videoId, offsetMs, endMs]);
      if (have && have.n > 0 && !opts.reset) {
        total += have.n;
        console.log(`  [${i + 1}/${chunks.length}] skip (have ${have.n})`);
        continue;
      }
      const j = await transcribeChunk(chunks[i]);
      const segs = Array.isArray(j.segments) ? j.segments : [];
      await dbRun(db,
        "DELETE FROM video_whisper_segments WHERE video_id=? AND start_ms>=? AND start_ms<?",
        [videoId, offsetMs, endMs]);
      for (const s of segs) {
        const text = String(s.text || "").trim();
        if (!text) continue;
        await dbRun(db,
          `INSERT INTO video_whisper_segments (video_id, start_ms, end_ms, text, speaker, model)
           VALUES (?,?,?,?,?,?)`,
          [videoId, Math.round(offsetMs + (s.start || 0) * 1000), Math.round(offsetMs + (s.end || 0) * 1000),
            text, null, GROQ_MODEL]);
        total++;
      }
      console.log(`  [${i + 1}/${chunks.length}] segs=${segs.length}`);
      await sleepMs(1000);
    }
    console.log(`done: ${videoId} segments=${total}`);
    return { segments: total, kind };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// --- YT字幕との比較レポート ---
async function compareReport(db, videoId) {
  const wsp = await dbAll(db,
    "SELECT start_ms, end_ms, text FROM video_whisper_segments WHERE video_id=? ORDER BY start_ms", [videoId]);
  const res = await fetch(`${ARCHIVE_API_BASE}/api/transcript/${videoId}`, { timeout: 30000 });
  if (!res.ok) throw new Error(`YT transcript ${res.status}`);
  const yt = await res.json();
  const ysegs = (yt.segments || []).filter((s) => s && s.text && s.text.trim());
  const wchars = wsp.reduce((a, s) => a + s.text.length, 0);
  const ychars = ysegs.reduce((a, s) => a + String(s.text).length, 0);
  const wdur = wsp.length ? wsp[wsp.length - 1].end_ms - wsp[0].start_ms : 0;
  const ydur = ysegs.length ? (ysegs[ysegs.length - 1].end_ms || 0) - (ysegs[0].start_ms || 0) : 0;
  console.log(`\n### compare ${videoId}`);
  console.log(`whisper: segs=${wsp.length} chars=${wchars} span_min=${(wdur / 60000).toFixed(1)}`);
  console.log(`yt     : segs=${ysegs.length} chars=${ychars} span_min=${(ydur / 60000).toFixed(1)}`);
  console.log(`\n--- sample (whisper | yt, 5箇所) ---`);
  const marks = [0.05, 0.25, 0.5, 0.75, 0.95];
  for (const m of marks) {
    const t = wdur * m;
    const w = wsp.find((s) => s.start_ms >= t) || wsp[wsp.length - 1];
    const y = ysegs.find((s) => (s.start_ms || 0) >= t) || ysegs[ysegs.length - 1];
    const ts = (ms) => `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
    console.log(`[W ${w ? ts(w.start_ms) : "-"}] ${w ? w.text.slice(0, 80) : "(none)"}`);
    console.log(`[Y ${y ? ts(y.start_ms || 0) : "-"}] ${y ? String(y.text).slice(0, 80) : "(none)"}`);
  }
}

function parseArgs(argv) {
  const a = { vids: [], audio: null, id: null, title: "", recent: null, compare: null, force: false, reset: false, kind: null, compareOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--vids") a.vids = String(argv[++i] || "").trim().split(/\s+/).filter(Boolean);
    else if (t === "--audio") a.audio = argv[++i];
    else if (t === "--id") a.id = argv[++i];
    else if (t === "--title") a.title = argv[++i];
    else if (t === "--recent") a.recent = parseInt(argv[++i], 10);
    else if (t === "--compare") a.compare = argv[++i];
    else if (t === "--compare-only") a.compareOnly = true;
    else if (t === "--force") a.force = true;
    else if (t === "--reset") a.reset = true;
    else if (t === "--kind") a.kind = argv[++i];
    else a.vids.push(t);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!GROQ_API_KEY && !args.compare) { console.error("GROQ_API_KEY required"); process.exit(1); }
  fs.mkdirSync(WORK_DIR, { recursive: true });
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
  catch { console.error("ffmpeg not found"); process.exit(1); }
  const db = await dbOpen();
  await ensureTables(db);

  if (args.compare) {
    await compareReport(db, args.compare);
    db.close();
    return;
  }

  let targets = [];
  if (args.audio && args.id) {
    targets = [{ video_id: args.id, audio: args.audio, title: args.title, kind: args.kind }];
  } else if (args.recent) {
    const list = await fetch(`${ARCHIVE_API_BASE}/api/videos?limit=100&sort=stream_at_desc`).then((r) => r.json());
    const doneRows = await dbAll(db, "SELECT DISTINCT video_id FROM video_whisper_segments", []);
    const done = new Set(doneRows.map((r) => r.video_id));
    for (const v of list.videos || []) {
      if (done.has(v.video_id)) continue;
      const kind = detectKind(v);
      if (kind === "asmr" || kind === "collab") {
        targets.push({ video_id: v.video_id, title: v.title, kind });
        if (targets.length >= args.recent) break;
      }
    }
  } else {
    targets = args.vids.map((id) => ({ video_id: id }));
  }
  console.log(`targets: ${targets.length}`);
  for (const t of targets) {
    try {
      const r = await processVideo(db, t.video_id, t);
      if (!r.skipped && !args.compareOnly) await compareReport(db, t.video_id).catch((e) => console.warn("[compare]", e.message));
    } catch (e) { console.error(`FAIL ${t.video_id}: ${e.message}`); }
  }
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
