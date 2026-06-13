const { query } = require("../db");
const settings = require("../settings");
const { fetchFeed } = require("./feedParser");
const { resolveGoogleLinks, upgradeStoredLinks, isGoogleNewsLink, canonicalGoogleUrl } = require("./googleNews");
const { buildMatchers, classify, scoreItem } = require("./classifier");
const llm = require("./llm");
const insights = require("./insights");
const { sha1, normalizeUrl, runPool, toMysqlDateTime, parseJsonColumn } = require("../util");

// 抓取编排：锁 → 并发抓取 → 截断 → 解链 → 去重 → 分类 → 入库 → 清理 → LLM 摘要/日报 → 收尾。
// 单源失败、解链失败、LLM 失败都不影响整体 run 成功。

const state = {
  running: false,
  runId: null,
  startedAt: null,
  phase: "",
  lastPublicRefreshAt: 0,
};

function getState() {
  return { ...state };
}

/** 信号量：Google News 域单独限并发 */
function makeSemaphore(max) {
  let active = 0;
  const queue = [];
  return {
    async acquire() {
      if (active < max) {
        active++;
        return;
      }
      await new Promise((resolve) => queue.push(resolve));
      active++;
    },
    release() {
      active--;
      const next = queue.shift();
      if (next) next();
    },
  };
}

let snapshotInvalidator = null;
function onSnapshotInvalidate(fn) {
  snapshotInvalidator = fn;
}

async function cleanupZombieRuns() {
  await query(
    `UPDATE crawl_runs SET status = 'error', error = '进程中断（僵尸锁回收）', finished_at = NOW()
     WHERE status = 'running' AND started_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE)`
  );
}

/** 触发一次抓取（异步执行）。已在运行时抛 {code:'RUNNING'}。 */
async function runCrawl(triggerType = "manual") {
  if (state.running) {
    const error = new Error("已有抓取任务在运行");
    error.code = "RUNNING";
    throw error;
  }
  await cleanupZombieRuns();
  const activeRows = await query("SELECT id FROM crawl_runs WHERE status = 'running' LIMIT 1");
  if (activeRows.length) {
    const error = new Error("已有抓取任务在运行");
    error.code = "RUNNING";
    throw error;
  }

  const startedAt = new Date();
  const inserted = await query(
    "INSERT INTO crawl_runs (trigger_type, status, started_at) VALUES (?, 'running', ?)",
    [triggerType, toMysqlDateTime(startedAt)]
  );
  const runId = inserted.insertId;

  state.running = true;
  state.runId = runId;
  state.startedAt = startedAt;
  state.phase = "准备中";

  // 后台执行，不阻塞调用方
  executeRun(runId, startedAt)
    .catch(async (error) => {
      try {
        await query("UPDATE crawl_runs SET status = 'error', error = ?, finished_at = NOW() WHERE id = ?", [
          String(error && error.stack ? error.stack : error).slice(0, 2000),
          runId,
        ]);
      } catch (_) {
        /* 落库失败忽略 */
      }
    })
    .finally(() => {
      state.running = false;
      state.runId = null;
      state.phase = "";
      if (snapshotInvalidator) snapshotInvalidator();
    });

  return { runId };
}

async function executeRun(runId, startedAt) {
  const crawlConfig = await settings.getCategory("crawl");
  const llmConfig = await settings.getCategory("llm");
  const lookbackDays = Number(crawlConfig.lookbackDays) || 30;
  const cutoff = new Date(Date.now() - lookbackDays * 86400 * 1000);
  const concurrency = Number(crawlConfig.concurrency) || 12;

  llm.resetCircuit();

  const sources = await query("SELECT * FROM sources WHERE is_enabled = 1 ORDER BY sort_order");
  const sectors = await query("SELECT * FROM sectors ORDER BY sort_order");
  const compiled = buildMatchers(sectors);
  const sectorIds = new Set(sectors.map((s) => s.id));

  const stats = {
    generatedAt: null,
    startedAt: startedAt.toISOString(),
    lookbackDays,
    cutoffAt: cutoff.toISOString(),
    sourceCount: sources.length,
    fetchConcurrency: concurrency,
    linkResolution: null,
    okSourceCount: 0,
    failedSourceCount: 0,
    itemCount: 0,
    newItemCount: 0,
    failures: [],
    llm: { classified: 0, summarized: 0, reportGenerated: false, promptTokens: 0, completionTokens: 0, errors: [] },
  };
  const llmErrors = stats.llm.errors;
  const usageCollector = { promptTokens: 0, completionTokens: 0 };

  // ---------- 1. 并发抓取 ----------
  state.phase = `抓取 ${sources.length} 个来源`;
  // 特定站点限流：Google News 限 4 并发；Reddit 对未认证 RSS 限流极严，串行 + 间隔
  const hostLimits = [
    { match: "news.google.com", semaphore: makeSemaphore(4), delayMs: 0 },
    { match: "reddit.com", semaphore: makeSemaphore(1), delayMs: 1500 },
  ];
  const allEntries = [];
  const sourceResults = new Map();

  const tasks = sources.map((source) => async () => {
    const limit = hostLimits.find((h) => source.feed_url.includes(h.match));
    if (limit) {
      await limit.semaphore.acquire();
      if (limit.delayMs) await new Promise((r) => setTimeout(r, limit.delayMs));
    }
    try {
      const items = await fetchFeed(source.feed_url, {
        timeoutMs: Number(crawlConfig.timeoutMs) || 12000,
        maxItems: Number(crawlConfig.maxItemsPerSource) || 60,
      });
      const kept = items.filter((item) => item.publishedAt.getTime() >= cutoff.getTime());
      for (const item of kept) {
        allEntries.push({ ...item, source });
      }
      sourceResults.set(source.id, { ok: true, count: kept.length, error: null });
    } catch (error) {
      sourceResults.set(source.id, { ok: false, count: 0, error: String(error.message || error).slice(0, 300) });
      stats.failures.push({ source: source.name, url: source.feed_url, error: String(error.message || error).slice(0, 300) });
    } finally {
      if (limit) limit.semaphore.release();
    }
  });
  await runPool(tasks, concurrency);

  stats.okSourceCount = [...sourceResults.values()].filter((r) => r.ok).length;
  stats.failedSourceCount = sources.length - stats.okSourceCount;

  // ---------- 2. Google News 解链 ----------
  // 身份键在解析前确定：Google 条目用规范化文章链接（跨 feed、跨轮次稳定，避免
  // “首轮存 google 链接、次轮解析出原文链接”导致同文重复入库），其余用规范化原链。
  for (const entry of allEntries) {
    entry.identityUrl = isGoogleNewsLink(entry.link) ? canonicalGoogleUrl(entry.link) : null;
  }
  state.phase = "解析原文链接";
  stats.linkResolution = await resolveGoogleLinks(allEntries, {
    enabled: crawlConfig.resolveGoogleLinks !== false,
    maxPerRun: Number(crawlConfig.googleResolveMaxPerRun) || 150,
    concurrency: 6,
    timeoutMs: 8000,
  });

  // ---------- 3. 去重 ----------
  state.phase = "去重";
  const seen = new Map(); // urlHash -> entry
  for (const entry of allEntries) {
    const normalized = normalizeUrl(entry.link);
    const hash = sha1(entry.identityUrl || normalized);
    if (!seen.has(hash)) {
      entry.normalizedUrl = normalized;
      entry.urlHash = hash;
      seen.set(hash, entry);
    }
  }
  let candidates = [...seen.values()];

  const existingHashes = new Set();
  const hashList = candidates.map((e) => e.urlHash);
  for (let i = 0; i < hashList.length; i += 500) {
    const batch = hashList.slice(i, i + 500);
    const rows = await query(
      `SELECT url_hash FROM items WHERE url_hash IN (${batch.map(() => "?").join(",")})`,
      batch
    );
    for (const row of rows) existingHashes.add(row.url_hash);
  }
  candidates = candidates.filter((e) => !existingHashes.has(e.urlHash));

  // ---------- 4. 分类 ----------
  state.phase = `分类 ${candidates.length} 条新情报`;
  const unclassified = [];
  for (const entry of candidates) {
    const hint = entry.source.default_sector && sectorIds.has(entry.source.default_sector)
      ? entry.source.default_sector
      : null;
    const result = classify(entry, compiled, hint);
    if (result.sectorId) {
      entry.sectorId = result.sectorId;
      entry.tags = result.tags;
      entry.classifiedBy = result.classifiedBy;
    } else if (entry.source.type === "research" && sectorIds.has("research")) {
      entry.sectorId = "research";
      entry.tags = ["research"];
      entry.classifiedBy = "source";
    } else {
      unclassified.push(entry);
    }
  }

  // GLM 介入点 1：批量分类
  const classifyBudget = Number(llmConfig.classifyMaxPerRun) || 80;
  let classifyUsed = 0;
  const sectorMeta = sectors.map((s) => ({ id: s.id, name: s.name, description: s.description }));
  if (unclassified.length && llmConfig.enabled && llmConfig.classifyEnabled) {
    const queue = unclassified.slice(0, Math.min(unclassified.length, classifyBudget));
    state.phase = `GLM 分类 ${queue.length} 条`;
    for (let i = 0; i < queue.length; i += 10) {
      if (llm.isBroken()) break;
      const batch = queue.slice(i, i + 10);
      classifyUsed += batch.length;
      const mapping = await llm.classifyBatch(
        batch.map((entry, j) => ({ index: j, title: entry.title, summary: entry.summary })),
        sectorMeta,
        { collectErrors: llmErrors, usageCollector }
      );
      batch.forEach((entry, j) => {
        const sectorId = mapping.get(j);
        if (sectorId && sectorIds.has(sectorId)) {
          entry.sectorId = sectorId;
          entry.tags = [sectorId];
          entry.classifiedBy = "llm";
          stats.llm.classified++;
        }
      });
    }
  }

  // 兜底赛道
  const fallbackSector = sectorIds.has(crawlConfig.fallbackSector) ? crawlConfig.fallbackSector : sectors[0].id;
  for (const entry of candidates) {
    if (!entry.sectorId) {
      entry.sectorId = fallbackSector;
      entry.tags = [fallbackSector];
      entry.classifiedBy = "fallback";
    }
  }

  // ---------- 5. 入库 ----------
  state.phase = `写入 ${candidates.length} 条`;
  let inserted = 0;
  for (let i = 0; i < candidates.length; i += 200) {
    const batch = candidates.slice(i, i + 200);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
    const params = [];
    for (const entry of batch) {
      params.push(
        "item-" + entry.urlHash.slice(0, 12),
        entry.urlHash,
        entry.title.slice(0, 510),
        entry.normalizedUrl.slice(0, 2048),
        entry.source.id,
        entry.sectorId,
        JSON.stringify(entry.tags),
        entry.summary || null,
        toMysqlDateTime(entry.publishedAt),
        scoreItem(entry, entry.source.type, entry.tags.length),
        entry.classifiedBy
      );
    }
    const result = await query(
      `INSERT IGNORE INTO items (id, url_hash, title, url, source_id, sector_id, tags, summary, published_at, score, classified_by)
       VALUES ${placeholders}`,
      params
    );
    inserted += result.affectedRows || 0;
  }
  stats.newItemCount = inserted;

  // 更新来源状态
  state.phase = "更新来源状态";
  const now = toMysqlDateTime(new Date());
  for (const source of sources) {
    const result = sourceResults.get(source.id) || { ok: false, count: 0, error: "未执行" };
    await query(
      `UPDATE sources SET last_ok = ?, last_via = 'fetch', last_count = ?, last_error = ?, last_fetched_at = ? WHERE id = ?`,
      [result.ok ? 1 : 0, result.count, result.error, now, source.id]
    );
  }

  // ---------- 6. 过期清理 ----------
  state.phase = "清理过期数据";
  for (;;) {
    const result = await query("DELETE FROM items WHERE published_at < ? LIMIT 1000", [toMysqlDateTime(cutoff)]);
    if (!result.affectedRows) break;
  }
  await query("DELETE FROM link_cache WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)");

  // ---------- 6.5 存量 Google 链接升级 ----------
  if (crawlConfig.resolveGoogleLinks !== false) {
    state.phase = "升级存量 Google 链接";
    try {
      stats.linkUpgrade = await upgradeStoredLinks({
        maxPerRun: Number(crawlConfig.googleResolveMaxPerRun) || 150,
        concurrency: 6,
        timeoutMs: 8000,
      });
    } catch (error) {
      stats.linkUpgrade = { error: String(error.message || error).slice(0, 200) };
    }
  }

  // ---------- 6.6 GLM 介入点 1b：历史 fallback 条目重分类 ----------
  if (llmConfig.enabled && llmConfig.classifyEnabled && !llm.isBroken() && classifyUsed < classifyBudget) {
    const budgetLeft = classifyBudget - classifyUsed;
    const fallbackRows = await query(
      "SELECT id, title, summary FROM items WHERE classified_by = 'fallback' ORDER BY published_at DESC LIMIT ?",
      [budgetLeft]
    );
    if (fallbackRows.length) {
      state.phase = `GLM 重分类历史条目 ${fallbackRows.length} 条`;
      for (let i = 0; i < fallbackRows.length; i += 10) {
        if (llm.isBroken()) break;
        const batch = fallbackRows.slice(i, i + 10);
        const mapping = await llm.classifyBatch(
          batch.map((row, j) => ({ index: j, title: row.title, summary: row.summary })),
          sectorMeta,
          { collectErrors: llmErrors, usageCollector }
        );
        for (const [j, sectorId] of mapping.entries()) {
          if (batch[j] && sectorIds.has(sectorId)) {
            await query(
              "UPDATE items SET sector_id = ?, tags = ?, classified_by = 'llm' WHERE id = ? AND classified_by = 'fallback'",
              [sectorId, JSON.stringify([sectorId]), batch[j].id]
            );
            stats.llm.classified++;
          }
        }
      }
    }
  }

  // ---------- 7. GLM 介入点 2：中文摘要 ----------
  if (llmConfig.enabled && llmConfig.summaryEnabled && !llm.isBroken()) {
    const limit = Number(llmConfig.summaryMaxPerRun) || 20;
    const rows = await query(
      `SELECT i.id, i.title, i.summary FROM items i
       JOIN sources s ON s.id = i.source_id
       WHERE i.ai_summary IS NULL AND s.language = 'en'
         AND i.published_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
       ORDER BY i.score DESC, i.published_at DESC LIMIT ?`,
      [limit]
    );
    if (rows.length) {
      state.phase = `GLM 摘要 ${rows.length} 条`;
      for (let i = 0; i < rows.length; i += 5) {
        if (llm.isBroken()) break;
        const batch = rows.slice(i, i + 5);
        const mapping = await llm.summarizeBatch(
          batch.map((row, j) => ({ index: j, title: row.title, summary: row.summary })),
          { collectErrors: llmErrors, usageCollector }
        );
        for (const [j, summary] of mapping.entries()) {
          if (batch[j]) {
            await query("UPDATE items SET ai_summary = ? WHERE id = ?", [summary, batch[j].id]);
            stats.llm.summarized++;
          }
        }
      }
    }
  }

  // ---------- 8. GLM 介入点 3：洞察日报（北京时间每日定点一次，幂等） ----------
  insights.invalidateStats();
  if (llmConfig.enabled && llmConfig.reportEnabled && !llm.isBroken()) {
    state.phase = "检查每日洞察日报";
    try {
      const report = await insights.maybeGenerateDailyReport(runId, stats, { collectErrors: llmErrors, usageCollector });
      stats.llm.reportGenerated = Boolean(report);
    } catch (error) {
      llmErrors.push(String(error.message || error).slice(0, 200));
    }
  }

  // ---------- 9. 收尾 ----------
  stats.llm.promptTokens = usageCollector.promptTokens;
  stats.llm.completionTokens = usageCollector.completionTokens;
  const totalRows = await query("SELECT COUNT(*) AS n FROM items");
  stats.itemCount = totalRows[0].n;
  stats.generatedAt = new Date().toISOString();

  await query("UPDATE crawl_runs SET status = 'ok', finished_at = NOW(), stats = ? WHERE id = ?", [
    JSON.stringify(stats),
    runId,
  ]);
  return stats;
}

async function lastRun() {
  const rows = await query("SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 1");
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: row.id,
    triggerType: row.trigger_type,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stats: parseJsonColumn(row.stats, null),
    error: row.error,
  };
}

// 定时器：每 60s 检查 intervalMinutes 是否到期
function startScheduler() {
  setInterval(async () => {
    try {
      if (state.running) return;
      const intervalMinutes = Number(await settings.get("crawl.intervalMinutes", 360));
      if (!intervalMinutes) return;
      const last = await lastRun();
      const lastTime = last && last.startedAt ? new Date(last.startedAt).getTime() : 0;
      if (Date.now() - lastTime >= intervalMinutes * 60 * 1000) {
        await runCrawl("schedule");
      }
    } catch (_) {
      /* 调度失败下一轮再试 */
    }
  }, 60 * 1000).unref();
}

module.exports = { runCrawl, getState, lastRun, startScheduler, onSnapshotInvalidate, state };
