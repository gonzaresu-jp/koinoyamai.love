const fs = require("fs");
const path = require("path");

function register(app, db) {
  const twitterMediaSaver = require("../src/scrapers/twitter-media-saver");

  app.get("/api/twitter-media", (req, res) => {
    const username = "koinoya_mai";
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const type = req.query.type;
    twitterMediaSaver.getMediaStats(username, (statsErr, stats) => {
      let query = "SELECT id, tweet_id, username, media_type, original_url, local_path, file_size, tweet_text, tweet_date, created_at FROM twitter_media WHERE username = ?";
      const params = [username];
      if (type === "image" || type === "video") { query += " AND media_type = ?"; params.push(type); }
      query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);
      db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: "Internal error" });
        res.json({ media: (rows || []).map(r => ({ id: r.id, tweet_id: r.tweet_id, media_type: r.media_type, file_size: r.file_size, tweet_text: r.tweet_text, tweet_date: r.tweet_date, created_at: r.created_at, file_url: `/api/twitter-media/file/${r.id}`, tweet_url: `https://x.com/${r.username}/status/${r.tweet_id}` })), stats: stats || { total: 0, images: 0, videos: 0, total_size: 0 }, limit, offset });
      });
    });
  });

  app.get("/api/twitter-media/file/:id", (req, res) => {
    const mediaId = parseInt(req.params.id);
    if (!mediaId || isNaN(mediaId)) return res.status(400).send("Invalid ID");
    db.get("SELECT local_path, media_type FROM twitter_media WHERE id = ?", [mediaId], (err, row) => {
      if (err || !row) return res.status(404).send("Not found");
      const filePath = row.local_path;
      if (!fs.existsSync(filePath)) return res.status(404).send("File not found on disk");
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };
      const contentType = mimeMap[ext] || "application/octet-stream";
      res.set("Cache-Control", "public, max-age=86400");
      res.set("Content-Type", contentType);
      const stat = fs.statSync(filePath);
      const range = req.headers.range;
      if (range && row.media_type === "video") {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= stat.size) {
          res.set("Content-Range", `bytes */${stat.size}`);
          return res.sendStatus(416);
        }
        res.status(206);
        res.set({ "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.set("Content-Length", stat.size);
        fs.createReadStream(filePath).pipe(res);
      }
    });
  });
}

module.exports = { register };
