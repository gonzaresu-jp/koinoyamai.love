#!/usr/bin/env node
// まいちゃんのツイート統計CLI
// 使い方: node scripts/tools/twitter-stats.js [--json]
//   --json  … data/twitter-stats.json にも書き出す
// 出力: DB（notifications）の全ツイート + logs/gemma.log の分析ラベルを集計する。
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const { getStats } = require("../../services/twitter-stats");

const writeJson = process.argv.includes("--json");
const OUT_PATH = path.join(__dirname, "../..", "data", "twitter-stats.json");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../..", "data.db");

function fmtPct(v) { return v == null ? "-" : v.toFixed(1) + "%"; }

async function main() {
  const db = new sqlite3.Database(DB_PATH);
  const s = await getStats(db);
  db.close();

  console.log("＝ まいちゃんツイート統計 ＝");
  console.log(`期間: ${s.range.from ?? "-"} 〜 ${s.range.to ?? "-"}   総数: ${s.total} 件 (Main ${s.main} / Sub ${s.sub})`);
  console.log(`リポスト: ${s.repost}  画像付き: ${s.withImage} (${fmtPct((s.withImage / (s.total || 1)) * 100)})`);
  console.log(`平均文字数: ${s.chars.avg} / 最長: ${s.chars.max}`);
  console.log("\n▶ 時間帯（JST・投稿数 Top10）");
  const h = s.hours.map((n, i) => [i, n]).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [h1, n] of h) console.log(`   ${String(h1).padStart(2)}時: ${"#".repeat(Math.min(40, Math.round((n / (h[0][1] || 1)) * 40)))} ${n}`);
  console.log("\n▶ 曜日別");
  s.weekdays.forEach((n, i) => console.log(`   ${s.weekdaysJa[i]}: ${n}`));
  console.log("\n▶ 月別投稿数");
  for (const [m, n] of Object.entries(s.months)) console.log(`   ${m}: ${n}`);
  console.log("\n▶ リンクカテゴリ率");
  for (const [k, n] of Object.entries(s.links)) console.log(`   ${k}: ${n} (${fmtPct((n / (s.total || 1)) * 100)})`);
  console.log("\n▶ フレーズ使用率");
  for (const [k, n] of Object.entries(s.phrases)) console.log(`   ${k}: ${n} (${fmtPct((n / (s.total || 1)) * 100)})`);
  if (s.tags.length) {
    console.log("\n▶ ハッシュタグ Top");
    for (const t of s.tags) console.log(`   ${t.tag}: ${t.count}`);
  }
  console.log("\n▶ Gemma/Gemini 分析ラベル");
  console.log(`   被分析: ${s.analysis.assigned}/${s.total} (${fmtPct(s.analysis.coverage)}) [data保存 ${s.analysis.fromData} + ログ照合 ${s.analysis.fromLog}]`);
  console.log(`   配信告知率(LIVE): ${fmtPct(s.analysis.liveRate)}`);
  const cats = Object.entries(s.analysis.categories).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of cats) console.log(`   category ${k}: ${n}`);
  const sens = Object.entries(s.analysis.sentiment).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of sens) console.log(`   sentiment ${k}: ${n} (${fmtPct((n / (s.analysis.assigned || 1)) * 100)})`);
  console.log("\n▶ 月別感情傾向（POSITIVE率・ns=avg sentiment）");
  const sentimentScore = { POSITIVE: 1, NEUTRAL: 0, NEGATIVE: -1 };
  const monthSent = Object.entries(s.analysis.byMonth).sort();
  const barFor = (slot) => {
    const t = slot.POSITIVE + slot.NEUTRAL + slot.NEGATIVE;
    if (!t) return "        ";
    const p = slot.POSITIVE / t, g = slot.NEUTRAL / t, b = slot.NEGATIVE / t;
    return `+${(p * 10).toFixed(0)}${" ".repeat(Math.round(g * 10))}${(b * 10) <= 0.05 ? "" : "-"}`.padEnd(12);
  };
  for (const [m, slot] of monthSent) {
    const t = slot.POSITIVE + slot.NEUTRAL + slot.NEGATIVE;
    const ns = Math.round((slot.POSITIVE * 1 + slot.NEGATIVE * -1) / t * 100) / 100;
    console.log(`   ${m}: ${barFor(slot)} ±${ns.toFixed(2)}  (+${slot.POSITIVE} / -${slot.NEGATIVE} / ${slot.NEUTRAL})`);
  }
  console.log("\n▶ 時間帯別感情傾向（± = POSITIVE-NEGATIVEインデックス）");
  const hourSent = Object.entries(s.analysis.byHour).map(([h, slot]) => {
    const t = slot.POSITIVE + slot.NEUTRAL + slot.NEGATIVE;
    return [Number(h), slot, Math.round((slot.POSITIVE - slot.NEGATIVE) / t * 100) / 100, t];
  }).filter(x => x[3] > 0).sort((a, b) => a[2] - b[2]);
  for (const [hh, slot, ns, t] of hourSent) console.log(`   ${String(hh).padStart(2)}時: ±${ns >= 0 ? "+" : ""}${ns.toFixed(2)}  (${slot.POSITIVE}+ / ${slot.NEGATIVE}- / ${slot.NEUTRAL}±${t}件)`);
  console.log("\n▶ 曜日別感情傾向");
  for (const d of [0, 1, 2, 3, 4, 5, 6]) {
    const slot = s.analysis.byWeekday[d];
    if (!slot) continue;
    const t = slot.POSITIVE + slot.NEUTRAL + slot.NEGATIVE;
    const ns = Math.round((slot.POSITIVE - slot.NEGATIVE) / t * 100) / 100;
    console.log(`   ${s.weekdaysJa[d]}: ±${ns >= 0 ? "+" : ""}${ns.toFixed(2)}  (+${slot.POSITIVE} / -${slot.NEGATIVE} / ${slot.NEUTRAL}±·${t}件)`);
  }
  console.log("\n▶ カテゴリ別感情傾向");
  {
    const catLabels = { LIVE: "配信", DAILY: "雑談", NEWS: "お知らせ", PROMOTION: "グッズ", MORNING: "あいさつ", OTHER: "その他", REPOST: "リポスト" };
    const pairs = Object.entries(s.analysis.byCategory).sort((a, b) => b[1].POSITIVE + b[1].NEGATIVE - (a[1].POSITIVE + a[1].NEGATIVE));
    for (const [k, slot] of pairs) {
      const t = slot.POSITIVE + slot.NEUTRAL + slot.NEGATIVE;
      const ns = Math.round((slot.POSITIVE - slot.NEGATIVE) / t * 100) / 100;
      console.log(`   ${catLabels[k] || k}: ±${ns >= 0 ? "+" : ""}${ns.toFixed(2)}  (+${slot.POSITIVE} / -${slot.NEGATIVE} / ${slot.NEUTRAL}±·${t})`);
    }
  }
  console.log("\n▶ 文字数分布");
  for (const [k, n] of Object.entries(s.chars.buckets)) console.log(`   ${k}: ${n}`);

  if (writeJson) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(s, null, 2));
    console.log(`\nJSON written: ${OUT_PATH}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
