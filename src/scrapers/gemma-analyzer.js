const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const aiQuota = require('../../services/ai-quota');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'gemma.log');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function writeLog(level, ...args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(arg => (arg instanceof Error ? (arg.stack || arg.message) : (typeof arg === 'object' ? JSON.stringify(arg) : arg))).join(' ');
  const logLine = `[${timestamp}] [${level}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, logLine); } catch (e) { }
}

const gemmaLogger = {
  log: (...args) => { console.log(...args); writeLog('INFO', ...args); },
  warn: (...args) => { console.warn(...args); writeLog('WARN', ...args); },
  error: (...args) => { console.error(...args); writeLog('ERROR', ...args); }
};

// --- Gemini API 向け設定（ローカルllama.cpp負荷削減のためAPIへ移行） ---
const SERVER_ENDPOINT = process.env.TWITTER_AI_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = process.env.TWITTER_AI_MODEL || "gemini-3.5-flash-lite";
const API_KEY = process.env.GEMINI_API_KEY || "";
const REQUEST_TIMEOUT = 60000; // API駆動のため短めに
const RETRY_TIMES = 3;
const RETRY_DELAY_MS = 1500;

// Gemini の上限（429）に当たったときの予備（Groq・OpenAI互換）。キー未設定なら使わない
const FALLBACK_ENDPOINT = process.env.TWITTER_AI_FALLBACK_URL || "https://api.groq.com/openai/v1/chat/completions";
const FALLBACK_MODEL = process.env.TWITTER_AI_FALLBACK_MODEL || "qwen/qwen3.8-27b";
const FALLBACK_API_KEY = process.env.TWITTER_AI_FALLBACK_KEY || process.env.GROQ_API_KEY || "";

async function callFallback(prompt) {
  if (!FALLBACK_API_KEY) throw new Error("fallback not configured");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(FALLBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FALLBACK_API_KEY}`, 'User-Agent': 'mai-push/1.0' },
      body: JSON.stringify({
        model: FALLBACK_MODEL,
        messages: [
          { role: "system", content: "あなたはツイート解析AIです。JSON形式でのみ回答してください。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        // 出力上限を小さく・推論（thinking）を止める。Groq 無料枠は出力トークン/分の上限が小さく、
        // 既定の max_tokens のままだと 1 回のリクエストで上限超過（429 Request too large）になる
        max_tokens: 400,
        reasoning_effort: "none",
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      aiQuota.record('groq', response, null, {
        kind: 'tweet-analysis-fallback', model: FALLBACK_MODEL, error: `HTTP ${response.status}`,
      });
      throw new Error(`fallback API ${response.status}: ${detail.slice(0, 200)}`);
    }
    const data = await response.json();
    aiQuota.record('groq', response, data, { kind: 'tweet-analysis-fallback', model: FALLBACK_MODEL });
    // 推論モデルの  <think>...</think> は取り除く
    return (data.choices[0].message.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Gemini API へのリクエストを実行（OpenAI互換エンドポイント）
 */
async function callAiServer(prompt, retries = RETRY_TIMES) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY not configured");
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response = null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      response = await fetch(SERVER_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: "あなたはツイート解析AIです。JSON形式でのみ回答してください。" },
            { role: "user", content: prompt }
          ],
          temperature: 0.1,
          response_format: { type: "json_object" } // JSON専用出力
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // 429 の時こそヘッダ（残量）が要るので、失敗時も必ず記録する
        aiQuota.record('gemini', response, null, {
          kind: 'tweet-analysis', model: MODEL, error: `HTTP ${response.status}`,
        });
        throw new Error(`Gemini API ${response.status}: ${detail.slice(0, 200)}`);
      }

      const data = await response.json();
      aiQuota.record('gemini', response, data, { kind: 'tweet-analysis', model: MODEL });
      return (data.choices[0].message.content || "").trim();
    } catch (err) {
      lastError = err;
      if (!response) aiQuota.record('gemini', null, null, {
        kind: 'tweet-analysis', model: MODEL, error: err.message,
      });
      // 429（1日の上限など）は数秒待っても回復しないので、リトライせず予備のモデルへ切り替える
      if (/Gemini API 429/.test(String(err && err.message)) && FALLBACK_API_KEY) {
        gemmaLogger.warn(`[Gemini] 上限(429)のため予備モデル ${FALLBACK_MODEL} で解析します`);
        return await callFallback(prompt);
      }
      if (attempt < retries) {
        const delay = RETRY_DELAY_MS * Math.pow(1.5, attempt);
        gemmaLogger.warn(`[Gemini] リトライ ${attempt + 1}/${retries}: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    }
  }
  throw lastError;
}

/**
 * ツイート分析メインロジック
 */
async function analyzeTweet(tweetText) {
  if (!tweetText) return getFallbackResult();

  const prompt = `以下のツイートから情報を抽出してください。

【「配信」の定義】
- ここでいう配信は、YouTube・ツイキャス・Twitch・Bilibili などの動画配信サービスでのライブ配信のこと
- X（Twitter）上での活動は配信ではない: リプ返（リプライへの返信）・いいね回り・ツイートでの企画・アンケート・画像や動画の投稿予告
- グッズやボイスの発売・受付開始、動画の公開予告（プレミア公開を除く）も配信ではない
- 例: 「14時からリプ返するね」→ category=DAILY, status=NONE, start_time=null
- 例: 「14時からごごまい配信するよ」→ category=LIVE, status=LIVE_SOON, start_time="14:00"

【カテゴリ】(必須: いずれか1つ)
- LIVE: 配信開始・配信予告・配信予定に関するツイート（上の定義の「配信」のみ）
- NEWS: お知らせ・更新・発表
- PROMOTION: 宣伝・告知
- REPOST: RT・引用リツイート
- MORNING: おはようツイート
- DAILY: 日常・雑談
- OTHER: 上記以外

【配信状態 status】(必須: いずれか1つ)
- LIVE_NOW: 「今から配信します」「配信スタート」など、今すぐ始まることを示す
- LIVE_SOON: 「〇〇時から配信します」「今夜〇時〜」など、近い将来の配信予告（時刻があっても配信でなければ NONE）
- TIME_CHANGE: 「〇〇時だったが〇〇時に変更」など、時刻変更の告知
- NONE: 配信に関係ない、または時刻が全く分からない

【start_time】
- 配信の開始時刻が具体的にあれば HH:MM 形式で抽出（例: "21:00"）。配信以外の予定の時刻は入れない
- 時刻が不明または配信と無関係なら null

【time_period】(具体的な時刻が無い配信予告のときの時間帯)
- 「今夜」「夜」など → "NIGHT"
- 「深夜」「真夜中」など → "LATE_NIGHT"
- 「夕方」など → "EVENING"
- 「お昼」「昼」「ごご」「午後」など → "NOON"
- 「朝」「午前」など → "MORNING"
- 時間帯が分からない、または配信と無関係なら null

【previous_time】
- 時刻変更の場合、変更前の時刻を HH:MM 形式で抽出
- なければ null

【title】
- ツイートに明示されている配信タイトル・企画名があれば抽出（例: "雑談配信"、"歌枠"）
- タイトルが分からない場合は null

【sentiment】
- POSITIVE: 喜び・興奮・感謝
- NEUTRAL: 普通の報告・お知らせ
- NEGATIVE: 謝罪・延期・中止

【confidence】
- 分析の確信度 0.0〜1.0

出力は以下のJSON形式のみで回答してください。説明文は不要です:
{
  "category": "",
  "status": "",
  "start_time": null,
  "time_period": null,
  "previous_time": null,
  "title": null,
  "sentiment": "",
  "confidence": 0.0
}

ツイート:
${tweetText}`;

  try {
    // ツイート本文は最大100文字で省略プレビューにし、[1234Z] [INFO] [Gemini] Analyzing tweet: で出力
    const previewText = tweetText.length > 100 ? tweetText.substring(0, 100) + '...' : tweetText;
    gemmaLogger.log(`[Gemini] Analyzing tweet: ${previewText}`);
    
    const response = await callAiServer(prompt);

    // コードブロック記法 (```json ... ```) を除去してからJSONを抽出
    const cleaned = response
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '');

    // 最初の { から対応する } までを正確に取り出す（ネスト対応）
    let jsonStr = null;
    const start = cleaned.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') {
          depth--;
          if (depth === 0) {
            jsonStr = cleaned.slice(start, i + 1);
            break;
          }
        }
      }
    }

    if (!jsonStr) {
      gemmaLogger.error('[Gemini] JSON not found in response. raw:', response.slice(0, 300));
      return getFallbackResult();
    }

    const result = JSON.parse(jsonStr);
    
    // 分析結果をそのままJSON形式で出力
    gemmaLogger.log(`[Gemini] Analysis result: ${JSON.stringify(result)}`);

    return {
      category: validateEnum(result.category, ['LIVE', 'NEWS', 'PROMOTION', 'REPOST', 'MORNING', 'DAILY', 'OTHER'], 'OTHER'),
      status: validateEnum(result.status, ['LIVE_NOW', 'LIVE_SOON', 'TIME_CHANGE', 'NONE'], 'NONE'),
      start_time: result.start_time || null,
      time_period: validateEnum(result.time_period, ['MORNING', 'NOON', 'EVENING', 'NIGHT', 'LATE_NIGHT'], null),
      previous_time: result.previous_time || null,
      title: result.title || null,
      sentiment: validateEnum(result.sentiment, ['POSITIVE', 'NEUTRAL', 'NEGATIVE'], 'NEUTRAL'),
      confidence: Math.min(1, Math.max(0, parseFloat(result.confidence) || 0))
    };
  } catch (err) {
    gemmaLogger.error('[Gemini] Analysis failed:', err.message);
    return getFallbackResult();
  }
}

// --- 補助関数群（元のロジックを完全維持） ---

function getFallbackResult() {
  return { category: 'OTHER', status: 'NONE', start_time: null, time_period: null, previous_time: null, title: null, sentiment: 'NEUTRAL', confidence: 0 };
}

function validateEnum(value, validValues, defaultValue) {
  return (value && validValues.includes(value)) ? value : defaultValue;
}

function extractUrlsFromTweet(text) {
  if (!text) return [];
  const urlRegex = /https?:\/\/[^\s]+/g;
  return Array.from(new Set(text.match(urlRegex) || []));
}

// 時刻未定の配信予告で使う、時間帯ごとの既定時刻（必要に応じて編集可）。
// 環境変数 PERIOD_TIMES（例: "NIGHT=22:00,NOON=12:00"）で上書き可能。
const PERIOD_DEFAULT_TIMES = {
  MORNING:    '09:00', // 朝・午前
  NOON:       '12:00', // 昼・ごご・午後
  EVENING:    '18:00', // 夕方
  NIGHT:      '22:00', // 夜・今夜
  LATE_NIGHT: '23:00', // 深夜
};
(function applyPeriodTimeOverrides() {
  const raw = process.env.PERIOD_TIMES;
  if (!raw) return;
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map(s => (s || '').trim());
    if (k && /^\d{1,2}:\d{2}$/.test(v) && k in PERIOD_DEFAULT_TIMES) {
      PERIOD_DEFAULT_TIMES[k] = v;
    }
  }
})();

/**
 * ツイート本文から時間帯を推定する（Gemma の time_period が空のときのフォールバック）。
 * 配信予告という前提で呼ばれるため、汎用的な「夜」等もマッチさせる。
 */
function detectPeriodFromText(text) {
  if (!text) return null;
  if (/深夜|真夜中/.test(text)) return 'LATE_NIGHT';
  if (/今夜|今晩|夜の部|夜から|夜に|ナイト|tonight/i.test(text)) return 'NIGHT';
  if (/夕方|夕刻|イブニング/.test(text)) return 'EVENING';
  if (/お昼|ごご|ごごまい|正午|午後|ランチ|昼/.test(text)) return 'NOON';
  if (/午前|モーニング|朝/.test(text)) return 'MORNING';
  return null;
}

// ツイート本文中の「〇曜日」「〇曜」表記から曜日インデックス（0=日〜6=土）を検出する。
// 「毎週火曜12:00~」のように具体的な時刻と一緒に曜日が明記されているのに、
// 従来は時刻（HH:MM）しか抽出対象にしておらず、日付は「投稿日 or 翌日」という
// 機械的なロジックだけで決めていたため、明記された曜日と食い違う日に
// 予定が登録されてしまう不具合があった（例: 火曜日の告知が月曜日に登録される）。
const WEEKDAY_INDEX = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
function detectWeekdayFromText(text) {
  if (!text) return null;
  const m = String(text).match(/([日月火水木金土])曜/);
  return m ? WEEKDAY_INDEX[m[1]] : null;
}

// Date → "YYYY-MM-DDTHH:MM:SS"（ローカル=JST、UTC変換なし）。管理画面の保存形式と揃える。
function formatNaiveLocal(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// X 上だけの活動（リプ返など）の言葉。配信を示す言葉が無いのにこれがある場合は予定を作らない。
// 2026-09-24「14時から一気に返し始める（リプ返）」を AI が LIVE_SOON と判定し、配信予定が作られた。
const X_ONLY_ACTIVITY_RE = /リプ返|リプライ|りぷ返|返信(します|するね|するよ|していく)|いいね回り|ふぁぼ回り/;
const STREAM_HINT_RE = /配信|枠|生放送|放送|ライブ|LIVE|youtu\.?be|twitcas|ツイキャス|twitch|bilibili|歌枠|ASMR|雑談|ゲーム|実況|コラボ|ごごまい|晩酌|待機|スペース/i;

function isXOnlyActivity(text) {
  const t = String(text || '');
  return X_ONLY_ACTIVITY_RE.test(t) && !STREAM_HINT_RE.test(t);
}

function extractScheduleFromAnalysis(analysis, tweetDate, urls = [], tweetText = '', quoteInfo = null) {
  // status が配信系（LIVE_NOW/SOON/CHANGE）なら category が NEWS でもスケジュール作成
  if (analysis.status === 'NONE') return null;
  // 配信URLが無く、本文が X 上だけの活動（リプ返等）なら AI の判定に関わらず登録しない
  const hasStreamUrl = (urls || []).some(u => /youtu\.?be|twitcasting|twitch\.tv|bilibili/i.test(String(u)));
  if (!hasStreamUrl && isXOnlyActivity(tweetText)) {
    gemmaLogger.warn('[Gemini] X上の活動（リプ返等）と判断したため予定を作りません:', String(tweetText).slice(0, 60));
    return null;
  }

  // 具体的な時刻があればそれを使う。無ければ時間帯を解決し、
  // 曜日配置・並び順のための代表時刻（PERIOD_DEFAULT_TIMES）を内部的に当てる。
  // 画面表示は time_period（"夜"等）で行うため、この代表時刻は表示されない。
  let timeStr = analysis.start_time;
  let resolvedPeriod = null;
  if (!timeStr) {
    // detectPeriodFromText() を最優先（「ごご」→NOON 等の明確なパターン）。
    // AI の time_period は誤検出が多い（例: ごごまい枠を NIGHT と判定）ため
    // フォールバックとして扱う。
    const period = detectPeriodFromText(tweetText) || analysis.time_period;
    if (period && PERIOD_DEFAULT_TIMES[period]) {
      timeStr = PERIOD_DEFAULT_TIMES[period];
      resolvedPeriod = period;
    }
  }
  if (!timeStr) return null; // 具体時刻も時間帯も取れない → 登録しない（従来通り）
  const timeEstimated = !!resolvedPeriod;

  const [hh, mm] = timeStr.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return null;

  const scheduleDate = new Date(tweetDate);
  scheduleDate.setHours(hh, mm, 0, 0);
  // 「翌日繰り上げ」は具体的な時刻（analysis.start_time）が明示された場合のみ行う。
  // time_period からの推定時刻（例: "おはよう"のような挨拶語をMORNINGと誤検出するケース）は
  // 実際にその時間帯に配信する確約ではないため、繰り上げると「翌日（例: 土曜日）」に
  // 存在しない予定が生成される。推定時刻の場合は当日のまま登録する。
  if (!resolvedPeriod && scheduleDate < tweetDate) scheduleDate.setDate(scheduleDate.getDate() + 1);

  // ツイート本文に「〇曜日」の明記があり、上記ロジックで決まった日付の曜日と
  // 食い違う場合は、明記された曜日を優先して直近の該当日（当日〜6日後）に補正する。
  // 「毎週火曜12:00~」のような定期告知が、投稿タイミング次第で誤った曜日
  // （例: 月曜日）に登録されてしまう問題を防ぐ。
  const mentionedWeekday = detectWeekdayFromText(tweetText);
  if (mentionedWeekday !== null && scheduleDate.getDay() !== mentionedWeekday) {
    const base = new Date(tweetDate);
    base.setHours(hh, mm, 0, 0);
    for (let i = 0; i < 7; i++) {
      const candidate = new Date(base);
      candidate.setDate(base.getDate() + i);
      if (candidate.getDay() === mentionedWeekday) {
        scheduleDate.setFullYear(candidate.getFullYear(), candidate.getMonth(), candidate.getDate());
        break;
      }
    }
  }

  // YouTube は本人チャンネルが youtube.js で個別に監視されており、ツイートから
  // 二重登録されるのを防ぐため通常はスキップする。ただし引用（コラボ）の場合は
  // 相手チャンネルの配信になるため youtube.js では検知できず、ここでの登録が必要。
  const isYouTube = urls.some(u => u.includes('youtube.com') || u.includes('youtu.be')) || 
                    (analysis.title && (analysis.title.toLowerCase().includes('youtube') || analysis.title.includes('待機所')));
  if (isYouTube && !quoteInfo) return null;

  let primaryUrl;
  let platform;
  if (quoteInfo) {
    // コラボ（引用）: 相手チャンネルの配信URLを優先して選ぶ（YouTube/Twitch/ツイキャス/Bilibili）。
    // x.com のリンクは告知文の中にしか無かった場合の最後の手段にする。
    primaryUrl = urls.find(u => /youtu\.?be|youtube\.com/i.test(u))
      || urls.find(u => u.includes('twitch.tv'))
      || urls.find(u => u.includes('twitcasting.tv'))
      || urls.find(u => u.includes('bilibili.com'))
      || urls.find(u => !/x\.com|twitter\.com/i.test(u))
      || urls[0] || null;
    platform = !primaryUrl ? 'twitter'
      : /youtu\.?be|youtube\.com/i.test(primaryUrl) ? 'youtube'
      : primaryUrl.includes('twitch') ? 'twitch'
      : primaryUrl.includes('twitcasting') ? 'twitcasting'
      : primaryUrl.includes('bilibili') ? 'bilibili'
      : 'twitter';
  } else {
    primaryUrl = urls.find(u => u.includes('twitch.tv')) || urls.find(u => u.includes('twitcasting.tv')) || urls[0] || null;
    platform = primaryUrl ? (primaryUrl.includes('twitch') ? 'twitch' : (primaryUrl.includes('twitcasting') ? 'twitcasting' : 'twitter')) : 'twitter';
  }

  let title = analysis.title || (analysis.status === 'LIVE_NOW' ? 'ライブ配信中' : '配信予定');
  // 引用（コラボ）由来の予定は相手アカウントをタイトルに明記する。
  // コラボの明示がある場合は【コラボ】ラベルも付ける（引用＝常にコラボとは限らないため）。
  if (quoteInfo && quoteInfo.user && !title.includes(quoteInfo.user)) {
    const isCollabMention = /コラボ|collab|ご一緒|一緒に/i.test(tweetText || '');
    title = `${isCollabMention ? '【コラボ】' : ''}${title}（@${quoteInfo.user}）`;
  }

  return {
    title,
    // ナイーブJST文字列で保存（管理画面と同形式）。toISOString()のUTC保存は
    // 曜日配置・時刻表示が9時間ずれる原因になるため使わない。TZ=Asia/Tokyo前提。
    scheduled_at: formatNaiveLocal(scheduleDate),
    url: primaryUrl,
    platform: platform,
    sentiment: analysis.sentiment,
    status: analysis.status,
    time_estimated: timeEstimated,
    time_period: resolvedPeriod // "NIGHT"等。具体時刻ありなら null（時刻表示）
  };
}

// 時間帯（NIGHT等）→ 代表時刻（HH:MM）。未知なら null。
function periodToTime(period) {
  if (typeof period !== 'string') return null;
  return PERIOD_DEFAULT_TIMES[period.toUpperCase()] || null;
}

module.exports = { analyzeTweet, extractScheduleFromAnalysis, extractUrlsFromTweet, periodToTime, PERIOD_DEFAULT_TIMES, isXOnlyActivity };