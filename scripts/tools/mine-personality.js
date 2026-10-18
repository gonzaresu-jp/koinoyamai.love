// mine-personality.js
// 配信アーカイブ字幕（.70 /api/transcript/:id）から「会話行動パターン」を統計抽出する
// デモ消費を抑えるため有限サンプル（MINER_SAMPLE 本、デフォルト 24）を最新映像から等間隔に選び、
// 口調・語尾・相槌・質問返し・感情表現などの頻度と実例（verbatim）を集計して JSON で出力する。
// 出力先: personality-mined-report.json（同スクリプト実行時の状態を保存）
// 使い方: node scripts/tools/mine-personality.js [> personality-mined-report.json]

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const ARCHIVE_API_BASE = (process.env.ARCHIVE_API_BASE || "http://192.168.1.70:8766").replace(/\/+$/, "");
const SAMPLE = Math.max(4, Math.min(60, parseInt(process.env.MINER_SAMPLE || "24", 10)));
const PER_VIDEO_FETCH_MS = parseInt(process.env.MINER_TIMEOUT_MS || "45000", 10);
const OUT = path.join(__dirname, "../..", "personality-mined-report.json");

async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function norm(s) {
  return String(s || "")
    .replace(/\r/g, "")
    .replace(/[。...…]+/g, " ")   // 文境界を空白に
    .replace(/[ \t]+/g, " ")
    .trim();
}

// 文（センテンス）単位にばらす
function sentencesOf(text) {
  return norm(text)
    .split(/[。！？\n]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2 && s.length <= 80);
}

// パターン定義: key -> { re, label }。ここは「実際の発言・行動」カテゴリ。
const CATEGORIES = {
  greeting:  { re: /^(こんばんは|こんばんわ|こんにちは|おはよう|やっほー?|こんゆー|いらっしゃい|ようこそ|ええっと|どうもこんばん)/ },
  agreement: { re: /(なるほど|そうそう|そうだよね|そうだね|うんうん|それな|ですよね|だよね|確かに)/ },
  surprise:  { re: /(ええー|えーっ|えっ|わー|うわ|きゃ|へー|まじで|え、まじ|うそ|マジ)/ },
  laugh:     { re: /(えへへ|ふふ|くすくす|うふふ|ぷぷ|んふふ)/ },
  filler:    { re: /^(えーと|うーんと|んー|うーん|あー|あのー?|えっと|んー、)/ },
  self_ref:  { re: /(私は|私ね|私が|私も|私って|あたし|私の|私には|私はね)/ },
  question:  { re: /(〜?かな[ぁ-ゖ]?[?？]?$|どう思う|どうなの|知ってる|してる[?？]|みんなは|だーりんは|みなさんは|〜じゃない[?？]?$|どうしよう)/ },
  topic_shift: { re: /(そういえば|といえば|ちなみに|そうだそうだ|あとね|あと、|話変わる|ところで)/ },
  joy:       { re: /(嬉し|楽しい|たのし|大好き|すきー|好きです|ワクワク|ドキドキ|わーい|やった)/ },
  sad_shy:   { re: /(悲し|寂し|恥ずかし|照れ|緊張|ドキドキ|びっくりし|泣い|ぴえん)/ },
  praise:    { re: /(すごい|えらい|上手|上手く|うまい|すてき|かわいい|可愛い|素敵|天才)/ },
  tease:     { re: /(いじ|ちょちょい|ぷく|むぐ|うるさい|ばか|馬鹿|やだあ|ぱぁあ)/ },
  address:   { re: /(みんな|リスナー|皆さん|みなさん|だーりん|ダーリン|みんてぃ)/ },
};

// 語尾スタイル（文末）
const ENDINGS = [
  { key: "da_yo", re: /だよ[„。!！]*$/ },
  { key: "da_ne", re: /だね[„。!！]*$/ },
  { key: "na_no", re: /なの[„。!！]*$/ },
  { key: "da_zo", re: /だぞ[„。!！]*$/ },
  { key: "desu",  re: /です[。!！]*$/ },
  { key: "masu",  re: /ます[。!！]*$/ },
  { key: "ndayo", re: /んだよ[„。!！]*$/ },
  { key: "shiteru", re: /してる[„。!！]*$/ },
];

// 名詞っぽい断片で頻出語を集める（話題の厚みと好みの間接指標）
const TOPIC_STOP = new Set([
  "まい", "まいちゃん", "恋乃夜まい", "みんな", "ちょっと", "なんか", "これ", "それ", "あれ",
  "こんばんわ", "です", "ます", "今日", "いい", "ますね", "ですね", "さん", "ちゃん",
]);
function extractNouns(text) {
  const out = [];
  for (const m of text.matchAll(/[\u4e00-\u9fff]{2,4}|[ぁ-ん]{2,6}|[ァ-ヶ]{2,6}|[A-Za-z]{2,}/g)) {
    const t = m[0];
    if (TOPIC_STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

async function analyzeTranscript(vid) {
  const d = await getJson(`${ARCHIVE_API_BASE}/api/transcript/${vid}`, PER_VIDEO_FETCH_MS);
  if (!d || !d.text) throw new Error(`no text for ${vid}`);
  const text = String(d.text);
  const sents = sentencesOf(text);
  const counters = {};
  for (const k of Object.keys(CATEGORIES)) counters[k] = 0;
  const endCount = {};
  for (const e of ENDINGS) endCount[e.key] = 0;
  const examples = {};
  const nouns = [];

  for (const s of sents) {
    for (const [k, c] of Object.entries(CATEGORIES)) {
      if (c.re.test(s)) {
        counters[k]++;
        if ((examples[k] || []).length < 8 && s.length <= 30) (examples[k] = examples[k] || []).push(s);
      }
    }
    for (const e of ENDINGS) if (e.re.test(s)) endCount[e.key]++;
    nouns.push(...extractNouns(s));
  }

  const nounFreq = {};
  for (const n of nouns) nounFreq[n] = (nounFreq[n] || 0) + 1;

  return {
    video_id: vid,
    chars: text.length,
    sentences: sents.length,
    counters,
    endCount,
    topNouns: Object.entries(nounFreq).filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 30),
    examples,
  };
}

(async () => {
  const started = new Date().toISOString();
  console.error(`[miner] fetching ${ARCHIVE_API_BASE}/api/videos?limit=100`);
  const list = await getJson(`${ARCHIVE_API_BASE}/api/videos?limit=100`, 30000);
  const videos = list.videos || [];
  if (!videos.length) throw new Error("no videos in list");
  console.error(`[miner] ${videos.length} videos fetched`);

  // 最新100から等間隔に SAMPLE 本（最初の最新数本も含む）
  const idxs = new Set();
  idxs.add(0);
  for (let i = 1; i < SAMPLE; i++) idxs.add(Math.floor((i * (videos.length - 1)) / (SAMPLE - 1)));
  const picks = [...idxs].sort((a, b) => a - b).map((i) => videos[i]);

  const results = [];
  let ok = 0, fail = 0;
  for (const v of picks) {
    try {
      console.error(`[miner] transcript ${v.video_id} (${v.title || ""})...`);
      const r = await analyzeTranscript(v.video_id);
      r.title = v.title;
      r.stream_date_jst = v.stream_date_jst;
      results.push(r);
      ok++;
    } catch (e) {
      console.error(`[miner]   FAIL ${v.video_id}: ${e.message}`);
      fail++;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  // 集計
  const agg = {};
  for (const k of Object.keys(CATEGORIES)) agg[k] = 0;
  const aggEnd = {};
  for (const e of ENDINGS) aggEnd[e.key] = 0;
  let totalChars = 0, totalSents = 0;
  const allExamples = {};
  const nounAgg = {};
  for (const r of results) {
    totalChars += r.chars; totalSents += r.sentences;
    for (const k of Object.keys(CATEGORIES)) agg[k] += r.counters[k];
    for (const e of ENDINGS) aggEnd[e.key] += r.endCount[e.key];
    for (const [k, arr] of Object.entries(r.examples)) (allExamples[k] = allExamples[k] || []).push(...arr);
    for (const [n, c] of r.topNouns) nounAgg[n] = (nounAgg[n] || 0) + c;
  }

  const per10k = {};
  for (const k of Object.keys(CATEGORIES)) per10k[k] = totalChars ? Number(((agg[k] / totalChars) * 10000).toFixed(1)) : 0;
  const rate = {};
  for (const k of Object.keys(CATEGORIES)) rate[k] = totalSents ? Number(((agg[k] / totalSents) * 100).toFixed(1)) : 0;

  const report = {
    generated_at: started,
    sample: { n: results.length, tried: picks.length, failed: fail, total_archived: videos.length, scope: "latest 100 videos, evenly sampled" },
    corpus: { chars: totalChars, sentences: totalSents, avg_chars_per_video: results.length ? Math.round(totalChars / results.length) : 0 },
    per_10k_chars: per10k,
    percent_of_sentences: rate,
    sentence_endings: { counts: aggEnd, total_sentences: totalSents },
    top_nouns: Object.entries(nounAgg).sort((a, b) => b[1] - a[1]).slice(0, 40),
    examples: Object.fromEntries(Object.entries(allExamples).map(([k, arr]) => [k, [...new Set(arr)].slice(0, 12)])),
    videos: results.map(({ video_id, title, stream_date_jst, chars, sentences }) => ({ video_id, title, stream_date_jst, chars, sentences })),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.error(`[miner] wrote ${OUT} (ok=${ok} fail=${fail})`);
  process.stdout.write(JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error("[miner] fatal:", e);
  process.exit(1);
});