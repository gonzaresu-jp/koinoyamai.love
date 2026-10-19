#!/usr/bin/env node
/*
 * render-compare-html.js — GROQ不要の自完結HTML比較レンダラ
 *   node render-compare-html.js --recent 3 --html /var/www/html/koinoyamai.love/webui/compare.html
 *   node render-compare-html.js --vids "id1 id2" --html out.html --bucket-sec 30
 *
 * 表示: YT字幕 と 自前(Whisper)字幕 を時間バケット行×2列のテーブルで横並び比較
 * データ源:
 *   - video_whisper_segments (SQLite data.db)   ← 自前字幕
 *   - archive API {ARCHIVE_API_BASE}/api/transcript/:videoId → YT字幕
 *   - {ARCHIVE_API_BASE}/api/videos (直近一覧; --recent)
 */
require("dotenv").config({ path: __dirname + "/../../.env" });
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");

const DB_PATH = process.env.RAG_DB_PATH || path.join(__dirname, "../..", "data.db");
const ARCHIVE_API_BASE = (process.env.ARCHIVE_API_BASE || "http://192.168.1.70:8766").replace(/\/+$/, "");
const BUCKET_SEC = parseInt(process.env.COMPARE_BUCKET_SEC || "30", 10);

const dbOpen = () => new Promise((res, rej) => {
  const db = new sqlite3.Database(DB_PATH, (e) => (e ? rej(e) : res(db)));
});
const dbAll = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchJson(url, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 30000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleepMs(1000 * (i + 1));
    }
  }
  throw last || new Error("fetch failed");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtMs(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}`;
}

// 30sバケット → { idx: { start, end, yt[], whisper[] } }
function bucketize(wsegs, ysegs, bucketMs) {
  const map = new Map();
  const push = (arr, s, key) => {
    const start = Number(s.start_ms) || 0;
    const text = String(s.text || "").trim();
    if (!text) return;
    const idx = Math.floor(start / bucketMs);
    let b = map.get(idx);
    if (!b) { b = { idx, start: idx * bucketMs, end: (idx + 1) * bucketMs, yt: [], whisper: [] }; map.set(idx, b); }
    b[key].push({ start, end: Number(s.end_ms) || start + 1000, text });
  };
  for (const s of wsegs) push(wsegs, s, "whisper");
  for (const s of ysegs) push(ysegs, s, "yt");
  const rows = [...map.values()].sort((a, b) => a.idx - b.idx);
  return rows;
}

async function fetchVideos(recent) {
  const j = await fetchJson(`${ARCHIVE_API_BASE}/api/videos?limit=100&sort=stream_at_desc`);
  return (j.videos || []).slice(0, recent || 3);
}

async function renderCompareHtml(db, outPath, recent) {
  const reps = [];
  let videos = [];
  try { videos = await fetchVideos(recent); } catch (e) { console.warn("[videos] " + e.message); }
  if (!videos.length) {
    const rows = await dbAll(db,
      "SELECT video_id, MAX(created_at) t FROM video_whisper_segments GROUP BY video_id ORDER BY t DESC LIMIT ?", [recent]);
    videos = rows.map((r) => ({ video_id: r.video_id }));
  }
  for (const v of videos) {
    const id = v.video_id;
    if (!id) continue;
    const whisper = await dbAll(db,
      "SELECT start_ms, end_ms, text FROM video_whisper_segments WHERE video_id=? ORDER BY start_ms", [id]);
    const yt = await fetchJson(`${ARCHIVE_API_BASE}/api/transcript/${id}`).catch(() => ({ segments: [] }));
    const ysegs = (yt.segments || []).filter((s) => s && String(s.text || "").trim());
    reps.push({
      video_id: id,
      title: v.title || v.channel_title || id,
      channel: v.channel_title || v.channel_id || "",
      wsegs: whisper, ysegs,
      wn: whisper.length, yn: ysegs.length,
    });
    console.log(`[ok] ${id} whisper=${whisper.length} yt=${ysegs.length}`);
  }
  if (!reps.length) throw new Error("no videos to render");

  const bucketSec = Number(process.argv.find((a) => a === "--bucket-sec") ? process.argv[process.argv.indexOf("--bucket-sec") + 1] : 0) || BUCKET_SEC;
  const html = buildHtml(reps, bucketSec * 1000);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`wrote ${outPath} (${html.length} bytes, ${reps.length} videos)`);
  return reps.length;
}

function buildHtml(reps, bucketMs) {
  const esc = escapeHtml;
  const sections = reps.map((r) => {
    const rows = bucketize(r.wsegs, r.ysegs, bucketMs);
    const trs = rows.map((b) => {
      const ytText = esc(b.yt.map((s) => s.text).join("<br>"));
      const wText = esc(b.whisper.map((s) => s.text).join("<br>"));
      return `<tr data-has="${b.yt.length && b.whisper.length ? 1 : 0}">
<td class="t">${fmtMs(b.start)}</td>
<td class="yt">${ytText || '<span class="na">—</span>'}</td>
<td class="w">${wText || '<span class="na">—</span>'}</td>
</tr>`;
    }).join("");
    return `<section data-video="${esc(r.video_id)}">
<h2><a class="vid" href="https://www.youtube.com/watch?v=${esc(r.video_id)}" target="_blank" rel="noopener">${esc(r.title)}</a> <span class="vidid">${esc(r.video_id)}</span></h2>
<div class="meta">YT字幕: <b>${r.yn}</b> 行 ／ Whisper: <b>${r.wn}</b> 行 ／ ${Math.round(bucketMs / 1000)}s バケット</div>
<div class="tblwrap"><table>
<tr><th class="t">時刻</th><th class="yt">YouTube字幕</th><th class="w">Whisper(自前)</th></tr>
${trs}
</table></div>
</section>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YT字幕 vs Whisper字幕 比較 (${esc(String(new Date()).slice(0, 21))})</title>
<link rel="stylesheet" href="/css/compare.css" />
</head>
<body>
<header>
  <input type="search" id="q" placeholder="両字幕を横断検索">
  <button id="btnBoth">両方そろった行のみ</button>
  <span class="meta" id="stats" style="margin:0"></span>
  <h1>YouTube字幕 vs Whisper字幕（${Math.round(bucketMs / 1000)}sバケット・横並び）</h1>
</header>
${sections}
<script src="/js/compare-filter.js"></script>
</body>
</html>`;
}

function parseArgs(argv) {
  const a = { vids: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--vids") a.vids = String(argv[++i] || "").trim().split(/\s+/).filter(Boolean);
    else if (t === "--recent") a.recent = parseInt(argv[++i], 10);
    else if (t === "--html") a.html = argv[++i];
    else if (t === "--bucket-sec") a.bucketSec = parseInt(argv[++i], 10);
    else if (t === "--out") a.out = argv[++i];
    else a.vids.push(t);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.html || args.out;
  if (!out) { console.error("--html <出力パス> が必要"); process.exit(1); }
  if (!args.vids.length && !args.recent) { console.error("--vids か --recent が必要"); process.exit(1); }
  const db = await dbOpen();
  const reps = [];
  try {
    let videos = [];
    if (args.vids.length) {
      videos = args.vids.map((id) => ({ video_id: id, title: id, channel: "" }));
    } else if (args.recent) {
      videos = await fetchVideos(args.recent);
    }
    for (const v of videos) {
      const id = v.video_id;
      if (!id) continue;
      const whisper = await dbAll(db,
        "SELECT start_ms, end_ms, text FROM video_whisper_segments WHERE video_id=? ORDER BY start_ms", [id]);
      const yt = await fetchJson(`${ARCHIVE_API_BASE}/api/transcript/${id}`).catch(() => ({ segments: [] }));
      const ysegs = (yt.segments || []).filter((s) => s && String(s.text || "").trim());
      if (!whisper.length && !ysegs.length) { console.warn("skip empty: " + id); continue; }
      reps.push({
        video_id: id,
        title: v.title || v.channel_title || id,
        channel: (v.channel_title || v.channel_id || ""),
        wsegs: whisper, ysegs,
        wn: whisper.length, yn: ysegs.length,
      });
    }
    if (!reps.length) { throw new Error("no data to render"); }
    const bucketSec = args.bucketSec || BUCKET_SEC;
    const html = buildHtml(reps, bucketSec * 1000);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, html, "utf8");
    console.log(`wrote ${out} (${html.length} bytes, ${reps.length} videos)`);
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });