const { query } = require("../db");
const settings = require("../settings");
const llm = require("./llm");
const { parseJsonColumn, toMysqlDateTime } = require("../util");

// 机会洞察：服务端统计（排行榜/卡片共用，置顶话题永远排第一）+ AI 日报（北京时间每天定点生成一次）。

// ---------- 洞察统计（/api/insights 与日报共用） ----------
let statsCache = null; // { payload, expiresAt }

function invalidateStats() {
  statsCache = null;
}

async function getInsightsModuleSettings() {
  const rows = await query("SELECT settings FROM modules WHERE id = 'insights'");
  return rows.length ? parseJsonColumn(rows[0].settings, {}) : {};
}

/** 话题条目匹配：标题+摘要+来源名 包含任一关键词（与参考站同口径） */
function matchTopicItems(topic, pool) {
  const keywords = parseJsonColumn(topic.keywords, []).map((k) => String(k).toLowerCase()).filter(Boolean);
  if (!keywords.length) return [];
  return pool
    .filter((item) => keywords.some((keyword) => item.searchText.includes(keyword)))
    .sort((a, b) => b.publishedMs - a.publishedMs);
}

async function computeInsightStats() {
  if (statsCache && statsCache.expiresAt > Date.now()) return statsCache.payload;

  const moduleSettings = await getInsightsModuleSettings();
  const targetSectorId = moduleSettings.targetSectorId || "ordinary-income";
  const weights = moduleSettings.scoreWeights || { count: 42, sources: 28, recent: 20, example: 10 };
  const lookbackDays = Number(await settings.get("crawl.lookbackDays", 30));

  const sectorRows = await query("SELECT id, name FROM sectors WHERE id = ?", [targetSectorId]);
  const targetSector = sectorRows[0] || { id: targetSectorId, name: targetSectorId };

  // 话题池：主赛道命中 或 tags 命中（短视频等条目主赛道迁移后仍计入变现统计）
  const pool = (
    await query(
      `SELECT i.title, i.summary, i.ai_summary, i.url, i.published_at, s.name AS source_name
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.sector_id = ? OR JSON_CONTAINS(i.tags, ?)`,
      [targetSectorId, JSON.stringify(targetSectorId)]
    )
  ).map((row) => ({
    title: row.title,
    url: row.url,
    sourceName: row.source_name,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    publishedMs: row.published_at ? new Date(row.published_at).getTime() : 0,
    summary: row.ai_summary || row.summary || "",
    searchText: `${row.title} ${row.ai_summary || row.summary || ""} ${row.source_name}`.toLowerCase(),
  }));

  const topics = await query("SELECT * FROM insight_topics WHERE is_visible = 1 ORDER BY sort_order, id");
  const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;

  const rows = topics.map((topic) => {
    const topicItems = matchTopicItems(topic, pool);
    const sources = new Set(topicItems.map((item) => item.sourceName));
    const recentCount = topicItems.filter((item) => item.publishedMs >= sevenDaysAgo).length;
    return {
      id: topic.id,
      title: topic.title,
      thesis: topic.thesis,
      signal: topic.signal_text,
      metricLabel: topic.metric_label,
      bestFor: topic.best_for,
      opportunity: topic.opportunity,
      threshold: topic.threshold_text,
      tools: parseJsonColumn(topic.tools, []),
      firstAction: topic.first_action,
      action: parseJsonColumn(topic.actions, []),
      sortOrder: topic.sort_order,
      isPinned: Boolean(topic.is_pinned),
      count: topicItems.length,
      sourceCount: sources.size,
      recentCount,
      example: topicItems[0] ? { title: topicItems[0].title, url: topicItems[0].url } : null,
      examples: topicItems.slice(0, 3).map((item) => ({
        title: item.title,
        url: item.url,
        sourceName: item.sourceName,
        publishedAt: item.publishedAt,
      })),
    };
  });

  const maxCount = Math.max(...rows.map((r) => r.count), 1);
  const maxSourceCount = Math.max(...rows.map((r) => r.sourceCount), 1);
  const maxRecentCount = Math.max(...rows.map((r) => r.recentCount), 1);
  for (const row of rows) {
    const score = row.count
      ? Math.round(
          (row.count / maxCount) * (weights.count || 0) +
            (row.sourceCount / maxSourceCount) * (weights.sources || 0) +
            (row.recentCount / maxRecentCount) * (weights.recent || 0) +
            (row.example ? weights.example || 0 : 0)
        )
      : 0;
    row.score = Math.min(score, 100);
    row.share = pool.length ? Math.round((row.count / pool.length) * 100) : 0;
  }

  // 排行榜顺序：置顶优先（按 sort_order），其余按机会分
  rows.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned && b.isPinned) return a.sortOrder - b.sortOrder;
    return b.score - a.score || b.count - a.count;
  });

  const totalRows = await query(
    "SELECT COUNT(*) AS n FROM items i JOIN sectors s ON s.id = i.sector_id WHERE s.is_visible = 1"
  );
  const enabledSources = await query("SELECT COUNT(*) AS n FROM sources WHERE is_enabled = 1");
  const lastOk = await query(
    "SELECT finished_at FROM crawl_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1"
  );

  const payload = {
    targetSector: { id: targetSector.id, name: targetSector.name },
    lookbackDays,
    generatedAt: lastOk.length && lastOk[0].finished_at ? new Date(lastOk[0].finished_at).toISOString() : null,
    totalItems: totalRows[0].n,
    sourceCount: enabledSources[0].n,
    incomeCount: pool.length,
    incomeSourceCount: new Set(pool.map((item) => item.sourceName)).size,
    rows,
  };

  statsCache = { payload, expiresAt: Date.now() + 30 * 1000 };
  return payload;
}

// ---------- 日报 ----------
async function collectReportInput() {
  const lookbackDays = Number(await settings.get("crawl.lookbackDays", 30));
  const sectorRows = await query(
    `SELECT s.name AS sector_name, COUNT(*) AS n,
            SUM(CASE WHEN i.published_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS recent7
     FROM items i JOIN sectors s ON s.id = i.sector_id
     GROUP BY i.sector_id, s.name ORDER BY n DESC`
  );
  const insightStats = await computeInsightStats();
  const topicCounts = insightStats.rows.slice(0, 12).map((r) => ({ title: r.title, count: r.count, pinned: r.isPinned }));
  const topItems = await query(
    `SELECT i.title, s.name AS source_name FROM items i JOIN sources s ON s.id = i.source_id
     WHERE i.published_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
     ORDER BY i.score DESC, i.published_at DESC LIMIT 30`
  );
  return { lookbackDays, sectorRows, topicCounts, topItems };
}

/** 生成日报并入库。成功返回 {id, title}，失败/关闭返回 null。 */
async function generateReport(runId, runStats, options = {}) {
  const reportEnabled = Boolean(await settings.get("llm.reportEnabled", false));
  if (!reportEnabled && !options.force) return null;

  const input = await collectReportInput();
  const focus = String((await settings.get("llm.reportFocus", "")) || "").trim();
  const dateLabel = new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });

  const sectorLines = input.sectorRows
    .map((r) => `- ${r.sector_name}：共 ${r.n} 条，近 7 天 ${r.recent7} 条`)
    .join("\n");
  const topicLines = input.topicCounts
    .map((t, i) => `${i + 1}. ${t.title}（${t.count} 条信号${t.pinned ? "，用户重点方向" : ""}）`)
    .join("\n");
  const titleLines = input.topItems.map((t) => `- ${t.title}（${t.source_name}）`).join("\n");
  const newCount = (runStats && runStats.newItemCount) || 0;
  const focusLine = focus
    ? `\n【重点要求】读者主要从事「${focus}」方向，今日要点的第一条和赛道动态的第一段必须优先分析该方向的最新信号与可执行机会，其余内容随后。`
    : "";

  const result = await llm.chat(
    [
      {
        role: "system",
        content:
          "你是「AI破局情报导航」的主编，为关注 AI 变现机会的普通人写每日情报综述。文风务实、具体、不夸张，禁止使用“月入过万”“稳赚”等夸大表述。输出 markdown，只用 ##、###、加粗、无序列表这几种语法。",
      },
      {
        role: "user",
        content: `请基于以下数据写一份《AI 机会洞察日报》（${dateLabel}），结构为：## 今日要点（3-5 条加粗短句）、## 赛道动态（点评 3-4 个值得关注的赛道）、## 变现机会信号（结合话题热度榜给 3 条具体可执行的建议）、## 风险提示（1-2 条）。全文 500-800 字。${focusLine}

【数据】最近 ${input.lookbackDays} 天情报库总览${newCount ? `，本轮新增 ${newCount} 条` : ""}。

各赛道存量：
${sectorLines}

变现话题热度（前 12）：
${topicLines}

近 48 小时热门标题（节选）：
${titleLines}`,
      },
    ],
    { maxTokens: 2048, collectErrors: options.collectErrors }
  );

  if (!result || !result.content.trim()) return null;

  const config = await llm.getConfig();
  const title = `AI 机会洞察日报 · ${dateLabel}`;
  const inserted = await query(
    `INSERT INTO ai_reports (run_id, title, content_md, model, tokens_used, is_published, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [
      runId || null,
      title,
      result.content.trim(),
      config.model,
      result.promptTokens + result.completionTokens,
      toMysqlDateTime(new Date()),
    ]
  );
  if (options.usageCollector) {
    options.usageCollector.promptTokens += result.promptTokens;
    options.usageCollector.completionTokens += result.completionTokens;
  }
  return { id: inserted.insertId, title };
}

/**
 * 定时日报：北京时间每天 llm.reportHourBeijing（默认 5 点）后生成一次，按北京日去重。
 * 服务器分钟调度器和每轮抓取结束后都会调用，幂等。
 */
async function maybeGenerateDailyReport(runId, runStats, options = {}) {
  const reportEnabled = Boolean(await settings.get("llm.reportEnabled", false));
  if (!reportEnabled) return null;

  const reportHour = Number(await settings.get("llm.reportHourBeijing", 5));
  const beijingNow = new Date(Date.now() + 8 * 3600 * 1000);
  if (beijingNow.getUTCHours() < reportHour) return null;

  // 今天（北京日）已生成过则跳过
  const dayStartUtcMs =
    Date.UTC(beijingNow.getUTCFullYear(), beijingNow.getUTCMonth(), beijingNow.getUTCDate()) - 8 * 3600 * 1000;
  const existing = await query("SELECT id FROM ai_reports WHERE created_at >= ? LIMIT 1", [
    toMysqlDateTime(new Date(dayStartUtcMs)),
  ]);
  if (existing.length) return null;

  return generateReport(runId, runStats, options);
}

module.exports = { computeInsightStats, invalidateStats, generateReport, maybeGenerateDailyReport, collectReportInput };
