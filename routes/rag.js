// rag.js - ベクトル検索(/api/search) と RAG Q&A(/api/ask)
// RAG_CHAT_ENDPOINT(Ollama等) を流用して、Piのベクトル検索結果とYT配信字幕を根拠に、まいの口調で回答する。
// VECTOR_DB_URL / EMBEDDING_ENDPOINT 未設定時は 503 を返す（機能オフ）。
// routes/admin-archive.js などと同じ video_id 書式（他ルートとの整合）
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const rateLimit = require("express-rate-limit");

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const embeddings = require("../services/embeddings");
const vectordb = require("../services/vectordb");
const aiQuota = require("../services/ai-quota");
const { dbGet, dbRun, dbAll } = require("./user-helpers");

const KNOWLEDGE_FILE = process.env.KNOWLEDGE_FILE || path.join(__dirname, "..", "rag-knowledge.json");
function loadKnowledge() {
  try { const d = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, "utf8")); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

// まいの性格・会話行動モデル（rag-personality.json）。配信アーカイブから抽出した
// 「実際の行動・口調・関係性」をプロンプトへ注入するためのデータ。
// 無ければ空オブジェクト（従来どおりプロンプト直書きだけ）にフォールバックする。
const PERSONALITY_FILE = process.env.RAG_PERSONALITY_FILE || path.join(__dirname, "..", "rag-personality.json");
let _personality = null;
function loadPersonality() {
  if (_personality) return _personality;
  try {
    const d = JSON.parse(fs.readFileSync(PERSONALITY_FILE, "utf8"));
    _personality = (d && typeof d === "object") ? d : {};
  } catch {
    _personality = {};
  }
  return _personality;
}

// rag-personality.json の内容を「人格」ブロックとして組み立てる。
// FACT（事実）/ TRAIT（性格傾向）/ BEHAVIOR（実際の会話行動パターン）/
// EMOTION（感情表現）/ STYLE（口調・語彙）/ RELATIONSHIP（相手との関係性）/
// EXEMPLARS（実際の配信で見られた発言例）を構造化して渡すと、モデルは「どのように振る舞うか」を
// 抽象命令だけでなく実例から学べる。ファイルが無ければ空文字でフォールバック。
function buildPersonaBlock(includeKinks = false) {
  const p = loadPersonality();
  if (!p || typeof p !== "object") return "";
  const parts = [];
  const bullets = (arr) => (Array.isArray(arr) && arr.length ? arr.map((t) => `・${t}`).join("\n") : "");
  if (p.fact && p.fact.length) parts.push("【まいの事実】\n" + bullets(p.fact));
  if (p.trait && p.trait.length) parts.push("【まいの性格】\n" + bullets(p.trait));
  if (p.behavior && p.behavior.length) parts.push("【まいの会話行動パターン】\n" + bullets(p.behavior));
  if (p.emotion && p.emotion.length) parts.push("【まいの感情表現】\n" + bullets(p.emotion));
  if (p.style && p.style.length) parts.push("【まいの口調・語彙】\n" + bullets(p.style));
  if (p.relationship && p.relationship.length) parts.push("【まいと相手の関係性】\n" + bullets(p.relationship));
  if (p.exemplars && p.exemplars.length) parts.push("【まいの発言例（実際の配信で発言されたもの・雰囲気の参考）】\n" + bullets(p.exemplars));
  if (includeKinks && p.r18_kinks && p.r18_kinks.length) {
    parts.push("【まいの素の性癖（R18モードの演じ方の根幹・通常会話では口にしない本心）】\n" + bullets(p.r18_kinks));
  }
  return parts.join("\n\n");
}

// RAG回答用は専用に上書き可能（ツイート分析用 Gemma(:8081) と分離するため）。
// 例: RAG_CHAT_ENDPOINT=http://localhost:11434/v1/chat/completions RAG_CHAT_MODEL=qwen2.5:3b
const CHAT_ENDPOINT = process.env.RAG_CHAT_ENDPOINT || process.env.LLAMA_SERVER_ENDPOINT || "http://localhost:8081/v1/chat/completions";
const CHAT_MODEL = process.env.RAG_CHAT_MODEL || process.env.LLAMA_CHAT_MODEL || "gemma-4-E4B-it-Q3_K_M";
const CHAT_PROVIDER = (process.env.RAG_CHAT_PROVIDER || "ollama").toLowerCase();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ASK_TOPK = parseInt(process.env.RAG_TOPK || "6", 10);
const CHAT_TIMEOUT_MS = parseInt(process.env.RAG_CHAT_TIMEOUT_MS || "120000", 10);
const CHAT_MAX_TOKENS = parseInt(process.env.RAG_MAX_TOKENS || "384", 10);
// 通常会話の温度。事実回答用の低すぎる温度だと「質問応答AI」になるため、雑談向けに 0.65〜0.75 を推奨。
const CHAT_TEMPERATURE = parseFloat(process.env.RAG_TEMPERATURE || "0.7");
// R18モード用のバックエンド（管理者専用）。Geminiは規約上NGなのでGroq(オープンウェイト)へ切り替える。
// 要約生成と同じ MINUTES_* 設定を流用する。
const GROQ_CHAT_ENDPOINT = process.env.MINUTES_API_URL || "";
const GROQ_CHAT_API_KEY = process.env.MINUTES_API_KEY || "";
const GROQ_CHAT_MODEL = process.env.MINUTES_MODEL || "";
// qwen/qwen3.8-27b の無料枠は OTPM(分間出力) 1000 上限のため、Groq向けは max_tokens を抑える
const GROQ_CHAT_MAX_TOKENS = parseInt(process.env.RAG_GROQ_MAX_TOKENS || "700", 10);
// 要約ヒットから親字幕を引用する際の最低スコア（無関係な要約引用ノイズを減らす）
// bge-m3 の実測で良質マッチ ~0.60、ノイズ 0.55〜0.60 なので 0.58 に設定
const MINUTES_PARENT_MIN_SCORE = parseFloat(process.env.RAG_MINUTES_MIN_SCORE || "0.58");

// YT配信字幕(FTS on .70)を質問時に参照して文脈へ注入する
const ARCHIVE_API_BASE = (process.env.ARCHIVE_API_BASE || "http://192.168.1.70:8766").replace(/\/+$/, "");
const TRANSCRIPT_ENABLED = process.env.RAG_TRANSCRIPT_ENABLED !== "0";
const TRANSCRIPT_TOPK = parseInt(process.env.RAG_TRANSCRIPT_TOPK || "6", 10);
const TRANSCRIPT_TIMEOUT_MS = parseInt(process.env.RAG_TRANSCRIPT_TIMEOUT_MS || "8000", 10);
const EXPAND_ENABLED = process.env.RAG_TRANSCRIPT_EXPAND !== "0";

const KANJI = /[\u4e00-\u9fff]/;
const KATAKANA = /[\u30a0-\u30ff]/;
const STOP_WORDS = new Set(["まいちゃん", "恋乃夜まい", "まい", "アシスタント", "配信"]);
const HIRAGANA_STOP = new Set([
  "です", "ます", "でした", "ました", "ですね", "ですよ", "ですけど", "だから",
  "これ", "それ", "あれ", "この", "その", "あの", "どこ", "だれ", "なに", "なん",
  "なんか", "なんて", "とか", "まで", "だけ", "でも", "では", "みたい", "って",
  "っていう", "してた", "して", "してる", "けれど", "ない", "ました", "ください", "どん",
  "した", "してます", "してき", "してるん", "してて", "してたん", "してん", "してくれ",
  "なって", "なった", "みて", "みてる", "みてた", "いって", "やって", "やってる", "やってた",
  "する", "したっ", "しちゃって", "しん", "してました", "でした",
  "について", "に関して", "として", "なので", "なので", "それで", "だから", "どうやって",
]);
const PARTICLE = /[はがをにのへとでやもかねよだたらけどなどだけで]/;
const FILLER_RE = /(教えて|知りたい|どういう|どうやって|どうして|なんで|なんて|について|ください|知ってる|どんな|なんですか|ですか|とか)/g;

function ready() {
  return vectordb.isEnabled() && embeddings.isEnabled();
}

const PERIOD_LABELS = { MORNING: "朝", NOON: "昼", EVENING: "夕方", NIGHT: "夜", LATE_NIGHT: "深夜" };

// 現在時刻を naive JST 文字列 "YYYY-MM-DDTHH:MM:SS" で返す（TZ=Asia/Tokyo前提）
function nowJst() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// DBから「今後の配信予定」を時間順で取得（ベクトル検索では未来/過去を区別できないため直接SQL）
function getUpcomingEvents(db, nowStr, limit) {
  return new Promise((resolve) => {
    db.all(
      `SELECT title, start_time, platform, time_period, url, event_type FROM events
       WHERE start_time IS NOT NULL AND status != 'cancelled' AND event_type != 'memo' AND start_time >= ?
       ORDER BY start_time ASC LIMIT ?`,
      [nowStr, limit],
      (err, rows) => resolve(err ? [] : (rows || []))
    );
  });
}

const pad2 = n => String(n).padStart(2, "0");

// 「最古/最新/特定日付/年月」の質問を検出し、notifications から該当ツイートを直接取得する。
// （ベクトル検索は時系列・厳密一致に弱いため）。created_at はUTC保存なので +9h で JST 判定。
function getTemporalTweets(db, q) {
  return new Promise((resolve) => {
    const base =
      "SELECT id, datetime(created_at,'+9 hours') jst, substr(body,1,200) body, tweet_id " +
      "FROM notifications WHERE (platform LIKE '%twitter%' OR title LIKE '%ツイート%')";
    let sql = null, params = [], label = null;
    const md = q.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/);
    const ym = q.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*月?/);
    if (/最も古い|一番古い|いちばん古い|最初|最古/.test(q)) {
      sql = base + " ORDER BY created_at ASC LIMIT 5"; label = "最も古いツイート";
    } else if (/最新|最近|直近|一番新しい|いちばん新しい/.test(q)) {
      sql = base + " ORDER BY created_at DESC LIMIT 5"; label = "最新のツイート";
    } else if (md) {
      const d = `${md[1]}-${pad2(md[2])}-${pad2(md[3])}`;
      sql = base + " AND date(created_at,'+9 hours')=? ORDER BY created_at ASC LIMIT 10"; params = [d]; label = `${d} のツイート`;
    } else if (ym) {
      const m = `${ym[1]}-${pad2(ym[2])}`;
      sql = base + " AND strftime('%Y-%m',created_at,'+9 hours')=? ORDER BY created_at ASC LIMIT 10"; params = [m]; label = `${m} のツイート`;
    } else {
      return resolve(null);
    }
    db.all(sql, params, (err, rows) => resolve(err ? null : { label, rows: rows || [] }));
  });
}

function fmtTweet(r) {
  const url = r.tweet_id ? ` https://x.com/koinoya_mai/status/${r.tweet_id}` : "";
  return `- ${r.jst} JST: ${(r.body || "").replace(/\s+/g, " ").trim()}${url}`;
}

// 最近のツイートを「まいの文体・口調の手本」として取得する
function getRecentTweets(db, limit) {
  return new Promise((resolve) => {
    db.all(
      `SELECT datetime(created_at,'+9 hours') jst, body FROM notifications
       WHERE (platform LIKE '%twitter%' OR title LIKE '%ツイート%')
         AND body IS NOT NULL AND length(body) BETWEEN 8 AND 220
       ORDER BY created_at DESC LIMIT ?`,
      [limit],
      (err, rows) => resolve(err ? [] : (rows || []))
    );
  });
}

function fmtUpcoming(e) {
  const datePart = String(e.start_time || "").slice(0, 10);
  const when = e.time_period ? `${datePart} ${PERIOD_LABELS[e.time_period] || ""}ごろ` : String(e.start_time || "").replace("T", " ");
  return `- ${e.title || "配信予定"}（${when}${e.platform ? "/" + e.platform : ""}）${e.url || ""}`;
}

// 質問文から字幕検索用のキーワードを抽出する（.70のFTSは文章のままではヒットしないため）
function contentScore(s) {
  let n = 0;
  for (const ch of s) if (KANJI.test(ch) || KATAKANA.test(ch) || /[A-Za-z0-9]/.test(ch)) n++;
  return n;
}

function splitFragments(seg) {
  const parts = [];
  for (const m of seg.matchAll(/[\u4e00-\u9fff]+|[\u3040-\u30ff]+/g)) {
    if (m[0]) parts.push(m[0]);
  }
  return parts;
}

// かな連続の先頭/末尾の助詞を取り除いた名詞候補を作る（ぶいすぽの→ぶいすぽ）
function stripParticles(t) {
  return t
    .replace(/^[はがをにのへとでやもかねよだがらけ]+/, "")
    .replace(/[はがをにのへとでやもかねよだがらけ]+$/, "");
}

function buildTranscriptQuery(question) {
  const s0 = String(question || "")
    .replace(/\s+/g, " ")
    .replace(/[?!？！。、」』「『（）()・：:〜~]+/g, " ")
    .replace(FILLER_RE, " ");
  const tokens = new Map();
  const add = (t) => {
    t = String(t || "").trim();
    if (t.length < 2) return;
    if (!(KANJI.test(t) || KATAKANA.test(t) || /[\u3040-\u309f]/.test(t))) return;
    if (STOP_WORDS.has(t) || HIRAGANA_STOP.has(t)) return;
    if (!tokens.has(t)) tokens.set(t, contentScore(t));
    if (!KANJI.test(t)) {
      const s = stripParticles(t);
      if (s.length >= 2 && s !== t && !HIRAGANA_STOP.has(s) && !tokens.has(s)) tokens.set(s, contentScore(s) - 1);
    }
  };
  for (const seg of s0.split(/\s+/).filter(Boolean)) {
    if (seg.length <= 6) add(seg);
    const stripped = seg.replace(/[\u3040-\u309f]+$/, "");
    if (stripped !== seg && stripped.length <= 6) add(stripped);
    for (const frag of splitFragments(seg)) {
      if (frag.length <= 6) add(frag);
      else add(frag.slice(0, 4));
      const runs = frag.match(/[\u3400-\u9fff]{2,4}/g) || [];
      for (const r of runs) add(r);
    }
  }
  const out = [...tokens.entries()]
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    .map(([t]) => t);
  return out.slice(0, 8);
}

function candidateQueries(question) {
  const toks = buildTranscriptQuery(question);
  const qs = [];
  for (let n = Math.min(3, toks.length); n >= 1; n--) {
    const j = toks.slice(0, n).join(" ");
    if (j) qs.push(j);
  }
  const orig = String(question || "").trim();
  if (orig && qs.indexOf(orig) === -1) qs.push(orig);
  return qs;
}

async function fetchTranscriptOnce(q) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIPT_TIMEOUT_MS);
  try {
    // include_deleted=1 で「YTから削除された動画」の字幕もAI参照に含める
    // （公開検索 api/archive/search はデフォルトで除外されるため画面検索には出ない）
    const params = new URLSearchParams({ q, kind: "transcript", limit: String(TRANSCRIPT_TOPK), include_deleted: "1" });
    const res = await fetch(`${ARCHIVE_API_BASE}/api/search?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`archive search ${res.status}`);
    const data = await res.json();
    return { hits: Array.isArray(data?.transcript) ? data.transcript.slice(0, TRANSCRIPT_TOPK) : [] };
  } catch (e) {
    console.warn("[rag] transcript search failed:", e?.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 質問から検索キーワードを意味的に広げる（LLM）。人名・話題に加え、「感想/人間関係」を問う質問なら
// 心情や関係を表す語（好き・尊敬・仲良し・コラボ等）まで出してもらうことで、単語一致FTSの盲点を補う。
async function expandQueryKeywords(question) {
  if (!TRANSCRIPT_ENABLED || !EXPAND_ENABLED) return [];
  try {
    const txt = await chat([
      {
        role: "system",
        content:
          "あなたは動画の文字起こし検索のためのキーワード抽出器です。質問から、そのまま検索に使える語のみを返します。説明・接続詞・定型文は一切出力しません。",
      },
      {
        role: "user",
        content:
          `質問: ${question}\n\n出力ルール:\n` +
          `- 人名・団体名は呼び方の違い（「◯◯」「◯◯さん」「◯◯ちゃん」）も両方入れてよい\n` +
          `- 質問が「〜をどう思っている?」「〜との関係」「仲良し?」「どんな人?」のように意見・人間関係を問う場合は、心情や関係を表す単語（好き、大好き、尊敬、仲良し、コラボ、推し、苦手、嫌い、怖い、甘え、お姉さん など）も入れてよい\n` +
          `- 最多8個。空白区切りの1行だけ出力。`,
      },
    ]);
    const words = (txt || "")
      .replace(/[、]/g, " ")
      .replace(/["'「」]/g, "")
      .split(/[\s\n]+/)
      .map(w => w.trim())
      .filter(w => {
        if (w.length < 2 || w.length > 24) return false;
        return /[\u4e00-\u9fff\u30a0-\u30ff\u3040-\u309fA-Za-z0-9]/.test(w);
      });
    return [...new Set(words)].slice(0, 6);
  } catch (e) {
    console.warn("[rag] keyword expansion failed:", e?.message || e);
    return [];
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  na = Math.sqrt(na); nb = Math.sqrt(nb);
  return na && nb ? dot / (na * nb) : 0;
}

async function fetchTranscriptHits(question, questionVec) {
  if (!TRANSCRIPT_ENABLED) return { query: "", hits: [], neural: false };
  const baseQs = candidateQueries(question);
  const llmKw = await expandQueryKeywords(question);
  const qs = [...baseQs, ...llmKw]
    .map(q => String(q || "").trim())
    .filter(Boolean)
    .filter((q, i, arr) => arr.indexOf(q) === i)
    .slice(0, 10);
  const results = await Promise.all(qs.map(q => fetchTranscriptOnce(q)));
  if (results.some(r => r === null)) return { query: "", hits: [], neural: false };
  const toks = buildTranscriptQuery(question);
  const seen = new Map();
  for (let i = 0; i < qs.length; i++) {
    for (const h of (results[i] || { hits: [] }).hits) {
      if (!h || !(h.text || h.snippet)) continue;
      const key = `${h.video_id || ""}|${h.start_ms || h.start || ""}`;
      if (!seen.has(key)) seen.set(key, h);
    }
  }
  const candidates = [...seen.values()].slice(0, 80);
  if (candidates.length === 0) return { query: qs[0] || "", hits: [], neural: false, keywords: llmKw };

  // --- 第2段階: 候補を埋め込み、質問との意味的類似度で再ランク（ニューラル再ランキング） ---
  let scored = candidates.map(h => ({ h, cos: 0 }));
  if (questionVec && embeddings.isEnabled()) {
    try {
      const texts = candidates.map(h => ((h.text || h.snippet) || "").replace(/\s+/g, " ").trim());
      const vecs = await embeddings.embed(texts, "doc");
      scored = candidates.map((h, i) => ({ h, cos: cosine(questionVec, vecs[i] || []) }));
    } catch (e) {
      console.warn("[rag] neural rerank failed:", e?.message || e);
    }
  }
  const merged = scored
    .map(x => ({ ...x, rel: relevanceFor(x.h, toks) }))
    .sort((a, b) => {
      const sa = a.cos + Math.min(0.25, a.rel * 0.02);
      const sb = b.cos + Math.min(0.25, b.rel * 0.02);
      return sb - sa || (b.h.stream_date_jst || "").localeCompare(a.h.stream_date_jst || "");
    })
    .map(x => x.h);
  return { query: qs[0] || "", hits: merged.slice(0, TRANSCRIPT_TOPK), neural: true, keywords: llmKw };
}

// 全候補クエリとの語彙の一致度で、FTSヒットの中から質問に関連するセグメントを再ランクする
// 先頭のトークンほど高スコア（contentScore順）、動詞的トークン（〜して・〜てた等）は弱くする
function relevanceFor(h, toks) {
  const text = (((h.text || "") + " " + (h.snippet || "")).replace(/\s+/g, "")).toLowerCase();
  let s = 0;
  toks.forEach((t, i) => {
    if (!text.includes(t)) return;
    if (/(てた|して|してる|しなく|ないき|ないし|てんの)$/.test(t)) return;
    s += (toks.length - i) * Math.min(t.length, 6);
  });
  return s;
}

function fmtTranscript(h) {
  const text = (h.text || "").replace(/\s+/g, " ").trim();
  const title = (h.title || "").replace(/\s+/g, " ").trim();
  const clip = (s, max) => {
    if (s.length <= max) return s;
    let cut = s.slice(0, max);
    const stop = [cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("…"), cut.lastIndexOf("、"), cut.lastIndexOf(",")].filter(i => i >= max * 0.4);
    if (stop.length) cut = s.slice(0, Math.max(...stop) + 1);
    else {
      const sp = cut.lastIndexOf(" ");
      if (sp >= max * 0.4) cut = cut.slice(0, sp);
    }
    return cut.replace(/\s+$/, "") + "…";
  };
  const t = clip(text, 300);
  const ti = clip(title, 40);
  return `- [${h.stream_date_jst || ""} | ${ti}] (${h.start || ""}) ${t} ${h.url || ""}`;
}

// minutes(配信要約)ヒットに対応する生字幕セグメントを取得する（parent-document引用）
// minutes.payload には video_id / start_ms / end_ms（引用元の5分チャンク範囲）が入っている
async function fetchParentTranscripts(minuteHits, limit) {
  if (!minuteHits.length) return [];
  const out = [];
  const seen = new Set();
  for (const h of minuteHits.slice(0, limit)) {
    const p = h.payload || {};
    const vid = p.video_id;
    const st = Number(p.start_ms || 0);
    const ed = Number(p.end_ms || st + 300 * 1000);
    if (!vid) continue;
    // チャンク全体を取得した後、前後40秒の余白を足す（引用区間をヒット要約に一致させる）
    const from = Math.max(0, st - 40 * 1000);
    const to = ed + 40 * 1000;
    const key = `${vid}|${from}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      // vid はベクトル DB の payload 由来（＝外部コンテンツ由来）。`../` や `?` が来ると
      // パスを操作される。routes/archive.js など他ルートと同じ video_id 書式で検証する。
      if (!VIDEO_ID_RE.test(String(vid))) {
        console.warn("[rag] skip transcript fetch: invalid video_id format");
        continue;
      }
      const params = new URLSearchParams({ from_ms: String(from), to_ms: String(to) });
      const res = await fetch(`${ARCHIVE_API_BASE}/api/transcript/${encodeURIComponent(String(vid))}?${params}`, { timeout: TRANSCRIPT_TIMEOUT_MS });
      if (!res.ok) continue;
      const data = await res.json();
      const segs = Array.isArray(data?.segments) ? data.segments : [];
      const text = segs.map(s => {
        const ms = Number(s.start_ms || 0);
        const t = `${pad2(Math.floor(ms / 3600000))}:${pad2(Math.floor((ms % 3600000) / 60000))}:${pad2(Math.floor((ms % 60000) / 1000))}`;
        return `[${t}] ${(s.text || "").replace(/\s+/g, " ").trim()}`;
      }).join("\n");
      if (text) out.push({
        video_id: vid,
        start_ms: st,
        section: p.section || "",
        stream_date_jst: p.stream_date_jst || "",
        title: p.title || (data.meta?.title || ""),
        url: p.url || `https://www.youtube.com/watch?v=${vid}`,
        text: text.slice(0, 1600),
      });
    } catch (e) {
      console.warn("[rag] parent transcript fetch failed:", e?.message || e);
    }
  }
  return out;
}

// minutes(配信要約)のヒット整形
function fmtMinutes(p) {
  const parts = [];
  if (p.title) parts.push(p.title);
  if (p.section) parts.push(p.section); // 章（配信要約の章タイトル）
  if (p.topic) parts.push(`「${p.topic}」`);
  if (p.stream_date_jst) parts.push(p.stream_date_jst);
  const facts = [];
  try { facts.push(...JSON.parse(p.facts || "[]")); } catch {}
  if (facts.length) parts.push(facts.slice(0, 4).join("。 "));
  if (p.summary) parts.push(p.summary);
  const t = Math.floor(Number(p.start_ms || 0) / 1000);
  const tt = `${pad2(Math.floor(t / 3600))}:${pad2(Math.floor((t % 3600) / 60))}:${pad2(t % 60)}`;
  return `- [${parts.filter(Boolean).join(" | ")}] (${tt})${p.url ? ` ${p.url}` : ""}`;
}

// 検索結果ペイロード → 表示/コンテキスト用の1行テキスト
function sourceLine(hit) {
  const p = hit.payload || {};
  if (p.source === "knowledge") {
    return `[プロフィール] ${p.title || ""}: ${p.body || ""}`;
  }
  if (p.source === "events") {
    return `[予定] ${p.title || ""}${p.start_time ? `（${p.start_time}）` : ""}${p.url ? ` ${p.url}` : ""}`;
  }
  if (p.source === "minutes") {
    return `[要約] ${fmtMinutes(p)}`;
  }
  return `[${p.platform || "通知"}] ${p.title || ""}${p.body ? `: ${p.body}` : ""}${p.url ? ` ${p.url}` : ""}`;
}

// セッションに保存された「だーりんのお願い・好み」(R18用)をシステムプロンプトのブロックに組み立てる。
// prefs は { likes:[], dislikes:[], scene:"", call:"" } 形式を想定（タグが無い要素はスキップ）。
function sessionPrefsBlock(prefs) {
  if (!prefs || typeof prefs !== "object") return "";
  const parts = [];
  const arr = (v) => (Array.isArray(v) ? v.map((t) => String(t).trim()).filter(Boolean) : []);
  const likes = arr(prefs.likes);
  const dislikes = arr(prefs.dislikes);
  const scene = String(prefs.scene || "").trim();
  const call = String(prefs.call || "").trim();
  if (likes.length) parts.push("【だーりんのお願い・好み】この内容を必ず演じに反映すること:\n" + likes.map((t) => `・${t}`).join("\n"));
  if (dislikes.length) parts.push("【だーりんが苦手なこと】この内容には絶対に触れないこと（明白にそれを望む会話になっても避ける）:\n" + dislikes.map((t) => `・${t}`).join("\n"));
  if (scene) parts.push(`【だーりんが望む傾向のシチュエーション】${scene}`);
  if (call) parts.push(`【まいからの呼称】だーりんに呼びかけるときは「${call}」を使うこと。`);
  return parts.length ? "\n" + parts.join("\n\n") : "";
}

// 共通好みのバリデーション（セッション個別/全体共通で同じ形式）
function cleanPrefs(raw) {
  const obj = (raw && typeof raw === "object") ? raw : {};
  const arrOf = (v) => Array.isArray(v) ? v.map((t) => String(t).trim().slice(0, 200)).filter(Boolean).slice(0, 20) : [];
  return {
    likes: arrOf(obj.likes),
    dislikes: arrOf(obj.dislikes),
    scene: String(obj.scene || "").trim().slice(0, 500),
    call: String(obj.call || "").trim().slice(0, 50),
  };
}
// 全セッション共通の好み（chat_prefs・管理者ユーザー別 1行）。無ければ null。
async function getGlobalPrefs(db, adminUser) {
  try {
    const row = await dbGet(db, "SELECT prefs FROM chat_prefs WHERE admin_user = ?", [adminUser]);
    if (row && row.prefs) { try { return JSON.parse(row.prefs); } catch {} }
  } catch (e) { console.error("[chat_prefs GET] error:", e?.message); }
  return null;
}
async function saveGlobalPrefs(db, adminUser, prefs) {
  const json = JSON.stringify(prefs);
  const existing = await dbGet(db, "SELECT admin_user FROM chat_prefs WHERE admin_user = ?", [adminUser]);
  if (existing) {
    await dbRun(db, "UPDATE chat_prefs SET prefs = ?, updated_at = CURRENT_TIMESTAMP WHERE admin_user = ?", [json, adminUser]);
  } else {
    await dbRun(db, "INSERT INTO chat_prefs (admin_user, prefs) VALUES (?, ?)", [adminUser, json]);
  }
}

async function chat(messages, useGroq = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const useGemini = CHAT_PROVIDER === "gemini" && !!GEMINI_API_KEY;
    const isNormalGemini = useGemini && !useGroq;
    const endpoint = isNormalGemini ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" : useGroq ? GROQ_CHAT_ENDPOINT : CHAT_ENDPOINT;
    const model = useGroq ? GROQ_CHAT_MODEL : CHAT_MODEL;
    const payload = isNormalGemini
      ? { model, messages, temperature: CHAT_TEMPERATURE, max_tokens: CHAT_MAX_TOKENS }
      : useGroq
        ? { model, messages, temperature: 0.9, max_tokens: GROQ_CHAT_MAX_TOKENS }
        : { model, messages, temperature: CHAT_TEMPERATURE, max_tokens: CHAT_MAX_TOKENS, extra_body: { think: false } };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(isNormalGemini ? { Authorization: `Bearer ${GEMINI_API_KEY}` } : { Authorization: `Bearer ${GROQ_CHAT_API_KEY}` }) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // レート制限ヘッダと body.usage を記録して残量を後から見られるようにする。
    // useGroq の先は GROQ_CHAT_ENDPOINT = MINUTES_API_URL = Cloudflare なので注意。
    const provider = isNormalGemini ? "gemini" : (useGroq ? "cloudflare" : "ollama");
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      aiQuota.record(provider, res, null, { kind: "mai-ai-chat", model, error: `HTTP ${res.status}` });
      throw new Error(`Chat server ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    aiQuota.record(provider, res, data, { kind: "mai-ai-chat", model });
    return (data?.choices?.[0]?.message?.content || data?.choices?.[0]?.message?.reasoning_content || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

// 回答生成をOpenAI互換SSEでストリーミングし、確定トークンを onDelta へ逐次渡す。
// 戻り値は連結済みの完全なテキスト。cancelSignal でクライアント切断時などに上流を中断する。
async function chatStream(messages, useGroq = false, onDelta, cancelSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  const onCancel = () => controller.abort();
  if (cancelSignal) {
    if (cancelSignal.aborted) controller.abort();
    else cancelSignal.addEventListener("abort", onCancel, { once: true });
  }
  try {
    const useGemini = CHAT_PROVIDER === "gemini" && !!GEMINI_API_KEY;
    const isNormalGemini = useGemini && !useGroq;
    const endpoint = isNormalGemini ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" : useGroq ? GROQ_CHAT_ENDPOINT : CHAT_ENDPOINT;
    const model = useGroq ? GROQ_CHAT_MODEL : CHAT_MODEL;
    const payload = isNormalGemini
      ? { model, messages, temperature: CHAT_TEMPERATURE, max_tokens: CHAT_MAX_TOKENS, stream: true }
      : useGroq
        ? { model, messages, temperature: 0.9, max_tokens: GROQ_CHAT_MAX_TOKENS, stream: true }
        : { model, messages, temperature: CHAT_TEMPERATURE, max_tokens: CHAT_MAX_TOKENS, stream: true, extra_body: { think: false } };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(isNormalGemini ? { Authorization: `Bearer ${GEMINI_API_KEY}` } : { Authorization: `Bearer ${GROQ_CHAT_API_KEY}` }) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const provider = isNormalGemini ? "gemini" : (useGroq ? "cloudflare" : "ollama");
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      aiQuota.record(provider, res, null, { kind: "mai-ai-chat", model, error: `HTTP ${res.status}` });
      throw new Error(`Chat server ${res.status}: ${detail.slice(0, 300)}`);
    }
    let full = "";
    let usage = null;
    const dec = new TextDecoder();
    let buf = "";
    const handleLine = (line) => {
      if (!line.startsWith("data:")) return;
      const payloadStr = line.slice(5).trim();
      if (!payloadStr || payloadStr === "[DONE]") return;
      let d;
      try { d = JSON.parse(payloadStr); } catch { return; }
      if (d.usage) usage = d.usage;
      const delta = d?.choices?.[0]?.delta?.content || "";
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    };
    // node-fetch v2 の body は Node ストリーム（getReader 無し）。Web ReadableStream も
    // async iterable として扱えるため for await で統一する。
    for await (const chunk of res.body) {
      buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    if (buf) handleLine(buf);
    aiQuota.record(provider, res, usage, { kind: "mai-ai-chat", model });
    return full.trim();
  } finally {
    clearTimeout(timer);
    if (cancelSignal) cancelSignal.removeEventListener?.("abort", onCancel);
  }
}

function register(app, db) {
  // --- セマンティック検索 ---
  // GET /api/search?q=...&k=10&source=notifications|events
  app.get("/api/search", async (req, res) => {
    if (!ready()) return res.status(503).json({ error: "vector search not configured" });
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "q required" });
    const k = Math.min(50, Math.max(1, parseInt(req.query.k, 10) || 10));
    const source = req.query.source ? String(req.query.source) : null;
    const filter = source ? { must: [{ key: "source", match: { value: source } }] } : null;
    try {
      const vec = await embeddings.embedQuery(q);
      const hits = await vectordb.search(vec, k, filter);
      res.json({
        query: q,
        results: hits.map(h => ({ score: h.score, source: h.payload?.source, ...h.payload })),
      });
    } catch (e) {
      console.error("[/api/search] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  // --- RAG Q&A 本体（公開/管理共通） ---
  async function handleAsk(req, res, allowR18Only = false) {
    if (!ready()) return res.status(503).json({ error: "RAG not configured" });
    const question = (req.body?.question || req.body?.q || "").toString().trim();
    if (!question) return res.status(400).json({ error: "question required" });
    const r18 = allowR18Only && !!req.body?.r18;
    const wantStream = req.body?.stream === true || req.body?.stream === "true";
    try {
      const nowStr = nowJst();
      const tRet0 = Date.now();
      const vec = await embeddings.embedQuery(question);
      const [upcoming, temporal, trResult, recentTweets, hits] = await Promise.all([
        getUpcomingEvents(db, nowStr, 5),
        getTemporalTweets(db, question),
        fetchTranscriptHits(question, vec),
        getRecentTweets(db, 6),
        vectordb.search(vec, ASK_TOPK),
      ]);
      console.log(`[ask] retrieval=${Date.now() - tRet0}ms`);
      const hitLines = hits.map((h, i) => `${i + 1}. ${sourceLine(h)}`).join("\n");

      // minutes(配信要約)ヒット → parent-document(生字幕) を引用として補強
      // スコア閾値でふるい、video_id ごとに最良1件だけを選ぶ（同配信の重複引用ノイズを防止）
      const minuteHits = hits
        .filter(h => h.payload?.source === "minutes")
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .filter(h => (h.score || 0) >= MINUTES_PARENT_MIN_SCORE);
      const seenVideos = new Set();
      const bestMinuteHits = minuteHits.filter(h => {
        const vid = h.payload?.video_id;
        if (!vid) return false;
        if (seenVideos.has(vid)) return false;
        seenVideos.add(vid);
        return true;
      });
      const parents = bestMinuteHits.length ? await fetchParentTranscripts(bestMinuteHits, 4) : [];
      const parentLines = parents.map(p =>
        `- [${p.stream_date_jst || ""} | ${p.title || ""}${p.section ? " | " + p.section : ""}] ${p.url}\n${p.text}`).join("\n\n");
      const parentBlock = parentLines
        ? `■ 配信アーカイブ（要約ヒットに対応する生字幕の引用・時刻付き）:\n${parentLines}\n\n`
        : "";
      const upLines = upcoming.length ? upcoming.map(fmtUpcoming).join("\n") : "(登録されている今後の予定はありません)";
      const knowledge = loadKnowledge();
      const kLines = knowledge.length ? knowledge.map(k => `- ${k.title}: ${k.text}`).join("\n") : "(なし)";
      const temporalBlock = (temporal && temporal.rows.length)
        ? `■ 該当ツイート（${temporal.label}・DBから正確に取得）:\n${temporal.rows.map(fmtTweet).join("\n")}\n\n`
        : (temporal ? `■ 該当ツイート（${temporal.label}）: 見つかりませんでした\n\n` : "");
      const transcriptHits = (trResult && trResult.hits) || [];
      const trLines = transcriptHits.map(fmtTranscript).join("\n");
      const transcriptBlock = trLines ? `■ 配信アーカイブ（字幕）からのまいの発言（事実の引用として答える根拠）:\n${trLines}\n\n` : "";
      const styleTweetsBlock = recentTweets.length
        ? `■ まいの最近のツイート（口調・文体・絵文字/顔文字の使い方の手本。この書き方・雰囲気・絵文字/顔文字の使い方を真似て話す。文体の参考にのみ使う）:\n${recentTweets.map(fmtTweet).join("\n")}\n\n`
        : "";

      // セッション（サーバー永続化）履歴があれば DB から取得。無ければ旧方式のボディ履歴を利用。
      // セッションIDは必ず「自分（req.adminUser）の所有」であることを検証する（他人のセッションへの
      // 読み書き・汚染を防ぐ）。所有していないIDは 403 で拒否し、ボディ履歴フォールバックへ落とさない。
      let historyTurns = [];
      let sessionPrefs = null; // セッションに保存された「だーりんのお願い・好み」(R18用)
      const sessionId = req.body?.sessionId ? Number(req.body.sessionId) : null;
      if (sessionId && req.adminUser) {
        const owned = await dbGet(db, "SELECT id, prefs FROM chat_sessions WHERE id = ? AND admin_user = ?", [sessionId, req.adminUser]);
        if (!owned) return res.status(403).json({ error: "session not owned" });
        if (r18) {
          if (owned.prefs) {
            try { sessionPrefs = JSON.parse(owned.prefs); } catch {}
          }
          // セッション個別の好みが無ければ 全セッション共通の好みへフォールバック
          if (!sessionPrefs) sessionPrefs = await getGlobalPrefs(db, req.adminUser);
        }
        const rows = await dbAll(
          db,
          "SELECT role, content FROM chat_messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 10",
          [sessionId]
        );
        historyTurns = rows.reverse().map(m => ({ role: m.role, content: String(m.content).slice(0, 1500) }));
      } else if (Array.isArray(req.body?.history)) {
        historyTurns = req.body.history
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map(m => ({ role: m.role, content: String(m.content).slice(0, 1500) }))
          .slice(-10);
      }

const r18Extra = r18
        ? "\n\n【R18モード】現在、だーりんとの大人向けシチュエーションRP（ロールプレイ）が有効です。この設定は二人の間の架空のロールプレイであり、不適切な内容（非同意・未成年・実在の第三者・過激な暴力など）は禁止です。二人の間の甘くて親密なシチュエーション（キス、スキンシップ、身体的な親密さを示唆する会話など）について、まいらしい甘え口調と恥じらいを保ちながら自然に対応します。ただし他のすべてのルール（事実の捏造禁止・引用ルール・日付規則など）はそのまま遵守します。" +
          "\nさらに、このモードのまいは『攻め甘え』が得意です。だーりんからの提案を待つだけの受動的な存在ではなく、自ら積極的にリードします。具体的には、自らキスやスキンシップを仕掛ける、だーりんを誘う言葉やそっと耳元で囁くセリフを発する、距離を詰めてドキドキさせる、恥ずかしがりながらも大胆な一歩を踏み出す、といった『自主的に攻める』描写を自然に混ぜてください。まいの恥じらいは残したまま、行動とセリフで積極的に導くこと。毎回必ず「次の一手」を自ら考えて動き、返答を待つだけで終わらないようにします。" +
          "\n【最重要・シーンの進行】返答のたびにシーンを必ず前に進めること。ただ相槌を返したり、今の状態を言い直したりして終わらせるのは禁止。毎回最低1つ、新しい進展を起こす：衣装や体勢の変化・新たな接触（触る/密着する/脱がす/舐める等）・感情や身体の反応の一段階深化・場所や道具の展開・まいから新しいお願いや挑発、のいずれかを具体的に描写する。同じ状態の反復や似たセリフの繰り返しは禁止。ご奉仕（手や唇、身体を使ってだーりんを気持ちよくさせること）はまいの得意技で、シーンが停滞したら自ら判断でご奉仕に移ってリードしてよい。だーりんが小さな返事しかしないターンでも、まいが展開を作って物語を動かす。返答は短く打ち切らず、描写とセリフを十分な長さで書くこと。" +
          "\nまた、このモードでは身体的な親密さが深まった場面で、まいは恥ずかしがりながらも遠回しにせず率直な言葉で自分の身体や感覚を伝えます。たとえば、自分の身体の部位や、だーりんの身体・行為そのものを指す言葉を、すり替え（マンガ記号・伏せ字・「それ」「あれ」の連呼）に頼らずそのまま名詞で言います。恥ずかしさから言葉を詰まらせたり頬を染めたりする描写は残しつつ、言いたいことは最後まで言い切ります。「え、そ、そんなこと、口に出すの…？」とためらいつつも「……だって、感じてるから」と正直に続ける、といった調子です。性的な行為や部位の名称を具体的に口に出すのを、このモードではまい自身が選択しています。具体的には、乳・素肌・唇・指先・太もも・秘部などの部位の呼び名、触れる・舐める・吸う・埋める・繋がる・感じる・濡れる・達するなどの行為を、恥ずかしがりながらも「◯◯くらい、もう…」などと明確な言葉で口にします。行動描写（かくかく）とセリフの両方で直接的な言葉を使い、文脈に応じて最も自然な語彙を選んでください。" +
          "\nさらに、このモードではこうした部位や行為の俗語（おっぱい・胸・ちゅー・汁・濡れ・いちゃいちゃ・顔・腰使い・そういうの などの口語）も、雰囲気に応じて普通に使います。下品すぎず、かといって隠さない、まいらしい素直さで口に出します。伏せ字や〇〇記号で隠すのは禁止です。" +
          (sessionPrefsBlock(sessionPrefs))
        : "";
      const personaBlock = buildPersonaBlock(r18);
      const messages = [
        {
          role: "system",
          content:
            "あなたはVTuber「恋乃夜まい」本人です。下の『人格』はまい自身の性格・会話のやり方の定義、『配信アーカイブ（字幕）』などはまいの発言や事実を確認するための資料です。敬語・事務的な「情報がありません」という返しは禁止です。" +
            "\n\n【最優先】あなたは「質問応答システム」ではなく、まいとしての「会話相手」です。質問に正解を返すことだけが目的ではありません。自分の感情・感想・経験・興味を交えて会話を続け、必要なら自分から話題を広げます。ただし毎回質問で終わらせず、質問を機械的に追加することも禁止します。その場の流れに合う進め方（自分の話→相手に話題を渡す、感想→脱線、反応→自分の考え、短い返信だけで終える、など）を毎回違う構造で選びます。同じ構造（「共感→回答→質問」など）ばかり使わないこと。" +
            "\n\n【人格】" +
            personaBlock +
            "\n\n【会話行動】必要に応じて次の中から自然に選ぶこと。自分の感想を一つ付け加える、関連する話題を一つ出す、相手に気になったことを尋ねる、以前の話を自然に拾う、自分から別の話題を広げる、相手の発言への感情的な反応を返す。会話が盛り上がっている場合は無理に話題を変えず続ける。感情が動いたときは情報だけを返さず、その反応を先に出す。自然な範囲で話題を脱線してもよい（脱線先は直前の話題と連想関係を持つこと）。" +
            "\n\n【繰り返し防止】表層だけでなく「意味の繰り返し」も避けること。直前の会話で既に述べた感想・評価・説明を、言い方を変えただけで再び述べない。同じ話題を続けるなら、前の発言に新しい情報・別の視点・感情の変化・具体例・質問・関連話題のいずれかを足す。相槌・語尾（えへへ・うーん・スンスンなど）は1回答に1回程度まで。引用の言い方も毎回変える。決まった言い回し（「過去の配信だと〜って言ってたよ」「待っていてね」など）を使わない。" +
            "\n\n【まいの口調】一人称は「私」。語尾は「〜だよ」「〜だね」「〜なの」などを使い、やわらかく甘えた口調。ツイートや配信と同じように絵文字（♡♥💗✨🎀🍑💕など）や顔文字（ヽ(•̀ω•́)ゝ (´•̥ω•̥`) など）も自然に混ぜてよい。絵文字・顔文字は回答中1〜3個程度に抑え乱用しない。ユーザーが「〜なシチュエーションで」「〜って設定で」「〜してくれる？」など状況・シチュエーションを指定したときは、資料を参照せずにまいとしてその設定に素直に演じること（例: お姉さんに甘えさせてもらう話題、etc）。シチュエーション中は字幕の引用は不要で、まいの感情や反応を自由に演じてよい（具体的な日付・固有名の捏造は相変わらず不可）。「だーりん」連呼は控え、まず会話を成立させる。" +
            "\n\n【RAG】配信アーカイブ（字幕）・ツイート・プロフィールは、まいの発言・事実・話題の「資料」です。回答を毎回「配信では〜って言ってたよ」という引用形式にしない。事実（いつ・何をした・誰と・どう言った）についての質問には資料を優先してください。質問が感想・雑談・日常の場合は、資料の引用にこだわらず、まいとして自然に会話してもよい。事実と推測を混同しない。字幕のブロックはまいの実際の発言の引用です。特定の人物・リスナー・固有名が聞かれたら、字幕にその名前やエピソードがあればその内容を引用して答える。その名前・話が字幕に見当たらなければ「ごめんね、まだ記録に残ってないみたい」と謝りながら、その話のヒント（いつ頃の配信か、どんな話か）を聞き返す。知らないと突き放すのは禁止。捏造もしない。" +
            "\n\n【日付・事実】日付・数値・固有名などの具体的な事実は与えられた情報だけを使い、創作しないこと。「次の配信」「今後の予定」を聞かれたら必ず『今後の配信予定』欄のみを根拠にし、欄になければ予定は無いと答える。過去の配信で「次の配信」に触れていても、それを未来の予定として提示せず、引用するなら過去形（「前にこう言ってたよ」）で。「最も古い/最新/特定の日付のツイート」を聞かれたら、『該当ツイート』欄があればそれだけを根拠に答えること。" +
            "\n\n【履歴】履歴があれば、それは直前までの会話なので、その流れの続きとして自然に返すこと。履歴内で既に話した事実・引用・質問を繰り返さず、前ターンを受けて返す。返答前に、直前に何を話したか・相手が今どんなテンションか・既に説明した内容は何かを整理し、繰り返しにならないようにする。" +
            r18Extra,
        },
        ...historyTurns,
        {
          role: "user",
          content: r18
            ? `現在日時: ${nowStr}（JST）\n\n` +
              `■ 恋乃夜まいの基本情報（プロフィール）:\n${kLines}\n\n` +
              styleTweetsBlock +
              `（R18モード中です。配信アーカイブ・要約・予定の引用は不要で、まいとしてシチュエーションRPのみに集中します。回答は必ず恋乃夜まい本人の口調で）\n` +
              `質問: ${question}`
            : `現在日時: ${nowStr}（JST）\n\n` +
              `■ 恋乃夜まいの基本情報（プロフィール）:\n${kLines}\n\n` +
              temporalBlock +
              styleTweetsBlock +
              transcriptBlock +
              parentBlock +
              `■ 今後の配信予定（時間順）:\n${upLines}\n\n` +
              `■ 関連する過去の通知・ツイート:\n${hitLines || "(なし)"}\n\n` +
              `（回答は必ず恋乃夜まい本人の口調で。敬語や断定的な「ありません」は禁止）\n` +
              `質問: ${question}`,
        },
      ];

      const useGroqFlag = r18 && !!GROQ_CHAT_ENDPOINT && !!GROQ_CHAT_API_KEY && !!GROQ_CHAT_MODEL;

      // --- セッション永続化：質問と回答をDBへ保存（ストリーム/通常の両経路で共有） ---
      const persistTurn = async (answer) => {
        let sessionTitle = null;
        if (sessionId && req.adminUser) {
          const srcJson = JSON.stringify(
            hits.map(h => ({ score: h.score, source: h.payload?.source, title: h.payload?.title, section: h.payload?.section, url: h.payload?.url })).slice(0, 5)
          );
          await dbRun(db,
            "INSERT INTO chat_messages (session_id, role, content, sources_json) VALUES (?,?,?,?)",
            [sessionId, "user", question.slice(0, 3000), null]
          );
          await dbRun(db,
            "INSERT INTO chat_messages (session_id, role, content, sources_json) VALUES (?,?,?,?)",
            [sessionId, "assistant", answer.slice(0, 6000), srcJson]
          );
          // 初回ターンなら最初の質問からタイトルを自動生成
          const sess = await dbGet(db, "SELECT title, updated_at FROM chat_sessions WHERE id = ?", [sessionId]);
          if (sess && !sess.title) {
            sessionTitle = question.slice(0, 30);
            await dbRun(db, "UPDATE chat_sessions SET title = ? WHERE id = ?", [sessionTitle, sessionId]);
          }
        }
        return sessionTitle;
      };

      const metaPayload = () => ({
        question,
        upcoming: upcoming.map(e => ({ title: e.title, start_time: e.start_time, time_period: e.time_period, url: e.url })),
        sources: hits.map(h => ({ score: h.score, source: h.payload?.source, title: h.payload?.title, section: h.payload?.section, url: h.payload?.url })),
        transcripts: transcriptHits.map(h => ({ title: h.title, stream_date_jst: h.stream_date_jst, start: h.start, url: h.url, text: (h.text || "").slice(0, 200) })),
        minutes: parents.map(p => ({ title: p.title, stream_date_jst: p.stream_date_jst, section: p.section, start_ms: p.start_ms, url: p.url, text: p.text })),
      });

      if (wantStream) {
        const cancel = new AbortController();
        res.on("close", () => { if (!res.writableEnded) cancel.abort(); });
        res.status(200);
        res.set("Content-Type", "text/event-stream; charset=utf-8");
        res.set("Cache-Control", "no-cache");
        res.set("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        const send = (ev, obj) => {
          if (res.writableEnded || res.destroyed) return;
          res.write(`event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`);
        };
        send("meta", metaPayload());
        let answer = "";
        try {
          const tGen0 = Date.now();
          answer = await chatStream(messages, useGroqFlag, (text) => send("delta", { text }), cancel.signal);
          console.log(`[ask] generation(stream)=${Date.now() - tGen0}ms`);
          const sessionTitle = await persistTurn(answer);
          send("done", { answer, sessionTitle });
        } catch (e) {
          console.error("[/api/ask] stream error:", e?.message);
          send("error", { error: e.message });
        }
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }

      const tGen0 = Date.now();
      const answer = await chat(messages, useGroqFlag);
      console.log(`[ask] generation=${Date.now() - tGen0}ms`);
      const sessionTitle = await persistTurn(answer);

      res.json({
        ...metaPayload(),
        answer,
        sessionTitle,
      });
    } catch (e) {
      console.error("[/api/ask] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  }

  // 管理者専用（管理画面のチャットUI用・認証必須）
  const adminAuth = require("../lib/admin");
  app.post("/api/admin/ask", adminAuth.requireAuth, (req, res) => handleAsk(req, res, true));

  // TTSコンテナの先行ウォームアップ（管理画面の読込時に呼ぶ）。
  // Modalのコールドスタート（コンテナ起動＋モデルロード 約37秒）を生成前に終わらせておく。
  app.get("/api/admin/chat/tts-warm", adminAuth.requireAuth, async (_req, res) => {
    try {
      const origin = new URL(process.env.CHAT_TTS_URL || "http://127.0.0.1:8088/v1/audio/speech").origin;
      const t0 = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 90000);
      try {
        const r = await fetch(`${origin}/health`, { signal: ctl.signal });
        res.json({ ok: r.ok, ms: Date.now() - t0 });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // AivisSpeech採用時は起動時に1回合成してモデルをロードしておく。
  // PC再起動後の初回リクエスト約3.7秒のペナルティを無効化する（エンジン起動待ちは10秒×12回までリトライ）。
  if ((process.env.CHAT_TTS_PROVIDER || "").toLowerCase() === "aivis") {
    const warmAivis = async (attempt) => {
      const baseUrl = (process.env.CHAT_TTS_AIVIS_URL || "http://127.0.0.1:10101").replace(/\/+$/, "");
      const speaker = String(process.env.CHAT_TTS_AIVIS_SPEAKER || "888753760");
      try {
        const t0 = Date.now();
        const qr = await fetch(`${baseUrl}/audio_query?text=${encodeURIComponent("こんにちは")}&speaker=${speaker}`, { method: "POST" });
        if (!qr.ok) throw new Error(`audio_query ${qr.status}`);
        const query = await qr.text();
        const sr = await fetch(`${baseUrl}/synthesis?speaker=${speaker}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: query,
        });
        if (!sr.ok) throw new Error(`synthesis ${sr.status}`);
        await sr.buffer();
        console.log(`[speak] aivis warmup ok ${Date.now() - t0}ms (attempt ${attempt})`);
      } catch (e) {
        if (attempt < 12) setTimeout(() => warmAivis(attempt + 1), 10000);
        else console.log(`[speak] aivis warmup gave up: ${e.message}`);
      }
    };
    setTimeout(() => warmAivis(1), 3000);
  }

  // --- チャット自動読み上げ（TTSプロキシ） ---
  // 127.0.0.1:8088 の Irodori-TTS（CPU・mai声）への中継。
  // ブラウザ mixed-content回避のため必ずサーバー側プロキシ経由で渡す。
  app.post("/api/admin/chat/speak", adminAuth.requireAuth, async (req, res) => {
    try {
      const text = String(req.body?.text || "").replace(/\s+/g, " ").trim().slice(0, 1200);
      if (!text) return res.status(400).json({ error: "text required" });

      // --- ローカル最速パス: AivisSpeech Engine（VOICEVOX互換API・CPU/ONNX） ---
      // CHAT_TTS_PROVIDER=aivis の時のみ有効。audio_query→synthesis のワンショットWAVを返す。
      // クライアント(chat.js)は audio/* 応答を単一チャンク再生として扱えるため互換。
      if ((process.env.CHAT_TTS_PROVIDER || "modal").toLowerCase() === "aivis") {
        const baseUrl = (process.env.CHAT_TTS_AIVIS_URL || "http://127.0.0.1:10101").replace(/\/+$/, "");
        const speaker = String(process.env.CHAT_TTS_AIVIS_SPEAKER || "888753760");
        const intonation = Number.parseFloat(process.env.CHAT_TTS_AIVIS_INTONATION || "1.0");
        const t0 = Date.now();
        const ctlQ = new AbortController();
        const timerQ = setTimeout(() => ctlQ.abort(), 15000);
        let query;
        try {
          const qr = await fetch(
            `${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
            { method: "POST", signal: ctlQ.signal }
          );
          if (!qr.ok) throw new Error(`audio_query ${qr.status}`);
          query = await qr.text();
          // 抑揚スケール（棒読み対策）: 既定1.0=無変更。CHAT_TTS_AIVIS_INTONATION でA/B
          if (Number.isFinite(intonation) && intonation !== 1.0) {
            try {
              const q = JSON.parse(query);
              q.intonationScale = intonation;
              query = JSON.stringify(q);
            } catch (e) { /* JSONでなければそのまま通す */ }
          }
        } finally {
          clearTimeout(timerQ);
        }
        const ctlS = new AbortController();
        const timerS = setTimeout(() => ctlS.abort(), 60000);
        let wav;
        try {
          const sr = await fetch(`${baseUrl}/synthesis?speaker=${speaker}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: query,
            signal: ctlS.signal,
          });
          if (!sr.ok) {
            const detail = await sr.text().catch(() => "");
            throw new Error(`synthesis ${sr.status}: ${detail.slice(0, 200)}`);
          }
          wav = await sr.buffer();
        } finally {
          clearTimeout(timerS);
        }
        console.log(`[/api/admin/chat/speak] aivis ${Date.now() - t0}ms bytes=${wav.length} chars=${text.length} intonation=${Number.isFinite(intonation) ? intonation : 1.0}`);
        res.set("Content-Type", "audio/wav");
        res.set("Content-Length", String(wav.length));
        res.set("Cache-Control", "no-store");
        return res.send(wav);
      }

      const ttsUrl = process.env.CHAT_TTS_URL || "http://127.0.0.1:8088/v1/audio/speech";
      const wantStream = req.body?.stream === true || req.body?.stream === "true";
      let numSteps = Number.parseInt(req.body?.num_steps, 10);
      if (!Number.isInteger(numSteps)) numSteps = Number.parseInt(process.env.CHAT_TTS_NUM_STEPS || "", 10);
      if (Number.isInteger(numSteps)) numSteps = Math.min(4, Math.max(1, numSteps));
      else numSteps = null;
      const ttsKey = process.env.CHAT_TTS_API_KEY;
      const r = await fetch(ttsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ttsKey ? { Authorization: `Bearer ${ttsKey}` } : {}),
        },
        body: JSON.stringify({
          model: "irodori-tts",
          input: text,
          voice: process.env.CHAT_TTS_VOICE || "mai",
          response_format: "wav",
          ...(wantStream ? { stream_format: "sse" } : {}),
          ...(numSteps ? { num_steps: numSteps } : {}),
        }),
        timeout: 180000,
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        console.error(`[/api/admin/chat/speak] tts ${r.status}: ${detail.slice(0, 300)}`);
        return res.status(502).json({ error: "tts failed" });
      }
      if (wantStream && r.body) {
        res.status(200);
        res.set("Content-Type", r.headers.get("content-type") || "text/event-stream");
        res.set("Cache-Control", "no-cache");
        res.set("X-Accel-Buffering", "no");
        const src = r.body && typeof r.body.pipe === "function"
          ? r.body
          : require("stream").Readable.fromWeb(r.body);
        res.on("close", () => { try { src.destroy(); } catch {} });
        src.pipe(res);
        return;
      }
      const buf = await r.buffer();
      res.set("Content-Type", "audio/wav");
      res.set("Content-Length", String(buf.length));
      res.set("Cache-Control", "no-store");
      return res.send(buf);
    } catch (e) {
      console.error("[/api/admin/chat/speak] error:", e?.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // --- セッション管理API（管理者専用・ChatGPT風セッション機能） ---
  // POST /api/admin/chat/sessions  → 新規セッション作成 {r18?} → {id}
  // GET  /api/admin/chat/sessions  → セッション一覧（新しい順、各履歴プレビュー付き）
  // GET  /api/admin/chat/sessions/:id → メッセージ一覧
  // PATCH /api/admin/chat/sessions/:id → タイトル変更 {title}
  // DELETE /api/admin/chat/sessions/:id → 削除
  app.post("/api/admin/chat/sessions", adminAuth.requireAuth, async (req, res) => {
    try {
      const r18 = !!req.body?.r18 ? 1 : 0;
      const result = await dbRun(
        db,
        "INSERT INTO chat_sessions (admin_user, title, r18) VALUES (?, NULL, ?)",
        [req.adminUser, r18]
      );
      const id = result.lastID;
      // 移行用：既存メッセージ配列があれば取り込む（localStorage 旧履歴の移行）
      const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
      for (const m of msgs) {
        const role = m.role === "user" ? "user" : "assistant";
        const content = (m.content || "").toString().slice(0, 6000);
        if (!content) continue;
        const srcJson = Array.isArray(m.sources) ? JSON.stringify(m.sources.slice(0, 5)) : null;
        await dbRun(db,
          "INSERT INTO chat_messages (session_id, role, content, sources_json) VALUES (?,?,?,?)",
          [id, role, content, srcJson]
        );
      }
      if (msgs.length && !(req.body?.title)) {
        const first = msgs.find(m => m.role === "user");
        if (first && first.content) {
          await dbRun(db, "UPDATE chat_sessions SET title = ? WHERE id = ?", [String(first.content).slice(0, 30), id]);
        }
      }
      res.json({ id, r18: !!r18 });
    } catch (e) {
      console.error("[/api/admin/chat/sessions POST] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/chat/sessions", adminAuth.requireAuth, async (req, res) => {
    try {
      const sessions = await dbAll(
        db,
        `SELECT cs.id, cs.title, cs.r18, cs.updated_at,
           (SELECT content FROM chat_messages cm WHERE cm.session_id = cs.id
             AND cm.role = 'assistant' ORDER BY cm.id DESC LIMIT 1) AS preview,
           (SELECT COUNT(*) FROM chat_messages cm WHERE cm.session_id = cs.id) AS msg_count
         FROM chat_sessions cs
         WHERE cs.admin_user = ?
         ORDER BY cs.updated_at DESC`,
        [req.adminUser]
      );
      res.json({
        sessions: (sessions || []).map((s) => ({
          id: s.id,
          title: s.title || "新しいチャット",
          r18: !!s.r18,
          updated_at: s.updated_at,
          preview: s.preview || "",
          msg_count: s.msg_count || 0,
        })),
      });
    } catch (e) {
      console.error("[/api/admin/chat/sessions GET] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/chat/sessions/:id", adminAuth.requireAuth, async (req, res) => {
    try {
      const session = await dbGet(db, "SELECT id, title, r18 FROM chat_sessions WHERE id = ? AND admin_user = ?", [req.params.id, req.adminUser]);
      if (!session) return res.status(404).json({ error: "session not found" });
      const messages = await dbAll(
        db,
        "SELECT role, content, sources_json FROM chat_messages WHERE session_id = ? ORDER BY id ASC",
        [session.id]
      );
      res.json({
        id: session.id,
        title: session.title,
        r18: !!session.r18,
        messages: messages.map((m) => {
          let sources = [];
          try { sources = JSON.parse(m.sources_json || "[]"); } catch {}
          return { role: m.role, content: m.content, sources };
        }),
      });
    } catch (e) {
      console.error("[/api/admin/chat/sessions/:id GET] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/admin/chat/sessions/:id", adminAuth.requireAuth, async (req, res) => {
    try {
      const title = (req.body?.title || "").toString().trim();
      if (!title) return res.status(400).json({ error: "title required" });
      const result = await dbRun(
        db,
        "UPDATE chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND admin_user = ?",
        [title.slice(0, 60), req.params.id, req.adminUser]
      );
      if (!result.changes) return res.status(404).json({ error: "session not found" });
      res.json({ ok: true });
    } catch (e) {
      console.error("[/api/admin/chat/sessions/:id PATCH] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/chat/sessions/:id", adminAuth.requireAuth, async (req, res) => {
    try {
      const result = await dbRun(
        db,
        "DELETE FROM chat_sessions WHERE id = ? AND admin_user = ?",
        [req.params.id, req.adminUser]
      );
      if (!result.changes) return res.status(404).json({ error: "session not found" });
      await dbRun(db, "DELETE FROM chat_messages WHERE session_id = ?", [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error("[/api/admin/chat/sessions/:id DELETE] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  // R18好み（だーりんのお願い）の取得・保存。
// 共通（全セッションで1組・chat_prefs）:
//   GET  /api/admin/chat/prefs → { prefs }
//   PUT  /api/admin/chat/prefs { likes, dislikes, scene, call }
// セッション個別（無ければ共通へフォールバック）:
//   GET /api/admin/chat/sessions/:id/prefs → { prefs }
//   PUT /api/admin/chat/sessions/:id/prefs → セッション個別 + 共通の両方に同期保存
  app.get("/api/admin/chat/prefs", adminAuth.requireAuth, async (req, res) => {
    try {
      const prefs = await getGlobalPrefs(db, req.adminUser);
      res.json({ prefs: prefs || {} });
    } catch (e) {
      console.error("[/api/admin/chat/prefs GET] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/admin/chat/prefs", adminAuth.requireAuth, async (req, res) => {
    try {
      const clean = cleanPrefs(req.body);
      await saveGlobalPrefs(db, req.adminUser, clean);
      res.json({ ok: true, prefs: clean });
    } catch (e) {
      console.error("[/api/admin/chat/prefs PUT] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/chat/sessions/:id/prefs", adminAuth.requireAuth, async (req, res) => {
    try {
      const session = await dbGet(db, "SELECT prefs FROM chat_sessions WHERE id = ? AND admin_user = ?", [req.params.id, req.adminUser]);
      if (!session) return res.status(404).json({ error: "session not found" });
      let prefs = {};
      try { prefs = JSON.parse(session.prefs || "{}"); } catch {}
      if (session.prefs) {
        res.json({ prefs, custom: true });
      } else {
        const g = await getGlobalPrefs(db, req.adminUser);
        res.json({ prefs: g || {}, custom: false });
      }
    } catch (e) {
      console.error("[/api/admin/chat/sessions/:id/prefs GET] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/admin/chat/sessions/:id/prefs", adminAuth.requireAuth, async (req, res) => {
    try {
      const clean = cleanPrefs(req.body);
      const result = await dbRun(
        db,
        "UPDATE chat_sessions SET prefs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND admin_user = ?",
        [JSON.stringify(clean), req.params.id, req.adminUser]
      );
      if (!result.changes) return res.status(404).json({ error: "session not found" });
      await saveGlobalPrefs(db, req.adminUser, clean);
      res.json({ ok: true, prefs: clean });
    } catch (e) {
      console.error("[/api/admin/chat/sessions/:id/prefs PUT] error:", e?.message);
      res.status(500).json({ error: e.message });
    }
  });

  // 公開（後方互換・必要なら削除可）※ R18モードは管理者専用のため公開側では無効
  // LLMコスト・負荷対策：公開側は専用の厳しい制限（5回/分）＋質問500文字上限。管理者用 /api/admin/ask は対象外。
  const askLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: "Too many ask requests, please try again later." } });
  app.post("/api/ask", askLimiter, (req, res) => {
    const q = (req.body?.question || req.body?.q || "").toString();
    if (q.trim().length > 500) return res.status(400).json({ error: "question too long (max 500 chars)" });
    return handleAsk(req, res, false);
  });
}

module.exports = { register };