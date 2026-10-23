"use strict";
/**
 * routes/admin-honeypot.js — ハニーポットの可視化（管理画面専用）
 *
 * - 認証: `requireAuth`（パスワード/パスキー or tailnet 自動認証）。
 * - 公開範囲: `/api/admin/` 配下（公開ドメインでは nginx が 403）。
 *   攻撃元の IP・UA・国は**公開エンドポイントに出さない**（AGENTS.md §5.3）。
 * - 集計は `services/honeypot-report.js`（HTTP 非依存・テスト可能）。
 */

const adminAuth = require("../lib/admin");
const report = require("../services/honeypot-report");

function register(app) {
  app.get("/api/admin/honeypot", adminAuth.requireAuth, async (req, res) => {
    try {
      const days = report.clampDays(req.query && req.query.days);
      res.set("Cache-Control", "no-store");
      res.json(await report.collect({ days }));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { register };
