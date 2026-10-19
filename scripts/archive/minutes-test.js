// 要約生成の品質確認（単体・非デプロイ版）
// nassy 字幕 → チャンク → Gemini flash-lite 要約 → console 出力
require("dotenv").config({ path: "/var/www/html/koinoyamai.love/.env" });
const fetch = require("node-fetch");
const path = require("path");

const ARCHIVE_API_BASE = process.env.ARCHIVE_API_BASE || "http://192.168.1.70:8766";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.MINUTES_MODEL || "gemini-3.5-flash-lite";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const CHUNK_MS = 300 * 1000; // 5分チャンク

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
      cur = { start: start, end: end, segs: [] };
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
        "あなたは配信の文字起こしから「要約」を作るアシスタントです。与えられた字幕区間から、" +
        "まいちゃん(恋乃夜まい)が話した話題・明言した事実（好きなもの、エピソード、意見、予定、人間関係など）を抽出します。" +
        "自動字幕なので誤字・誤認識が含まれますが、文脈から意味を推測して要点をまとめてください。" +
        "必ず有効なJSON配列を1つだけ出力してください。Markdownのコードブロックや余計な説明は不要です。\n" +
        '形式: [{"start_ms": ミリ秒, "end_ms": ミリ秒, "topic": "話題タイトル", "facts": ["事実1", "事実2"], "detail": "この区間の1〜3文の要約"}]',
    },
    { role: "user", content: `区間字幕（各行頭は先頭の [HH:MM:SS] 開始時刻）:\n${text}` },
  ];
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GEMINI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 2048 }),
    timeout: 90000,
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

(async () => {
  const videoId = process.argv[2] || "Ak6V6rckBXU";
  const t = await getTranscript(videoId);
  console.log("meta:", t.meta?.title, "| segs:", t.meta?.segment_count || t.segments.length);
  const chunks = chunkSegments(t.segments, CHUNK_MS);
  console.log("chunks:", chunks.length);
  const sample = chunks[3];
  console.log("=== sample chunk [", fmtJst(sample.start), "-", fmtJst(sample.end), "] segs:", sample.segs.length);
  const out = await summarize(sample);
  console.log("=== SUMMARY OUTPUT ===");
  console.log(out);
  console.log("=== parse check ===");
  try {
    const parsed = JSON.parse(out);
    console.log("valid JSON, items:", parsed.length);
  } catch (e) {
    console.log("INVALID JSON:", e.message);
  }
})();