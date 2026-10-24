/**
 * YouTube アーカイブ検索 API のリバースプロキシ
 *
 * 実体は別ホスト (192.168.1.70:8766) で動く api.py（SQLite FTS5 + ひらがな正規化）。
 * このホストからは到達できるが公開されていないため、ここで同一オリジンに中継する。
 * 詳細: 恋乃夜まい_YT_Data/API_HANDOVER.md
 *
 *   GET /api/archive/videos?category=&limit=&offset=&sort=
 *   GET /api/archive/search?q=&kind=&category=&limit=&offset=
 *   GET /api/archive/video/:id
 *   GET /api/archive/stats
 *   GET /api/archive/thumbnail/:id
 *   GET /api/archive/buzzwords?year=&top=  →  GET /api/buzzwords?year=&top= (公開プロキシ)
 */

const ctx = require("../services/context");

const ARCHIVE_API_BASE = (process.env.ARCHIVE_API_BASE || "http://192.168.1.70:8766").replace(/\/+$/, "");

const JSON_TIMEOUT_MS = 12000;
const SEARCH_TIMEOUT_MS = 25000;
const THUMB_TIMEOUT_MS = 15000;

// 上流は単一プロセスの Python HTTP サーバなので、短時間の再問い合わせはキャッシュで吸収する
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;
const cache = new Map();

// --- ヘルスチェック / サーキットブレーカー ---
// 上流がダウンしていると検知したら、毎回のフルタイムアウト待ちを避けて即座にフォールバックする
const HEALTH_TTL_MS = 15000; // ヘルス状態を保持する時間
const upstreamState = { healthy: null, checkedAt: 0 };

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  // LRU: 参照したものを末尾に回す
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

/** 期限切れでも古い値を返す（上流ダウン時のフォールバック用） */
function cacheGetStale(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/** 上流が「直近にダウンと判定された」状態か（cooldown 中なら true） */
function isUpstreamDown() {
  if (upstreamState.healthy === false && Date.now() - upstreamState.checkedAt < HEALTH_TTL_MS) return true;
  return false;
}

function markUpstream(healthy, err) {
  upstreamState.healthy = healthy;
  upstreamState.checkedAt = Date.now();
  if (!healthy) upstreamState.lastError = String((err && err.message) || err);
}

/** 上流の /api/health を短タイムアウトで確認し状態を更新する */
async function refreshHealth() {
  try {
    const res = await fetchUpstream("/api/health", 3000);
    markUpstream(res.ok, res.ok ? null : new Error(`HTTP ${res.status}`));
  } catch (err) {
    markUpstream(false, err);
  }
}

async function fetchUpstream(pathWithQuery, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(ARCHIVE_API_BASE + pathWithQuery, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 上流がダウンしている場合に、利用可能なら stale キャッシュ、なければ null を返す */
function serveStaleOrNull(res, cacheKey) {
  const stale = cacheGetStale(cacheKey);
  if (stale) {
    res.set("X-Archive-Cache", "STALE");
    return res.status(stale.status).json(stale.body);
  }
  return null;
}

/** 上流の JSON をキャッシュ付きで中継する */
async function proxyJson(res, pathWithQuery, { timeoutMs = JSON_TIMEOUT_MS, useCache = true } = {}) {
  if (useCache) {
    const cached = cacheGet(pathWithQuery);
    if (cached) {
      res.set("X-Archive-Cache", "HIT");
      return res.status(cached.status).json(cached.body);
    }
  }

  // ダウン cooldown 中はフルタイムアウトを避けて即座にフォールバック
  if (useCache && isUpstreamDown()) {
    const stale = serveStaleOrNull(res, pathWithQuery);
    if (stale) return stale;
    return res.status(503).json({ error: "アーカイブAPIが現在利用できません（前回の接続失敗から復旧待ち）" });
  }

  let upstream;
  try {
    upstream = await fetchUpstream(pathWithQuery, timeoutMs);
  } catch (err) {
    markUpstream(false, err);
    const aborted = err && err.name === "AbortError";
    // ダウン時は stale があればそれを返す
    const stale = useCache ? serveStaleOrNull(res, pathWithQuery) : null;
    if (stale) return stale;
    return res.status(aborted ? 504 : 502).json({
      error: aborted ? "アーカイブAPIがタイムアウトしました" : "アーカイブAPIに接続できません",
      detail: String((err && err.message) || err),
    });
  }

  // 成功したらヘルス状態を復旧させる
  markUpstream(true, null);

  let body;
  try {
    body = await upstream.json();
  } catch {
    return res.status(502).json({ error: "アーカイブAPIの応答を解釈できません" });
  }

  if (useCache && upstream.ok) cacheSet(pathWithQuery, { status: upstream.status, body });
  res.set("X-Archive-Cache", "MISS");
  return res.status(upstream.status).json(body);
}

/** クエリから許可したキーだけを取り出して上流へ渡す */
function pickQuery(req, keys) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = req.query[key];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(Array.isArray(value) ? value[0] : value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function register(app) {
  app.get("/api/archive/health", async (req, res) => {
    await refreshHealth();
    const body = { status: upstreamState.healthy ? "ok" : "down", upstream: upstreamState.healthy ? "ok" : "down", checkedAt: upstreamState.checkedAt };
    const status = upstreamState.healthy ? 200 : 503;
    res.set("Access-Control-Allow-Origin", "*");
    return res.status(status).json(body);
  });

  app.get("/api/archive/stats", async (req, res) => {
    await proxyJson(res, "/api/stats");
  });

  app.get("/api/archive/videos", async (req, res) => {
    await proxyJson(res, "/api/videos" + pickQuery(req, ["category", "limit", "offset", "sort"]));
  });

  app.get("/api/archive/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const author = typeof req.query.author === "string" ? req.query.author.trim() : "";
    if (!q && !author) return res.status(400).json({ error: "検索キーワード (q) がありません (author でも可)" });
    if (q.length > 100) return res.status(400).json({ error: "検索キーワードが長すぎます" });
    if (author.length > 200) return res.status(400).json({ error: "ユーザー名が長すぎます" });
    await proxyJson(res, "/api/search" + pickQuery(req, ["q", "author", "kind", "category", "limit", "offset"]), {
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
  });

  app.get("/api/archive/authors", async (req, res) => {
    const prefix = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (prefix.length > 100) return res.status(400).json({ error: "ユーザー名が長すぎます" });
    await proxyJson(res, "/api/authors" + pickQuery(req, ["q", "limit"]));
  });

  app.get("/api/archive/video/:id", async (req, res) => {
    const id = req.params.id;
    if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ error: "invalid video_id" });
    await proxyJson(res, `/api/video/${id}`);
  });

  // 字幕の有無と出自を判定（バッジ表示用）。上流が 404 を返したら {has_transcript:false} を返す。
  // 一覧の各カードで表示対象だけをチェックするため、ビデオ単体の有無判定に特化する。
  // source は「その動画で実際に使われている字幕」（whisper 優先、なければ youtube_auto）。
  // フルの字幕は1本400KB超あるため from_ms/to_ms で meta のみを取りに行く（約500B）。
  // 字幕の有無と出自は動画ごとに不変なので、上流への問い合わせをキャッシュする
  // （ページ送りのたびに N 本分のリクエストが飛ぶのを防ぐ）
  const TRANSCRIPT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  const transcriptCache = new Map();
  app.get("/api/archive/transcript/:id", async (req, res) => {
    const id = req.params.id;
    if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ error: "invalid video_id" });

    const cacheKey = `/api/archive/transcript/${id}`;
    const cached = transcriptCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
      res.set("X-Archive-Cache", "HIT");
      return res.json(cached.value);
    }

    let upstream;
    try {
      upstream = await fetchUpstream(`/api/transcript/${id}?from_ms=1&to_ms=2`, JSON_TIMEOUT_MS);
    } catch (err) {
      markUpstream(false, err);
      return res.status(504).json({ error: "アーカイブAPIに接続できません", has_transcript: null, source: null });
    }
    let value;
    if (upstream.status !== 200) {
      value = { video_id: id, has_transcript: false, source: null };
    } else {
      let body = null;
      try { body = await upstream.json(); } catch { body = null; }
      const source = (body && body.meta && body.meta.source) || null;
      value = { video_id: id, has_transcript: true, source };
    }
    transcriptCache.set(cacheKey, { value, expires: Date.now() + TRANSCRIPT_CACHE_TTL_MS });
    res.set("X-Archive-Cache", "MISS");
    return res.json(value);
  });

  // チャプター（タイムスタンプ txt）を取得する。上流が 404 ならそのまま 404 を返す。
  // チャプターの有無判定は /api/archive/videos 等では行わず、カードごとにこのエンドポイントを叩く。
  app.get("/api/archive/chapters/:id", async (req, res) => {
    const id = req.params.id;
    if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ error: "invalid video_id" });
    await proxyJson(res, `/api/chapters/${id}`);
  });

  // 要約の有無を、与えられた video_ids から判定して返す（バッジ表示用）
  // data: { flags: { <video_id>: { has_minutes: true } , ... } }
  app.get("/api/archive/minutes", async (req, res) => {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => String(s).trim())
      .filter((s) => VIDEO_ID_RE.test(s));
    const flags = {};
    if (!ids.length) return res.json({ flags });
    if (!ctx.db) return res.json({ flags });
    ctx.db.all(
      `SELECT DISTINCT video_id FROM video_minutes WHERE video_id IN (${ids.map(() => "?").join(",")})`,
      ids,
      (err, rows) => {
        if (err) return res.json({ flags });
        (rows || []).forEach((r) => { flags[r.video_id] = { has_minutes: true }; });
        return res.json({ flags });
      }
    );
  });

  // 1本の配信の要約（5分チャンクの topic/summary/facts）を時系列で返す
  app.get("/api/archive/minutes/:id", async (req, res) => {
    const id = req.params.id;
    if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ error: "invalid video_id" });
    if (!ctx.db) return res.status(503).json({ error: "db unavailable" });
    ctx.db.all(
      `SELECT start_ms, end_ms, topic, summary, facts, title, stream_date_jst, url, section
       FROM video_minutes WHERE video_id=? ORDER BY start_ms ASC LIMIT 800`,
      [id],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "db error" });
        if (!rows || !rows.length) return res.status(404).json({ error: "minutes not found" });
        const segments = rows.map((r) => {
          let facts = [];
          try { facts = JSON.parse(r.facts || "[]"); } catch { facts = []; }
          if (!Array.isArray(facts)) facts = [];
          return {
            start_ms: r.start_ms, end_ms: r.end_ms,
            topic: r.topic || "", summary: r.summary || "",
            section: r.section || "",
            facts, url: r.url || "",
          };
        });
        return res.json({
          video_id: id,
          title: rows[0].title || "",
          stream_date_jst: rows[0].stream_date_jst || "",
          count: segments.length,
          segments,
        });
      }
    );
  });

  app.get("/api/archive/buzzwords", async (req, res) => {
    await proxyJson(res, "/api/buzzwords" + pickQuery(req, ["year", "top"]), {
      timeoutMs: 90000,
    });
  });

  // 公開エイリアス: /api/buzzwords は /api/archive/buzzwords と同じ
  app.get("/api/buzzwords", async (req, res) => {
    await proxyJson(res, "/api/buzzwords" + pickQuery(req, ["year", "top"]), {
      timeoutMs: 90000,
    });
  });

  app.get("/api/archive/thumbnail/:id", async (req, res) => {
    const id = String(req.params.id || "").replace(/\.(jpg|jpeg|webp|png)$/i, "");
    if (!VIDEO_ID_RE.test(id)) return res.status(400).json({ error: "invalid video_id" });

    let upstream;
    try {
      upstream = await fetchUpstream(`/api/thumbnail/${id}`, THUMB_TIMEOUT_MS);
    } catch {
      return res.status(502).end();
    }
    if (!upstream.ok) return res.status(upstream.status).end();

    let buf;
    try {
      buf = Buffer.from(await upstream.arrayBuffer());
    } catch {
      return res.status(502).end();
    }

    res.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    // nginx の /api/ ロケーションが no-store を付けるため実際には効かないが、
    // 直叩き・将来的な location 追加に備えて上流の意図を保持しておく
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    const etag = upstream.headers.get("etag");
    if (etag) res.set("ETag", etag);
    return res.send(buf);
  });
}

module.exports = { register, ARCHIVE_API_BASE, refreshHealth, isUpstreamDown };
