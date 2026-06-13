const { query } = require("../db");
const settings = require("../settings");
const crawler = require("./crawler");
const { parseJsonColumn } = require("../util");

// 组装 /api/data 负载：兼容参考站 AI_RADAR_DATA 形状（generatedAt/sectors/stats/items），
// 并扩展 modules / settings / topics / report。30 秒内存缓存 + 版本号（供 ETag）。

let cache = null; // { payload, etag, expiresAt }
let version = 0;

function invalidate() {
  cache = null;
  version++;
}

crawler.onSnapshotInvalidate(invalidate);

async function buildPayload() {
  const [sectors, sources, modules, topics, lastRun] = await Promise.all([
    query("SELECT * FROM sectors ORDER BY sort_order, id"),
    query("SELECT * FROM sources WHERE is_enabled = 1 ORDER BY sort_order, id"),
    query("SELECT * FROM modules ORDER BY sort_order, id"),
    query("SELECT * FROM insight_topics WHERE is_visible = 1 ORDER BY sort_order, id"),
    crawler.lastRun(),
  ]);

  const visibleSectors = sectors.filter((s) => s.is_visible);

  // 条目不再随 /api/data 全量下发（页面卡顿优化）：列表走 /api/items 分页接口
  const countRows = await query(
    `SELECT COUNT(*) AS n FROM items i JOIN sectors s ON s.id = i.sector_id WHERE s.is_visible = 1`
  );
  const itemCount = countRows[0].n;

  const runStats = (lastRun && lastRun.stats) || {};
  const stats = {
    generatedAt: runStats.generatedAt || null,
    startedAt: runStats.startedAt || null,
    lookbackDays: Number(await settings.get("crawl.lookbackDays", 30)),
    cutoffAt: runStats.cutoffAt || null,
    sourceCount: sources.length,
    fetchConcurrency: runStats.fetchConcurrency || null,
    linkResolution: runStats.linkResolution || null,
    okSourceCount: sources.filter((s) => s.last_ok === 1).length,
    failedSourceCount: sources.filter((s) => s.last_ok === 0).length,
    itemCount,
    llm: runStats.llm || null,
    failures: (runStats.failures || []).slice(0, 50),
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      homepage: s.homepage,
      feedUrl: s.feed_url,
      type: s.type,
      region: s.region,
      ok: s.last_ok === null ? null : Boolean(s.last_ok),
      via: s.last_via || "fetch",
      count: s.last_count || 0,
      error: s.last_error || null,
    })),
  };

  // 最新已发布日报
  const reportRows = await query(
    "SELECT id, title, content_md, model, created_at FROM ai_reports WHERE is_published = 1 ORDER BY id DESC LIMIT 1"
  );
  const report = reportRows.length
    ? {
        id: reportRows[0].id,
        title: reportRows[0].title,
        contentMd: reportRows[0].content_md,
        model: reportRows[0].model,
        createdAt: new Date(reportRows[0].created_at).toISOString(),
      }
    : null;

  return {
    generatedAt: (lastRun && lastRun.status === "ok" && lastRun.finishedAt
      ? new Date(lastRun.finishedAt).toISOString()
      : runStats.generatedAt) || null,
    sectors: visibleSectors.map((s) => ({ id: s.id, name: s.name, description: s.description })),
    stats,
    modules: modules.map((m) => ({
      id: m.id,
      name: m.name,
      anchor: m.anchor,
      navItems: parseJsonColumn(m.nav_items, []),
      isOrderable: Boolean(m.is_orderable),
      sortOrder: m.sort_order,
      isVisible: Boolean(m.is_visible),
      settings: parseJsonColumn(m.settings, {}),
    })),
    topics: topics.map((t) => ({
      id: t.id,
      title: t.title,
      thesis: t.thesis,
      signal: t.signal_text,
      keywords: parseJsonColumn(t.keywords, []),
      metricLabel: t.metric_label,
      bestFor: t.best_for,
      opportunity: t.opportunity,
      threshold: t.threshold_text,
      tools: parseJsonColumn(t.tools, []),
      firstAction: t.first_action,
      action: parseJsonColumn(t.actions, []),
    })),
    report,
    site: {
      title: await settings.get("site.title", ""),
      metaDescription: await settings.get("site.metaDescription", ""),
    },
  };
}

async function getSnapshot() {
  if (cache && cache.expiresAt > Date.now()) return cache;
  const payload = await buildPayload();
  cache = {
    payload,
    etag: `W/"v${version}-${payload.stats.itemCount}-${payload.generatedAt || "0"}"`,
    expiresAt: Date.now() + 30 * 1000,
  };
  return cache;
}

module.exports = { getSnapshot, invalidate };
