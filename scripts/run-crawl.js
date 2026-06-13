// 手动跑一轮抓取（开发调试用 / CI 抓取）：node scripts/run-crawl.js [--no-llm]
require("dotenv").config();
const { createPool, query } = require("../src/db");
const { ensureSchema } = require("../src/schema");
const { seedIfNeeded } = require("../src/seed");
const settings = require("../src/settings");
const crawler = require("../src/services/crawler");

// 启动前自检：明确报出 DATABASE_URL 是否就绪（CI 里 Secret 没配好时一眼可见）
function preflight() {
  const url = process.env.DATABASE_URL || "";
  if (!url) {
    console.error("[自检] ✗ DATABASE_URL 未设置。GitHub Actions 请到 仓库 Settings → Secrets and variables → Actions 添加名为 DATABASE_URL 的 Repository secret。");
    process.exit(1);
  }
  try {
    const u = new URL(url);
    console.log(`[自检] ✓ DATABASE_URL 已就绪（协议 ${u.protocol.replace(":", "")}，主机 ${u.hostname}，库 ${decodeURIComponent(u.pathname.replace(/^\//, ""))}，长度 ${url.length}）`);
  } catch (error) {
    console.error(`[自检] ✗ DATABASE_URL 格式无法解析（${error.message}）。请检查值里是否多了引号、空格或换行。`);
    process.exit(1);
  }
  console.log(`[自检] GLM_API_KEY ${process.env.GLM_API_KEY ? "已设置" : "未设置（将无法生成 AI 摘要/日报，但不影响抓取）"}`);
}

(async () => {
  preflight();
  createPool();
  await ensureSchema();
  await seedIfNeeded();

  if (process.argv.includes("--no-llm")) {
    await settings.set("llm.enabled", false);
    console.log("LLM 已临时关闭");
  }
  if (process.argv.includes("--llm")) {
    await settings.set("llm.enabled", true);
    console.log("LLM 已开启");
  }

  const t0 = Date.now();
  await crawler.runCrawl("manual");
  // 轮询直到完成
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const state = crawler.getState();
    if (!state.running) break;
    process.stdout.write(`\r[${Math.round((Date.now() - t0) / 1000)}s] ${state.phase}        `);
  }
  console.log();
  const run = await crawler.lastRun();
  console.log("status:", run.status);
  if (run.error) console.log("error:", run.error.slice(0, 500));
  if (run.stats) {
    const s = run.stats;
    console.log(`sources ok/total: ${s.okSourceCount}/${s.sourceCount}`);
    console.log(`items total: ${s.itemCount}, new: ${s.newItemCount}`);
    console.log("linkResolution:", JSON.stringify(s.linkResolution));
    console.log("llm:", JSON.stringify(s.llm));
    console.log("failures:", s.failures.length);
    s.failures.slice(0, 8).forEach((f) => console.log("  -", f.source, "|", f.error));
  }
  const bySector = await query(
    "SELECT s.name, COUNT(*) n FROM items i JOIN sectors s ON s.id=i.sector_id GROUP BY s.name ORDER BY n DESC"
  );
  console.log("items by sector:", bySector.map((r) => `${r.name}:${r.n}`).join(" "));
  const byMethod = await query("SELECT classified_by, COUNT(*) n FROM items GROUP BY classified_by");
  console.log("classified_by:", byMethod.map((r) => `${r.classified_by}:${r.n}`).join(" "));
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
