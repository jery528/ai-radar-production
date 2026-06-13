const express = require("express");
const { query } = require("../db");
const settings = require("../settings");
const users = require("../users");
const crawler = require("../services/crawler");
const dataSnapshot = require("../services/dataSnapshot");
const insights = require("../services/insights");
const profiles = require("../services/profiles");
const { parseJsonColumn } = require("../util");

const router = express.Router();

// 分页情报列表（前台情报流按需加载，替代原来的全量下发）
router.get("/api/items", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || 20), 100);

    // 按用户 profile 限制可见赛道（首页/管理员=全部可见赛道）
    const { profile } = await profiles.resolveProfile(req.query.u);
    const base = await dataSnapshot.getSnapshot();
    const allowed = users.resolveAllowedSectors(profile, base.payload.sectors.map((s) => s.id));
    const allowedSet = new Set(allowed);

    const where = ["sec.is_visible = 1"];
    const params = [];
    if (allowed.length) {
      where.push(`i.sector_id IN (${allowed.map(() => "?").join(",")})`);
      params.push(...allowed);
    }
    if (req.query.sector && req.query.sector !== "all" && allowedSet.has(req.query.sector)) {
      where.push("i.sector_id = ?");
      params.push(String(req.query.sector));
    }
    if (req.query.type && req.query.type !== "all") {
      where.push("s.type = ?");
      params.push(String(req.query.type));
    }
    const ageDays = Number(req.query.age);
    if (ageDays > 0) {
      where.push("i.published_at >= DATE_SUB(NOW(), INTERVAL ? DAY)");
      params.push(ageDays);
    }
    const q = String(req.query.q || "").trim();
    if (q) {
      where.push("(i.title LIKE ? OR i.summary LIKE ? OR i.ai_summary LIKE ? OR s.name LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [sectors, totalRows, rows, countRows] = await Promise.all([
      query("SELECT id, name FROM sectors"),
      query(
        `SELECT COUNT(*) AS n FROM items i JOIN sources s ON s.id = i.source_id JOIN sectors sec ON sec.id = i.sector_id ${whereSql}`,
        params
      ),
      query(
        `SELECT i.id, i.title, i.url, i.source_id, i.sector_id, i.tags, i.summary, i.ai_summary,
                i.published_at, i.score,
                s.name AS source_name, s.type AS source_type, s.homepage AS source_homepage,
                s.region AS source_region, s.language AS source_language
         FROM items i
         JOIN sources s ON s.id = i.source_id
         JOIN sectors sec ON sec.id = i.sector_id
         ${whereSql}
         ORDER BY i.published_at DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize]
      ),
      // 赛道栏计数（限本用户允许的赛道，不随搜索/类型/时间筛选变化）
      allowed.length
        ? query(
            `SELECT i.sector_id, COUNT(*) AS n FROM items i JOIN sectors sec ON sec.id = i.sector_id
             WHERE sec.is_visible = 1 AND i.sector_id IN (${allowed.map(() => "?").join(",")})
             GROUP BY i.sector_id`,
            allowed
          )
        : query(
            `SELECT i.sector_id, COUNT(*) AS n FROM items i JOIN sectors sec ON sec.id = i.sector_id
             WHERE sec.is_visible = 1 GROUP BY i.sector_id`
          ),
    ]);

    const sectorNameById = new Map(sectors.map((s) => [s.id, s.name]));
    const sectorCounts = { all: 0 };
    for (const row of countRows) {
      sectorCounts[row.sector_id] = row.n;
      sectorCounts.all += row.n;
    }

    res.json({
      page,
      pageSize,
      total: totalRows[0].n,
      sectorCounts,
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        url: row.url,
        sourceId: row.source_id,
        sourceName: row.source_name,
        sourceType: row.source_type,
        sourceHomepage: row.source_homepage,
        region: row.source_region,
        language: row.source_language,
        sector: row.sector_id,
        sectorName: sectorNameById.get(row.sector_id) || row.sector_id,
        tags: parseJsonColumn(row.tags, []).map((id) => sectorNameById.get(id) || id),
        summary: row.ai_summary || row.summary || "",
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        score: Number(row.score) || 0,
        aiSummarized: Boolean(row.ai_summary),
      })),
    });
  } catch (error) {
    next(error);
  }
});

// 机会洞察统计（排行榜与洞察卡共用，服务端计算 + 30s 缓存；置顶按用户 profile）
router.get("/api/insights", async (req, res, next) => {
  try {
    const { profile } = await profiles.resolveProfile(req.query.u);
    const base = await insights.computeInsightStats();
    res.set("cache-control", "no-cache");
    res.json(profiles.applyInsightsProfile(base, profile));
  } catch (error) {
    next(error);
  }
});

router.get("/api/data", async (req, res, next) => {
  try {
    const snapshot = await dataSnapshot.getSnapshot();
    const { user, profile, found, requested } = await profiles.resolveProfile(req.query.u);
    const payload = profiles.applyDataProfile(snapshot.payload, profile, {
      user,
      userNotFound: Boolean(req.query.u) && !found,
      requested,
    });
    const etag = `${snapshot.etag.slice(0, -1)}-u:${user ? user.username : (requested || "_")}"`;
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }
    res.set("etag", etag);
    res.set("cache-control", "no-cache");
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

// 公共刷新：异步触发，运行中 409，冷却期 429
router.post("/api/refresh", async (req, res, next) => {
  try {
    const cooldownSec = Number(await settings.get("crawl.publicRefreshCooldownSec", 300));
    const now = Date.now();
    if (crawler.state.lastPublicRefreshAt && now - crawler.state.lastPublicRefreshAt < cooldownSec * 1000) {
      const waitSec = Math.ceil((cooldownSec * 1000 - (now - crawler.state.lastPublicRefreshAt)) / 1000);
      return res.status(429).json({ ok: false, error: `刷新过于频繁，请 ${waitSec} 秒后再试` });
    }
    const { runId } = await crawler.runCrawl("manual");
    crawler.state.lastPublicRefreshAt = now;
    res.status(202).json({ ok: true, runId });
  } catch (error) {
    if (error.code === "RUNNING") {
      return res.status(409).json({ ok: false, running: true, error: "已有抓取任务在运行" });
    }
    next(error);
  }
});

router.get("/api/refresh/status", async (req, res, next) => {
  try {
    const state = crawler.getState();
    const lastRun = await crawler.lastRun();
    res.json({
      running: state.running,
      phase: state.phase || null,
      runId: state.runId,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            stats: lastRun.stats,
            error: lastRun.error ? String(lastRun.error).slice(0, 300) : null,
          }
        : null,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/api/health", async (req, res) => {
  try {
    const rows = await query("SELECT COUNT(*) AS n FROM items");
    const lastRun = await crawler.lastRun();
    res.json({
      ok: true,
      db: true,
      itemCount: rows[0].n,
      lastRunAt: lastRun ? lastRun.startedAt : null,
      running: crawler.getState().running,
    });
  } catch (error) {
    res.status(500).json({ ok: false, db: false, error: String(error.message || error).slice(0, 200) });
  }
});

router.get("/api/reports/latest", async (req, res, next) => {
  try {
    const rows = await query(
      "SELECT id, title, content_md, model, created_at FROM ai_reports WHERE is_published = 1 ORDER BY id DESC LIMIT 1"
    );
    res.json({ report: rows[0] || null });
  } catch (error) {
    next(error);
  }
});

router.get("/api/reports", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const rows = await query(
      "SELECT id, title, model, created_at FROM ai_reports WHERE is_published = 1 ORDER BY id DESC LIMIT ?",
      [limit]
    );
    res.json({ reports: rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
