'use strict';
// AI 使用量の集計 API（status ページ用）
//
// 現時点で取れる値を1箇所にまとめる:
//   - Cloudflare Workers AI : tmp/minutes_neurons_state.json（実測の neurons 使用量と予算）
//   - Gemini / Groq         : logs/gemma.log のパース（呼び出し回数・429・予備切替）
//                             + services/ai-quota.js が保存したレート制限ヘッダと usage
//   - まいAIチャット        : chat_messages（role='assistant'）
//   - 要約                : video_minutes
//   - Whisper 字幕          : video_whisper_segments
//
// ログ（197KB・ローテ無し）とDBを毎回読むと重いため60秒キャッシュする。
// 公開ページから呼ぶため、API キー類は一切返さない（数値とクォータ系ヘッダのみ）。

const fs = require("fs");
const path = require("path");
const aiQuota = require("../services/ai-quota");

const ROOT = path.join(__dirname, "..");
const GEMMA_LOG = path.join(ROOT, "logs", "gemma.log");
const NEURON_STATE = path.join(ROOT, "tmp", "minutes_neurons_state.json");

// scripts/ops/minutes-gen.js の既定値と合わせる（無料枠10,000のうち安全マージン込み）
const CF_FREE_TIER = 10000;
const CF_BUDGET = Math.min(parseFloat(process.env.CF_NEURON_BUDGET || "9500"), CF_FREE_TIER);

const CACHE_MS = 60 * 1000;
let cache = null;
let cacheAt = 0;

function parseGemmaLog() {
  const out = { calls: 0, results: 0, errors429: 0, fallback: 0, lastAt: null, daily: {} };
  let raw;
  try {
    raw = fs.readFileSync(GEMMA_LOG, "utf8");
  } catch (e) {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (line.indexOf("Analyzing tweet") !== -1) {
      out.calls += 1;
      const m = /^\[(\d{4}-\d{2}-\d{2})T/.exec(line);
      if (m) {
        out.daily[m[1]] = (out.daily[m[1]] || 0) + 1;
        out.lastAt = line.slice(1, 20).replace("T", " ");
      }
    } else if (line.indexOf("Analysis result") !== -1) {
      out.results += 1;
    }
    if (line.indexOf("Gemini API 429") !== -1) out.errors429 += 1;
    if (line.indexOf("予備モデル") !== -1) out.fallback += 1;
  }
  return out;
}

function readNeuronState() {
  try {
    const s = JSON.parse(fs.readFileSync(NEURON_STATE, "utf8"));
    const used = Number(s && s.used) || 0;
    const day = (s && s.day) || null;
    const stale = day ? day !== new Date().toISOString().slice(0, 10) : false;
    return {
      day,
      used: Math.round(used * 10) / 10,
      budget: CF_BUDGET,
      freeTier: CF_FREE_TIER,
      // UTC日が変わっている間は昨日の値を残しているだけなので明示する
      remaining: stale ? null : Math.max(0, Math.round((CF_BUDGET - used) * 10) / 10),
      pct: Math.min(100, Math.round((used / CF_BUDGET) * 1000) / 10),
      stale,
    };
  } catch (e) {
    return { day: null, used: 0, budget: CF_BUDGET, freeTier: CF_FREE_TIER, remaining: null, pct: 0, stale: true };
  }
}

function dailyLast7(daily) {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ date: d, count: daily[d] || 0 });
  }
  return out;
}

function query(db, sql, params = []) {
  return new Promise((resolve) => {
    db.all(sql, params, (err, rows) => resolve(err ? [] : rows || []));
  });
}

async function buildPayload(db) {
  const gemma = parseGemmaLog();
  const quota = aiQuota.read();
  const providers = (quota && quota.providers) || {};

  const chatRows = await query(db,
    `SELECT date(created_at) AS d, count(*) AS c FROM chat_messages
     WHERE role = 'assistant' AND date(created_at) >= date('now','-6 days')
     GROUP BY d`);
  const chatTotal = await query(db,
    `SELECT count(*) AS c FROM chat_messages WHERE role = 'assistant'`);
  const minutesVideos = await query(db, `SELECT count(DISTINCT video_id) AS c FROM video_minutes`);
  const minutesDaily = await query(db,
    `SELECT date(created_at) AS d, count(DISTINCT video_id) AS c FROM video_minutes
     WHERE date(created_at) >= date('now','-6 days') GROUP BY d`);
  const whisper = await query(db,
    `SELECT count(*) AS segs, sum(end_ms - start_ms) AS ms FROM video_whisper_segments`);
  const whisperModels = await query(db,
    `SELECT model, count(*) AS c FROM video_whisper_segments GROUP BY model`);

  const last7 = (rows) => {
    const map = {};
    for (const r of rows) map[r.d] = Number(r.c) || 0;
    return dailyLast7(map);
  };

  const cf = readNeuronState();

  return {
    updatedAt: new Date().toISOString(),
    cloudflare: cf,
    gemini: {
      calls: gemma.calls,
      results: gemma.results,
      errors429: gemma.errors429,
      fallback: gemma.fallback,
      lastCallAt: gemma.lastAt,
      daily: dailyLast7(gemma.daily),
      // ai-quota が保存したヘッダ（取得できていれば）
      headers: (providers.gemini && providers.gemini.headers) || null,
      usage: (providers.gemini && providers.gemini.usage) || null,
      statuses: (providers.gemini && providers.gemini.statuses) || null,
      recordedAt: (providers.gemini && providers.gemini.at) || null,
    },
    groq: {
      headers: (providers.groq && providers.groq.headers) || null,
      statuses: (providers.groq && providers.groq.statuses) || null,
      calls: (providers.groq && providers.groq.calls) || 0,
      usage: (providers.groq && providers.groq.usage) || null,
      recordedAt: (providers.groq && providers.groq.at) || null,
    },
    chat: {
      total: Number((chatTotal[0] && chatTotal[0].c) || 0),
      daily: last7(chatRows),
    },
    minutes: {
      videos: Number((minutesVideos[0] && minutesVideos[0].c) || 0),
      daily: last7(minutesDaily),
    },
    whisper: {
      segments: Number((whisper[0] && whisper[0].segs) || 0),
      seconds: Math.round(Number((whisper[0] && whisper[0].ms) || 0) / 1000),
      models: whisperModels.map(m => ({ model: m.model, segments: Number(m.c) || 0 })),
    },
    meta: {
      cfNote: "Workers AI は無料枠 10,000 neurons/日（UTC 00:00 リセット）",
      quotaNote: "Gemini/Groq の残量はレート制限ヘッダを保存している分のみ表示",
    },
  };
}

function register(app, db) {
  // GET /api/ai-usage — status ページ用（公開・数値のみ）
  app.get("/api/ai-usage", async (req, res) => {
    try {
      if (cache && Date.now() - cacheAt < CACHE_MS) {
        return res.json(cache);
      }
      const payload = await buildPayload(db);
      cache = payload;
      cacheAt = Date.now();
      res.json(payload);
    } catch (e) {
      console.error("[ai-usage] build failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { register };
