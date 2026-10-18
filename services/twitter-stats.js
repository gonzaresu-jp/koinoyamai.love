// まいちゃんのツイート統計の共通ライブラリ。
// admin API (routes/admin-twitter-stats.js) と CLI (scripts/tools/twitter-stats.js) の両方から使う。
// 入力は2系統:
//   1) notifications テーブル（全ツイート・時刻・画像 flag・リポスト）
//   2) logs/gemma.log（Gemma/Gemini 分析ログ category/sentiment。2026-04 時点の分以上）
//   3) notifications.data に保存された分析結果（今後の新着向け）
const fs = require("fs");
const path = require("path");

const GEMMA_LOG_PATH = path.join(__dirname, "..", "logs", "gemma.log");
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];
const LINK_DEFS = [
  ["booth", /booth\.pm|booth\.jp/i],
  ["dlsite", /dlsite\.com/i],
  ["youtube", /youtube\.com|youtu\.be/i],
  ["twitcasting", /twitcasting\.tv/i],
  ["twitch", /twitch\.tv/i],
  ["fanbox", /fanbox\.cc/i],
  ["gipt", /gi-pt\.com/i],
];
const PHRASE_DEFS = [
  ["だーりん", /だーりん|だ−りん/],
  ["おはよう", /おはよう|おはよ[ぅ〜～]/],
  ["こんばんは", /こんばんは/],
  ["ちゅっちゅ", /ちゅっ?ちゅ|ちゅー/],
  ["甘えたいぬ", /甘えたいぬ|あまえたいぬ/],
  ["みんな／リスナー", /リスナーさん|みんな|皆さん/],
];

function normalizeBody(s) {
  return String(s || "").replace(/\s+/g, " ").trim().replace(/…$/, "");
}

// gemma.log を解析して [{ts, body, category, sentiment, start_time, title}] を返す。
// 「Analyzing tweet: <本文>」（複数行含む）と 10秒以内に続く「Analysis result: {json}」
// （または旧形式「Result: category=…」）を1組として対応させる。
function parseGemmaLog() {
  const out = [];
  let raw = "";
  try { raw = fs.readFileSync(GEMMA_LOG_PATH, "utf8"); } catch { return out; }
  const re = /\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] \[(Gemma|Gemini)\]/g;
  const marks = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    marks.push({ idx: m.index, ts: Date.parse(m[0].slice(1, 25)) });
  }
  let pending = null;
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].idx : raw.length;
    const seg = raw.slice(marks[i].idx, end);
    const ts = marks[i].ts;
    const resMatch = /Analysis result: (\{[\s\S]*?\})/.exec(seg);
    const oldMatch = /Result: category=([A-Z_]+), status=([A-Z_]+), start_time=(null|\d{2}:\d{2})/.exec(seg);
    const anMatch = /Analyzing tweet: ([\s\S]*)/.exec(seg);
    if (resMatch) {
      let j = null;
      try { j = JSON.parse(resMatch[1]); } catch { j = null; }
      if (pending) {
        // 対応するAnalyzing tweet行（旧ローカルGemmaは数十秒かかることもあるため時間制限なし）
        out.push({
          ts: pending.ts,
          body: pending.body,
          category: j?.category || null,
          sentiment: j?.sentiment || null,
          start_time: j?.start_time || null,
          title: j?.title || null,
        });
        pending = null;
      } else if (j) {
        // Analyzing 行が無い古い形式（本文不明・集計のみ）
        out.push({ ts, body: null, category: j.category || null, sentiment: j.sentiment || null, start_time: j.start_time || null, title: j.title || null });
      }
    } else if (oldMatch && pending) {
      out.push({
        ts,
        body: pending.body,
        category: oldMatch[1],
        sentiment: null,
        start_time: oldMatch[3] === "null" ? null : oldMatch[3],
        title: null,
      });
      pending = null;
    } else if (anMatch) {
      pending = { ts, body: anMatch[1] };
    }
  }
  return out;
}

// UTC文字列 "YYYY-MM-DD HH:mm:ss" をJST成分に分解
function jstParts(utcStr) {
  const d = new Date(String(utcStr).replace(" ", "T") + "Z");
  if (isNaN(d)) return null;
  const j = new Date(d.getTime() + 9 * 3600 * 1000); // naive JST
  const pad = (n) => String(n).padStart(2, "0");
  return {
    hour: j.getUTCHours(),
    weekday: j.getUTCDay(),
    month: `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}`,
    date: `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`,
    ms: d.getTime(),
  };
}

function bump(map, key) {
  if (key == null) return;
  map[key] = (map[key] || 0) + 1;
}

// 本体集計。rows: notifications の行配列、loggedPairs: parseGemmaLog() の結果。
function aggregate(rowsInput, loggedPairs) {
  const rows = Array.isArray(rowsInput) ? rowsInput : [];
  const logged = Array.isArray(loggedPairs) ? loggedPairs : [];
  const stats = {
    generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    range: { from: null, to: null },
    total: 0, main: 0, sub: 0, repost: 0, withImage: 0,
    hours: new Array(24).fill(0),
    weekdays: new Array(7).fill(0),
    weekdaysJa: WEEKDAYS_JA,
    months: {},
    links: {},
    chars: { avg: 0, max: 0, buckets: { "0-20": 0, "21-50": 0, "51-100": 0, "101-140": 0, "140+": 0 } },
    phrases: {},
    tags: [],
    analysis: { assigned: 0, coverage: 0, categories: {}, sentiment: {}, fromData: 0, fromLog: 0,
      // 感情ラベルの交差集計（いつ何時にポジティブ/ネガティブが多いか）
      byMonth: {}, byHour: {}, byWeekday: {}, byCategory: {} },
  };
  const sentiKeys = ["POSITIVE", "NEUTRAL", "NEGATIVE"];
  const sentiSlot = (obj, key) => {
    if (!obj[key]) obj[key] = { POSITIVE: 0, NEUTRAL: 0, NEGATIVE: 0 };
    return obj[key];
  };
  for (const l of LINK_DEFS) stats.links[l[0]] = 0;
  for (const p of PHRASE_DEFS) stats.phrases[p[0]] = 0;

  // gemma.log ペア（startTs=分析開始時刻を別途保持。通知insert時刻と±3分で照合する）
  const loggedNorm = logged
    .map(p => ({ ...p, norm: p.body ? normalizeBody(p.body).slice(0, 120) : "", used: false }))
    .sort((a, b) => a.ts - b.ts);

  let charSum = 0;
  let charMax = 0;
  const tagMap = {};
  for (const row of rows) {
    stats.total++;
    if (row.platform === "twitterMain") stats.main++; else stats.sub++;
    const text = normalizeBody(row.body);
    const title = String(row.title || "");
    if (title.includes("リポスト")) stats.repost++;
    if (row.image) stats.withImage++;
    const p = jstParts(row.created_at);
    if (p) {
      stats.hours[p.hour]++;
      stats.weekdays[p.weekday]++;
      bump(stats.months, p.month);
      if (!stats.range.from || p.date < stats.range.from) stats.range.from = p.date;
      if (!stats.range.to || p.date > stats.range.to) stats.range.to = p.date;
    }
    const textPlus = text + " " + String(row.url || "");
    for (const l of LINK_DEFS) if (l[1].test(textPlus)) stats.links[l[0]]++;
    const n = text.length;
    charSum += n;
    if (n > charMax) charMax = n;
    const bucket = n <= 20 ? "0-20" : n <= 50 ? "21-50" : n <= 100 ? "51-100" : n <= 140 ? "101-140" : "140+";
    stats.chars.buckets[bucket]++;
    for (const ph of PHRASE_DEFS) if (ph[1].test(row.body)) stats.phrases[ph[0]]++;
    for (const tg of String(row.body + " " + title).match(/#[^\s#]+/g) || []) {
      const key = tg.slice(0, 40);
      tagMap[key] = (tagMap[key] || 0) + 1;
    }
    // 分析ラベル: data に保存されたもの→ gemma.log 本文照合
    let category = null, sentiment = null, src = null;
    if (row.data) {
      try {
        const d = JSON.parse(row.data);
        if (d && d.category) { category = d.category; sentiment = d.sentiment || null; src = "data"; }
      } catch {}
    }
    if (!category) {
      let hit = loggedNorm.find(L => !L.used && L.norm && text.slice(0, 120) === L.norm);
      if (!hit && p) {
        // 本文照合できなければ 時刻（通知insert時刻 ≒ 分析開始時刻）で ±3分の最も近い未使用ペアに割当
        const win = 3 * 60 * 1000;
        for (const L of loggedNorm) {
          if (L.used) continue;
          if (L.ts >= p.ms - win && L.ts <= p.ms + win) { hit = L; break; }
        }
      }
      if (hit) { hit.used = true; category = hit.category; sentiment = hit.sentiment; src = "log"; }
    }
    if (category) {
      stats.analysis.assigned++;
      if (src === "data") stats.analysis.fromData++; else stats.analysis.fromLog++;
      bump(stats.analysis.categories, category);
      if (sentiment) bump(stats.analysis.sentiment, sentiment);
      if (sentiment && sentiKeys.includes(sentiment) && p) {
        sentiSlot(stats.analysis.byMonth, p.month)[sentiment]++;
        sentiSlot(stats.analysis.byHour, p.hour)[sentiment]++;
        sentiSlot(stats.analysis.byWeekday, p.weekday)[sentiment]++;
      }
      if (sentiment && sentiKeys.includes(sentiment)) {
        sentiSlot(stats.analysis.byCategory, category)[sentiment]++;
      }
    }
  }
  if (stats.total > 0) {
    stats.chars.avg = Math.round((charSum / stats.total) * 10) / 10;
  }
  stats.chars.max = charMax;
  const tagArr = Object.entries(tagMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
  stats.tags = tagArr.map(([tag, n]) => ({ tag, count: n }));
  if (stats.total > 0) {
    stats.analysis.coverage = Math.round((stats.analysis.assigned / stats.total) * 1000) / 10;
    stats.analysis.liveRate = Math.round(((stats.analysis.categories.LIVE || 0) / stats.total) * 1000) / 10;
  }
  return stats;
}

// 1行ずつ分析ラベルを付けて返す（aggregate と同じ照合: data → gemma.log 本文一致 → ±3分）。
// mai-state.js（活動傾向の推定）が使う。
function labelRows(rowsInput, loggedPairs) {
  const rows = Array.isArray(rowsInput) ? rowsInput : [];
  const loggedNorm = (Array.isArray(loggedPairs) ? loggedPairs : [])
    .map(p => ({ ...p, norm: p.body ? normalizeBody(p.body).slice(0, 120) : "", used: false }))
    .sort((a, b) => a.ts - b.ts);
  return rows.map(row => {
    const text = normalizeBody(row.body);
    const p = jstParts(row.created_at);
    let category = null, sentiment = null, status = null;
    if (row.data) {
      try {
        const d = JSON.parse(row.data);
        if (d && d.category) { category = d.category; sentiment = d.sentiment || null; status = d.status || null; }
      } catch {}
    }
    if (!category) {
      let hit = loggedNorm.find(L => !L.used && L.norm && text.slice(0, 120) === L.norm);
      if (!hit && p) {
        const win = 3 * 60 * 1000;
        hit = loggedNorm.find(L => !L.used && L.ts >= p.ms - win && L.ts <= p.ms + win);
      }
      if (hit) { hit.used = true; category = hit.category; sentiment = hit.sentiment; }
    }
    return { created_at: row.created_at, platform: row.platform, body: row.body, category, sentiment, status };
  });
}

module.exports = {
  labelRows,
  parseGemmaLog,
  aggregate,
  jstParts,
  getStats(db) {
    return new Promise((resolve) => {
      db.all(
        `SELECT body, created_at, platform, tweet_id, image, title, url, data
           FROM notifications
          WHERE platform IN ("twitterMain","twitterSub")
          ORDER BY created_at ASC`,
        (err, rows) => {
          const logged = parseGemmaLog();
          resolve(aggregate(err ? [] : (rows || []), logged));
        }
      );
    });
  },
};
