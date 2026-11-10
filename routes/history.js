function register(app, db) {
  const allAsync = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });

  // "YYYY-MM-DD" -> UTCミリ秒（日付比較専用・TZ非依存）
  const dayMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const DAY = 86400000;

  // 連続記録（現在／最長）を日次集計から算出
  function calcStreaks(dates) {
    if (!dates.length) return { current: 0, longest: 0 };
    let longest = 1, run = 1;
    for (let i = 1; i < dates.length; i++) {
      run = (dayMs(dates[i]) - dayMs(dates[i - 1]) === DAY) ? run + 1 : 1;
      if (run > longest) longest = run;
    }
    // 現在の連続記録は「今日」または「昨日」で終わっている場合のみ有効
    const now = new Date();
    const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const lastMs = dayMs(dates[dates.length - 1]);
    const gap = todayMs - lastMs;
    if (gap !== 0 && gap !== DAY) return { current: 0, longest };
    let current = 1;
    for (let i = dates.length - 1; i > 0; i--) {
      if (dayMs(dates[i]) - dayMs(dates[i - 1]) !== DAY) break;
      current++;
    }
    return { current, longest };
  }

  // 欠損月を0埋めして連続した月配列にする
  function fillMonths(rows) {
    if (!rows.length) return [];
    const map = new Map(rows.map(r => [r.month, r.count]));
    const [sy, sm] = rows[0].month.split("-").map(Number);
    const [ey, em] = rows[rows.length - 1].month.split("-").map(Number);
    const out = [];
    for (let y = sy, m = sm; y < ey || (y === ey && m <= em);) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      out.push({ month: key, count: map.get(key) || 0 });
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }

  // 統計から除外する通知（記念日・システム/テスト系）。実配信/投稿の傾向だけを見るため。
  const EXCLUDE_SQL =
    "LOWER(COALESCE(platform, '')) NOT LIKE '%milestone%' " +
    "AND COALESCE(platform, '') NOT LIKE '%記念日%' " +
    "AND LOWER(TRIM(COALESCE(platform, ''))) NOT IN ('admin', 'test', 'event')";

  // UTC 0時基準のミリ秒 -> "YYYY-MM-DD"
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  /**
   * 通知統計の詳細版。
   * ?years=N  … 直近N年（0 = 全期間 / 既定 1年）
   * ?year=YYYY … 暦年（YYYY-01-01 〜 min(YYYY-12-31, 今日)）※yearsより優先
   * 月別・種別・曜日別・時間帯別・種別×月 をまとめて返す。
   */
  app.get("/api/notifications/stats/detail", async (req, res) => {
    const now = new Date();
    const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

    let years = parseInt(req.query.years, 10);
    if (isNaN(years) || years < 0) years = 1;
    if (years > 20) years = 20;

    let mode = "rolling";
    let year = null;
    if (req.query.year != null && req.query.year !== "") {
      const y = parseInt(req.query.year, 10);
      if (!isNaN(y) && y >= 2000 && y <= 2100) { mode = "year"; year = y; }
    }

    // 期間条件（除外条件は常に適用）
    let cond = null;
    let p = [];
    if (mode === "year") {
      cond = "strftime('%Y', created_at, 'localtime') = ?";
      p = [String(year)];
    } else if (years > 0) {
      cond = "created_at >= date('now', 'localtime', '-' || ? || ' year')";
      p = [years];
    }
    const where = "WHERE " + EXCLUDE_SQL + (cond ? " AND " + cond : "");
    const PLAT = "COALESCE(NULLIF(TRIM(platform), ''), 'unknown')";

    try {
      const [daily, monthlyRaw, byType, byDowRaw, byHourRaw, monthlyByType, yearRows] = await Promise.all([
        allAsync(`SELECT strftime('%Y-%m-%d', created_at, 'localtime') AS date, COUNT(*) AS count FROM notifications ${where} GROUP BY date ORDER BY date ASC`, p),
        allAsync(`SELECT strftime('%Y-%m', created_at, 'localtime') AS month, COUNT(*) AS count FROM notifications ${where} GROUP BY month ORDER BY month ASC`, p),
        allAsync(`SELECT ${PLAT} AS platform, COUNT(*) AS count FROM notifications ${where} GROUP BY platform ORDER BY count DESC`, p),
        allAsync(`SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) AS dow, COUNT(*) AS count FROM notifications ${where} GROUP BY dow ORDER BY dow ASC`, p),
        allAsync(`SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour, COUNT(*) AS count FROM notifications ${where} GROUP BY hour ORDER BY hour ASC`, p),
        allAsync(`SELECT strftime('%Y-%m', created_at, 'localtime') AS month, ${PLAT} AS platform, COUNT(*) AS count FROM notifications ${where} GROUP BY month, platform ORDER BY month ASC`, p),
        allAsync(`SELECT DISTINCT CAST(strftime('%Y', created_at, 'localtime') AS INTEGER) AS y FROM notifications WHERE ${EXCLUDE_SQL} ORDER BY y DESC`, []),
      ]);

      const dates = daily.map(r => r.date);
      const total = daily.reduce((s, r) => s + r.count, 0);
      const activeDays = daily.length;
      const busiest = daily.reduce((a, r) => (r.count > (a?.count || 0) ? r : a), null);
      const { current, longest } = calcStreaks(dates);

      // 集計対象期間の開始/終了（日単位）
      let startMs, endMs;
      if (mode === "year") {
        startMs = Date.UTC(year, 0, 1);
        endMs = Math.min(Date.UTC(year, 11, 31), todayMs);
      } else if (years > 0) {
        endMs = todayMs;
        startMs = endMs - (Math.round(years * 365) - 1) * DAY;
      } else {
        startMs = dates.length ? dayMs(dates[0]) : todayMs;
        endMs = dates.length ? dayMs(dates[dates.length - 1]) : todayMs;
      }
      if (endMs < startMs) endMs = startMs;
      const spanDays = Math.floor((endMs - startMs) / DAY) + 1;

      // 曜日別は「その曜日が期間内に何日あったか」で平均も出す
      const dowCount = new Array(7).fill(0);
      for (let t = startMs; t <= endMs; t += DAY) dowCount[new Date(t).getUTCDay()]++;
      const dowMap = new Map(byDowRaw.map(r => [r.dow, r.count]));
      const byDayOfWeek = Array.from({ length: 7 }, (_, i) => ({
        dow: i,
        count: dowMap.get(i) || 0,
        days: dowCount[i],
        avg: dowCount[i] ? +((dowMap.get(i) || 0) / dowCount[i]).toFixed(2) : 0,
      }));

      const hourMap = new Map(byHourRaw.map(r => [r.hour, r.count]));
      const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourMap.get(h) || 0 }));

      // 「現在の連続日数」は今日を含む期間でのみ意味を持つ
      const includesToday = mode !== "year" || year === now.getFullYear();

      res.json({
        mode,
        year,
        years,
        availableYears: yearRows.map(r => r.y).filter(y => Number.isFinite(y)),
        summary: {
          total,
          activeDays,
          spanDays,
          rangeStart: isoDay(startMs),
          rangeEnd: isoDay(endMs),
          avgPerDay: spanDays ? +(total / spanDays).toFixed(2) : 0,
          avgPerActiveDay: activeDays ? +(total / activeDays).toFixed(2) : 0,
          busiestDay: busiest ? { date: busiest.date, count: busiest.count } : null,
          currentStreak: includesToday ? current : null,
          longestStreak: longest,
          firstDate: dates[0] || null,
          lastDate: dates[dates.length - 1] || null,
          typeCount: byType.length,
        },
        monthly: fillMonths(monthlyRaw),
        monthlyByType,
        byType,
        byDayOfWeek,
        byHour,
      });
    } catch (err) {
      res.status(500).json({ error: "DB error", detail: err.message });
    }
  });

  app.get("/api/notifications/stats", (req, res) => {
    const years = parseInt(req.query.years, 10) || 1;
    db.all("SELECT strftime('%Y-%m-%d', created_at, 'localtime') as date, COUNT(*) as count FROM notifications WHERE created_at >= date('now', 'localtime', '-' || ? || ' year') GROUP BY date ORDER BY date ASC", [years], (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error", detail: err.message });
      const stats = {};
      (rows || []).forEach(row => { stats[row.date] = row.count; });
      res.json(stats);
    });
  });

  app.get("/api/history", (req, res) => {
    let limit = parseInt(req.query.limit, 10) || 10;
    let offset = parseInt(req.query.offset, 10) || 0;
    if (isNaN(limit) || limit < 1) limit = 10;
    if (isNaN(offset) || offset < 0) offset = 0;
    const MAX_LIMIT = 100;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    db.get("SELECT COUNT(*) AS cnt FROM notifications", [], (countErr, countRow) => {
      if (countErr) return res.status(500).json({ error: "DB error", detail: countErr.message });
      const total = countRow?.cnt ? parseInt(countRow.cnt, 10) : 0;
      if (!total) return res.json({ logs: [], total: 0, hasMore: false });
      db.all(`SELECT n.id, n.title, n.body, n.url, n.icon, n.image, n.platform, n.status, strftime('%s', n.created_at) AS timestamp, (SELECT tm.id FROM twitter_media tm WHERE tm.tweet_id = n.tweet_id ORDER BY tm.id LIMIT 1) AS media_id, (SELECT tm.media_type FROM twitter_media tm WHERE tm.tweet_id = n.tweet_id ORDER BY tm.id LIMIT 1) AS media_type FROM notifications n ORDER BY n.id DESC LIMIT ? OFFSET ?`, [limit, offset], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB error", detail: err.message });
        const safeRows = Array.isArray(rows) ? rows : [];
        const hasMore = offset + safeRows.length < total;
        const logs = safeRows.map(r => ({ id: r.id, title: r.title, body: r.body, url: r.url, icon: r.icon, image: r.image, platform: r.platform || "不明", status: r.status || "success", timestamp: r.timestamp ? parseInt(r.timestamp, 10) : 0, media_url: (r.media_id && r.platform !== 'twitterSub') ? `/api/twitter-media/file/${r.media_id}` : null, media_type: (r.platform !== 'twitterSub') ? r.media_type : null }));
        res.json({ logs, total, hasMore });
      });
    });
  });
}

module.exports = { register };
