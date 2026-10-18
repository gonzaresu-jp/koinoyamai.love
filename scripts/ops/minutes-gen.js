// minutes-gen.js - 配信字幕から要約を生成し、video_minutes テーブルへ保存
// 使い方:
//   node scripts/ops/minutes-gen.js --vids "Id1 Id2 ..."
//   node scripts/ops/minutes-gen.js --recent 20
//   node scripts/ops/minutes-gen.js --recent 20 --embed   # 生成後に埋め込み→Pi upsert まで実行
//   node scripts/ops/minutes-gen.js --file list.txt --embed
// 進捗: video_minutes に video_id が存在すればスキップ（--reset で再生成）
// path は dotenv より前に require する（固定パスだと staging が本番 .env を読む事故のため）
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../..", ".env") });
const fetch = require("node-fetch");
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3");
const aiQuota = require(path.join(__dirname, "../..", "services", "ai-quota"));

const DB_PATH = process.env.RAG_DB_PATH || path.join(__dirname, "../..", "data.db");
const ARCHIVE_API_BASE = process.env.ARCHIVE_API_BASE || "http://192.168.1.70:8766";
const API_URL = process.env.MINUTES_API_URL || process.env.GEMINI_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const API_KEY = process.env.MINUTES_API_KEY || process.env.GEMINI_API_KEY || "";
const MODEL = process.env.MINUTES_MODEL || "gemini-3.5-flash-lite";
// --- Groq 予備経路（OpenAI互換chat。CF日次予算を使い切ったら自動でこちらへ切り替える）---
const GROQ_API_URL = process.env.MINUTES_GROQ_URL || "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.MINUTES_GROQ_MODEL || "qwen/qwen3.8-27b";
let provider = "cloudflare"; // 現在の要約生成経路（ensureNeurons が切り替える）
function activeCfg() {
  if (provider === "groq") return { name: "groq", url: GROQ_API_URL, key: GROQ_API_KEY, model: GROQ_MODEL };
  return { name: "cloudflare", url: API_URL, key: API_KEY, model: MODEL };
}
const CHUNK_MS = 300 * 1000; // 5分チャンク
const CONCURRENCY = 1; // API 呼び出しの並列数（レート制限対策で1）
const MAX_RETRY = 3;
const NO_TRANSCRIPT_RECHECK_DAYS = parseInt(process.env.MINUTES_NO_TRANSCRIPT_RECHECK_DAYS || "3", 10);
const PACE_MS = parseInt(process.env.MINUTES_PACE_MS || "60000", 10); // 成功後のインターバル（Groq無料枠のOTPM 1000/分を踏まえた既定値）
const MAX_TOKENS = parseInt(process.env.MINUTES_MAX_TOKENS || "900", 10); // 1回の出力が毎分枠(OTPM 1000)を超えない既定値
// レート制限ヘッダ(retry-after / x-ratelimit-reset-*)を待機msへ変換する
function parseRetryAfterMs(headers) {
  const raw =
    headers.get("retry-after") ||
    headers.get("x-ratelimit-reset-tokens") ||
    headers.get("x-ratelimit-reset-requests");
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(Math.round(parseFloat(s) * 1000), 120000);
  // Groq形式 "2h8m9.599s" / "3.179s"
  let ms = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let m;
  while ((m = re.exec(s))) {
    matched = true;
    const v = parseFloat(m[1]);
    ms += m[2] === "h" ? v * 3600000 : m[2] === "m" ? v * 60000 : v * 1000;
  }
  if (!matched) return null;
  return Math.min(Math.round(ms), 120000);
}

// --- Cloudflare Workers AI 日次無料枠(Neurons)管理 ----------------------------------
// Workers AI は USD $0.011 / 1,000 neurons、無料枠は 10,000 neurons/日 (UTC 00:00 リセット)。
// 使い切ったら Groq 予備経路へ自動切替（Groqキー未設定なら従来どおり翌日まで待機）。
// --force-free-tier で無料枠を無視する。
const NEURON_BUDGET = Math.min(
  parseFloat(process.env.CF_NEURON_BUDGET || "9500"), // 既定: 無料枠10,000のうち安全マージン込み
  10000
);
const NEURON_STATE_FILE = path.join(__dirname, "../..", "tmp", "minutes_neurons_state.json");
const NEURON_STATE_DAY = () => new Date().toISOString().slice(0, 10); // UTC日付
let neuronState = { day: NEURON_STATE_DAY(), used: 0 };
function loadNeuronState() {
  try {
    const raw = fs.readFileSync(NEURON_STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (s.day === NEURON_STATE_DAY()) return s;
    return { day: NEURON_STATE_DAY(), used: 0 };
  } catch {
    return { day: NEURON_STATE_DAY(), used: 0 };
  }
}
function saveNeuronState() {
  try {
    fs.mkdirSync(path.dirname(NEURON_STATE_FILE), { recursive: true });
    fs.writeFileSync(NEURON_STATE_FILE, JSON.stringify(neuronState), "utf8");
  } catch (e) { /* 状態保存はベストエフォート */ }
}
function neuronsLeft() {
  const left = NEURON_BUDGET - neuronState.used;
  return Math.max(0, left);
}
async function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}
async function waitUntilNextUtcDay() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  next.setUTCMinutes(0, 15, 0);
  let waitMs = next.getTime() - now.getTime();
  if (waitMs <= 0) waitMs = 60 * 60 * 1000;
  console.log(`\n[neurons] 日次無料枠を使い切りました (used=${neuronState.used.toFixed(0)}/${NEURON_BUDGET})。`);
  console.log(`[neurons] リセット(UTC 00:15 ≒ JST 09:15)まで ${fmtDuration(waitMs)} 待機します。停止するなら Ctrl+C。`);
  await sleepMs(waitMs);
  neuronState = loadNeuronState();
}
async function ensureNeurons() {
  // UTC 日跨ぎで in-memory 使用量を更新し、CF 予算が翌日復活したら CF に戻す
  if (neuronState.day !== NEURON_STATE_DAY()) neuronState = loadNeuronState();
  if (neuronsLeft() > 0) {
    if (provider !== "cloudflare") {
      provider = "cloudflare";
      console.log(`[provider] Cloudflare 予算が利用可能 → CF に戻す (model=${MODEL})`);
    }
    return;
  }
  if (GROQ_API_KEY) {
    if (provider !== "groq") {
      provider = "groq";
      console.log(`[provider] CF 日次予算切れ → Groq 予備経路に切替 (model=${GROQ_MODEL})`);
    }
    return;
  }
  await waitUntilNextUtcDay();
}

function fmtJst(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function getTranscript(videoId) {
  const res = await fetch(`${ARCHIVE_API_BASE}/api/transcript/${videoId}`, { timeout: 30000 });
  if (!res.ok) throw new Error(`transcript ${res.status}`);
  return await res.json();
}

function chunkSegments(segments, chunkMs) {
  const chunks = [];
  let cur = null;
  for (const s of segments) {
    if (!s || !s.text || !s.text.trim()) continue;
    const start = s.start_ms, end = s.end_ms || start;
    if (!cur || start - cur.start >= chunkMs) {
      cur = { start, end, segs: [] };
      chunks.push(cur);
    } else {
      cur.end = Math.max(cur.end, end);
    }
    cur.segs.push(s);
  }
  return chunks;
}

async function summarize(chunk) {
  const text = chunk.segs.map(s => `${fmtJst(s.start_ms)} ${s.text.trim()}`).join("\n");
  const messages = [
    {
      role: "system",
      content:
        "あなたは配信の文字起こしから「章立ての要約」を作るアシスタントです。与えられた字幕区間から、" +
        "まいちゃん(恋乃夜まい)が話した話題・明言した事実（好きなもの、エピソード、意見、予定、人間関係などの具体的な名前・固有名詞は省略しない）を抽出します。" +
        "自動字幕なので誤字・誤認識が含まれますが、文脈から意味を推測して要点をまとめてください。" +
        "字幕は複数の話題が混ざるので、話題ごとに別の要素に分割してください。字幕に含まれない要素は一切でっち上げないでください。\n" +
        "出力は次のJSONオブジェクトを1つだけ。Markdownのコードブロックや余計な説明は禁止です。\n" +
        '形式: {"section": "この区間全体の見出し(15字以内)", "items": [{"ts": "HH:MM:SS", "topic": "話題タイトル(15字以内)", "facts": ["事実1", "事実2", ...]または[], "detail": "この話題の1〜3文の要約"}]}\n' +
        "- ts はその話題が始まる字幕行の時刻。必ず入力に含まれる時刻と完全一致させる（推測・丸め・区間外の時刻は禁止）。\n" +
        "- items は ts の昇順。区間内に複数の話題があれば、それぞれを独立した items として漏らさず全部出す。",
    },
    { role: "user", content: `区間字幕（各行頭は先頭の [HH:MM:SS] 開始時刻）:\n${text}` },
  ];
  let lastErr;
  for (let i = 0; i < MAX_RETRY; i++) {
    let res = null;
    const cfg = activeCfg(); // リトライ毎に再評価（ensureNeurons が経路を切り替えている場合がある）
    try {
      res = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, max_tokens: MAX_TOKENS }),
        timeout: 90000,
      });
      if (!res.ok) {
        const bodyTxt = await res.text();
        aiQuota.record(cfg.name, res, null, { kind: "minutes", model: cfg.model, error: `api ${res.status}` });
        const err = new Error(`api ${res.status}: ${bodyTxt.slice(0, 300)}`);
        if (res.status === 429) {
          // Cloudflare の日次 neurons 枯渇は即察知して状態へ反映（ensureNeurons が即 Groq へ切替できるように）
          if (/daily free allocation|used up your daily/i.test(bodyTxt)) {
            err.cfDailyExhausted = true;
            neuronState = { day: NEURON_STATE_DAY(), used: NEURON_BUDGET };
            saveNeuronState();
            console.error("[neurons] CF APIが日次枯渇を返しました → 状態を満杯に更新 (以降 Groq へ切替)");
          }
          err.retryAfterMs = parseRetryAfterMs(res.headers);
        }
        throw err;
      }
      const data = await res.json();
      aiQuota.record(cfg.name, res, data, { kind: "minutes", model: cfg.model });
      // Cloudflare Workers AI は usage.neurons に実消費量を返す（Groq には無い）
      if (data?.usage?.neurons != null) {
        neuronState.used = Math.min(NEURON_BUDGET, neuronState.used + data.usage.neurons);
        saveNeuronState();
        console.log(`[neurons] +${data.usage.neurons.toFixed(1)} (残 ${neuronsLeft().toFixed(0)})`);
      }
      const out = (data.choices?.[0]?.message?.content || "").trim();
      const cleaned = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      return JSON.parse(cleaned);
    } catch (e) {
      lastErr = e;
      if (!res) aiQuota.record(cfg.name, null, null, { kind: "minutes", model: cfg.model, error: e.message });
      if (e.cfDailyExhausted) break; // リトライせず即終了 → 呼び出し側が経路を切り替える
      const is429 = /api 429|rate.?limit/i.test(e.message);
      if (is429) {
        // 毎分レート制限はヘッダの指示を尊重、無ければ指数バックオフ（20/40/80秒＋ジッター）
        const wait = e.retryAfterMs || Math.min(20000 * Math.pow(2, i), 80000);
        await sleepMs(wait + Math.floor(Math.random() * 3000));
      } else {
        await sleepMs(2000 * (i + 1));
      }
    }
  }
  const finalErr = new Error(`summarize failed: ${lastErr?.message || lastErr}`);
  if (lastErr) {
    finalErr.retryAfterMs = lastErr.retryAfterMs;
    finalErr.cfDailyExhausted = lastErr.cfDailyExhausted;
  }
  throw finalErr;
}

// モデルが出した ts（"HH:MM:SS" / 秒数 / ms）をチャンク内 ms へ。不正・範囲外は寄せる。
function parseTs(ts, chunk) {
  let ms = null;
  if (typeof ts === "number" && isFinite(ts)) {
    if (ts >= chunk.start && ts <= chunk.end) ms = ts;
    else if (ts * 1000 >= chunk.start && ts * 1000 <= chunk.end) ms = ts * 1000;
  } else {
    const s = String(ts == null ? "" : ts).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      ms = m[3] !== undefined
        ? ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000
        : ((+m[1]) * 60 + (+m[2])) * 1000;
    }
  }
  if (ms == null || !isFinite(ms)) return chunk.start;
  return Math.min(Math.max(ms, chunk.start), chunk.end);
}

// モデル出力（新形式 {section, items} / 旧形式配列どちらでも動く）を正規化する
function normalizeResult(parsed, chunk) {
  let section = "";
  let raw = [];
  if (Array.isArray(parsed)) raw = parsed; // 旧形式（section 無し・ts 無し）
  else if (parsed && typeof parsed === "object") {
    if (typeof parsed.section === "string") section = parsed.section.trim().slice(0, 24);
    if (Array.isArray(parsed.items)) raw = parsed.items;
  }
  const items = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const facts = (Array.isArray(it.facts) ? it.facts : []).filter(Boolean).map(f => String(f).trim()).filter(Boolean);
    const item = {
      start_ms: parseTs(it.ts, chunk),
      topic: String(it.topic || "").trim(),
      detail: String(it.detail || "").trim(),
      facts,
    };
    if (!item.topic && !item.detail && !item.facts.length) continue;
    items.push(item);
  }
  items.sort((a, b) => a.start_ms - b.start_ms);
  if (!items.length) {
    items.push({ start_ms: chunk.start, topic: "", detail: "", facts: [] });
  }
  return { section, items };
}

// 1チャンク分の items を全件書き込む（start_ms=話題の実開始、end_ms=次の話題開始）
// 重複キーは (chunk_start_ms, topic)。旧実装は start_ms 単一で判定していたため
// 同一チャンクの2件目以降が捨てられていた。
async function insertItems(db, { videoId, chunk, section, items, title, streamDateJst, url }) {
  let inserted = 0;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    let end = chunk.end;
    for (let j = k + 1; j < items.length; j++) {
      if (items[j].start_ms > it.start_ms) { end = items[j].start_ms; break; }
    }
    const dup = await dbGet(db,
      "SELECT 1 FROM video_minutes WHERE video_id=? AND chunk_start_ms=? AND topic=?",
      [videoId, chunk.start, it.topic]);
    if (dup) continue;
    await dbRun(db,
      `INSERT INTO video_minutes (video_id, start_ms, end_ms, topic, summary, facts,
        title, stream_date_jst, url, section, chunk_start_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [videoId, it.start_ms, Math.max(end, it.start_ms), it.topic, it.detail,
       JSON.stringify(it.facts), title, streamDateJst, url,
       section || null, chunk.start]);
    inserted++;
  }
  return inserted;
}

// video_minutes のスキーマ保証（冪等）。旧形式行は chunk_start_ms=start_ms で後付けする
//（旧実装は start_ms がそのまま5分チャンク先頭だったため）。
async function ensureSchema(db) {
  await dbRun(db, `CREATE TABLE IF NOT EXISTS video_minutes (
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
  )`);
  await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_video_minutes_video_id ON video_minutes (video_id)`);
  // 完了マーカー。video_minutes に1行でもある＝完了ではない（途中クラッシュの部分完了が
  // 残るため、行の有無で done 判定すると部分完了動画が永遠に再処理対象から外れてしまう）。
  // 全チャンク処理を終えた時点で記録し、次回はマーカーのみで skip する。
  await dbRun(db, `CREATE TABLE IF NOT EXISTS video_minutes_done (
    video_id TEXT PRIMARY KEY,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const cols = await dbAll(db, `PRAGMA table_info(video_minutes)`);
  const names = new Set(cols.map(c => c.name));
  if (!names.has("topic")) await dbRun(db, `ALTER TABLE video_minutes ADD COLUMN topic TEXT`);
  if (!names.has("section")) await dbRun(db, `ALTER TABLE video_minutes ADD COLUMN section TEXT`);
  if (!names.has("chunk_start_ms")) await dbRun(db, `ALTER TABLE video_minutes ADD COLUMN chunk_start_ms INTEGER`);
  await dbRun(db,
    `UPDATE video_minutes SET chunk_start_ms = start_ms WHERE chunk_start_ms IS NULL AND section IS NULL`);
}

function dbOpen() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, err => (err ? reject(err) : resolve(db)));
  });
}
const dbRun = (db, sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbGet = (db, sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, r) => (e ? rej(e) : res(r || null))));
const dbAll = (db, sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r || []))));

function parseArgs(argv) {
  const args = { vids: [], recent: null, file: null, embed: false, reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--recent") args.recent = parseInt(argv[++i], 10);
    else if (a === "--vids") args.vids = String(argv[++i] || "").trim().split(/\s+/).filter(Boolean);
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--embed") args.embed = true;
    else if (a === "--reset") args.reset = true;
    else args.vids.push(a);
  }
  return args;
}

async function resolveVideos(db, args) {
  if (args.recent) {
    // 字幕持ち・雑談/マシュマロ系を stream_at 降順で指定数。
    // archive /api/videos は limit 最大100のため offset ページングで全件を走査する
    //（2026-10-01 修正: limit=100 固定だと最新100本しか見ず、それより古い未要約
    //  バックログ341本が永久に放置されていた）。
    const rows = await dbAll(db,
      `SELECT video_id FROM video_minutes_done`, []);
    const done = new Set(rows.map(r => r.video_id));
    const out = [];
    let offset = 0;
    for (;;) {
      // include_deleted=1 で「YTから削除された動画」も要約生成の対象にする（AIのみ利用）
      const list = await fetch(`${ARCHIVE_API_BASE}/api/videos?limit=100&offset=${offset}&sort=stream_at_desc&include_deleted=1`).then(r => r.json()).catch(() => null);
      if (!list || !Array.isArray(list.videos)) throw new Error("archive /api/videos failed");
      const page = list.videos;
      for (const v of page) {
        if (done.has(v.video_id)) continue;
        // v_catalog には caption 有無の列が無いため、タイトルで候補を絞る。
        // 字幕が無い動画は getTranscript が 404 を返すので呼び出し側で skip される。
        // コラボ相手チャンネルの動画はタイトルにコラボ相手の固有名詞が出てきても
        // まい向けの語彙（雑談・晩酌等）が無いので、カテゴリ・コラボ相手・タイトルの
        // いずれかにコラボシグナルがあれば対象にする。
        const isCollab = (Array.isArray(v.categories) && v.categories.includes('コラボ'))
          || (Array.isArray(v.collaborators) && v.collaborators.length > 0)
          || /コラボ|collab/i.test(v.title || "");
        if (!isCollab && !/(雑談|マシュマロ|相談|晩酌|ごごまい|ASMR)/.test(v.title || "")) continue;
        out.push(v);
        if (out.length >= args.recent) return out;
      }
      if (page.length === 0) break;
      offset += page.length;
      if (list.total != null && offset >= list.total) break;
    }
    return out;
  }
  if (args.file) {
    const fs = require("fs");
    const txt = fs.readFileSync(args.file, "utf8");
    return txt.trim().split(/\s+/).map(id => ({ video_id: id }));
  }
  return args.vids.map(id => ({ video_id: id }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!API_KEY) { console.error("API key required (MINUTES_API_KEY or GEMINI_API_KEY)"); process.exit(1); }
  // 日次予算は実行ごとではなく UTC 日ごとに積み上げる。起動時に既存の使用量を読み込み、
  // 読めなかった場合・UTC 日が変わっている場合のみ 0 から始める（loadNeuronState の仕様）。
  neuronState = loadNeuronState();
  console.log(`[neurons] 起動時: day=${neuronState.day} used=${neuronState.used.toFixed(1)} 残=${neuronsLeft().toFixed(1)}`);
  // UTC 日が変わったリセット値(used=0)を起動時に永続化する。
  // 保存しないと、その日 Workers AI を呼ばない間 status API が古い日付の値を
  // stale 付きで出し続ける（2026-10-01 確認: 9/28 の値が3日間そのまま表示されていた）。
  saveNeuronState();
  const db = await dbOpen();
  await ensureSchema(db);
  // 字幕が無い(404)動画を記録し、NO_TRANSCRIPT_RECHECK_DAYS 日は再確認しない。
  // whisper が字幕を作れば、再確認時に 200 が返って自動的に生成対象へ戻る。
  await dbRun(db, `CREATE TABLE IF NOT EXISTS minutes_no_transcript (
    video_id TEXT PRIMARY KEY,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const targets = await resolveVideos(db, args);
  console.log(`targets: ${targets.length}`);
  for (const t of targets) console.log(" -", t.video_id, "|", t.title || "");

  let totalChunks = 0, totalItems = 0, skipped = 0;
  for (const t of targets) {
    const videoId = t.video_id;
    const noTr = await dbGet(db,
      `SELECT checked_at FROM minutes_no_transcript WHERE video_id=? AND checked_at > datetime('now', ?)`,
      [videoId, `-${NO_TRANSCRIPT_RECHECK_DAYS} days`]);
    if (noTr) { skipped++; continue; }
    let tr;
    try { tr = await getTranscript(videoId); } catch (e) {
      if (/transcript 404/.test(e.message)) {
        await dbRun(db, `INSERT OR REPLACE INTO minutes_no_transcript (video_id, checked_at) VALUES (?, CURRENT_TIMESTAMP)`, [videoId]);
        console.log(`skip (no transcript yet): ${videoId} — ${NO_TRANSCRIPT_RECHECK_DAYS}日後に再確認`);
      } else {
        console.error(`getTranscript fail ${videoId}:`, e.message);
      }
      continue;
    }
    await dbRun(db, `DELETE FROM minutes_no_transcript WHERE video_id=?`, [videoId]);
    const meta = tr.meta || {};
    const title = t.title || meta.title || "";
    const streamAt = meta.stream_at || "";
    const streamDateJst = streamAt ? streamAt.slice(0, 10) : (meta.stream_date_jst || "");
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    const chunks = chunkSegments(tr.segments || [], CHUNK_MS);
    const existing = await dbGet(db, "SELECT COUNT(DISTINCT chunk_start_ms) n FROM video_minutes WHERE video_id=?", [videoId]);
    if (existing && existing.n >= chunks.length && !args.reset) {
      console.log(`skip (already done): ${videoId} (${existing.n}/${chunks.length} chunks)`);
      await dbRun(db, `INSERT OR REPLACE INTO video_minutes_done (video_id) VALUES (?)`, [videoId]);
      skipped++;
      continue;
    }
    totalChunks += chunks.length;
    console.log(`\n=== ${videoId} | ${title.slice(0, 40)} | chunks: ${chunks.length} | existing: ${existing ? existing.n : 0}`);

    // 部分完了・重複があれば消してから生成し直す（同一チャンク再投入で重複させない）
    await dbRun(db, "DELETE FROM video_minutes WHERE video_id=?", [videoId]);

    // 直列→並列実行(小並列)
    let index = 0;
    let droppedChunks = 0;
    const worker = async () => {
      while (index < chunks.length) {
        const ci = index++;
        const chunk = chunks[ci];
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await ensureNeurons();
            const parsed = await summarize(chunk);
            const { section, items } = normalizeResult(parsed, chunk);
            const inserted = await insertItems(db, { videoId, chunk, section, items, title, streamDateJst, url });
            totalItems += inserted;
            console.log(`  [${ci + 1}/${chunks.length}] ${fmtJst(chunk.start)}${section ? ` | ${section}` : ""} items=${items.length} inserted=${inserted}`);
            await sleepMs(PACE_MS);
            break;
          } catch (e) {
            console.error(`  chunk ${ci} attempt ${attempt + 1} fail:`, e.message);
            // 429（レート制限）はヘッダ指示／指数バックオフで間隔を空けてリトライ
            const is429 = /429|quota|rate.?limit/i.test(e.message);
            if (/tokens per day|TPD/i.test(e.message)) {
              // Groq 日次TPD枯渇は翌UTC 00:15（≒JST 09:15）まで待機してから続行。
              // 枯渇中に進めると全チャンクをドロップするだけなので待つ。
              await waitUntilNextUtcDay();
            } else if (e.cfDailyExhausted || /daily free allocation|used up your daily/i.test(e.message)) {
              // CF 日次枯渇: summarize 側で状態を満杯にしてあるため ensureNeurons が即 Groq へ切り替える
              await ensureNeurons();
              await sleepMs(5000);
            } else if (is429) {
              await sleepMs(e.retryAfterMs || 30000 + Math.floor(Math.random() * 8000));
            } else {
              await sleepMs(3000);
            }
            if (attempt === 0) continue;
            await ensureNeurons();
            const retryParsed = await summarize(chunk).catch(() => null);
            if (retryParsed) {
              const r = normalizeResult(retryParsed, chunk);
              const inserted = await insertItems(db, { videoId, chunk, section: r.section, items: r.items, title, streamDateJst, url });
              totalItems += inserted;
              console.log(`  [${ci + 1}/${chunks.length}] (retry ok) items=${r.items.length} inserted=${inserted}`);
            } else {
              droppedChunks++;
              console.error(`  chunk ${ci} dropped`);
            }
          }
        }
      }
    };
    const workers = Array.from({ length: CONCURRENCY }, worker);
    await Promise.all(workers);
    // 全チャンク成功時のみマーカーへ（ドロップ1つでも欠損のまま残し、次回実行で自動補完）
    if (droppedChunks === 0) {
      console.log(`done: ${videoId} (${chunks.length} chunks)`);
      await dbRun(db, `INSERT OR REPLACE INTO video_minutes_done (video_id) VALUES (?)`, [videoId]);
    } else {
      console.log(`done (partial): ${videoId} (${chunks.length} chunks, ${droppedChunks} dropped → マーカー未記録・次回再処理)`);
    }
  }

  console.log(`\n=== SUMMARY: chunks=${totalChunks} items=${totalItems} skipped=${skipped}`);

  if (args.embed) {
    const { embedMinutes } = require("../../services/minutes-sync");
    const n = await embedMinutes(db);
    console.log(`embed/upsert done: ${n} points`);
  }

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });