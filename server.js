require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const compression = require("compression");

const { createPool, query } = require("./src/db");
const { ensureSchema } = require("./src/schema");
const { seedIfNeeded } = require("./src/seed");
const settings = require("./src/settings");
const { proxyStatus } = require("./src/net");
const crawler = require("./src/services/crawler");
const insights = require("./src/services/insights");
const dataSnapshot = require("./src/services/dataSnapshot");
const publicRoutes = require("./src/routes/public");
const adminRoutes = require("./src/routes/admin");

const PORT = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, "public");

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main() {
  createPool();
  const versionRows = await query("SELECT VERSION() AS v");
  console.log(`[启动] MySQL ${versionRows[0].v}`);
  await ensureSchema();
  console.log("[启动] 表结构就绪");
  const { seeded } = await seedIfNeeded();
  console.log(seeded ? "[启动] 种子数据已写入" : "[启动] 种子数据已存在，跳过");
  console.log(`[启动] 出网代理：${(await proxyStatus()).text}`);

  const app = express();
  app.disable("x-powered-by");
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));

  // 多页面：同一个壳，前端按路径渲染对应模块（注入站点标题与 SEO 描述）
  const indexTemplate = () => fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const PAGE_PATHS = ["/", "/leaderboard", "/insights", "/report", "/sources", "/method"];
  app.get(PAGE_PATHS, async (req, res, next) => {
    try {
      const html = indexTemplate()
        .replace("{{SITE_TITLE}}", escapeHtml(await settings.get("site.title", "AI 情报雷达")))
        .replace("{{SITE_META}}", escapeHtml(await settings.get("site.metaDescription", "")));
      res.type("html").send(html);
    } catch (error) {
      next(error);
    }
  });
  app.get("/admin", (req, res) => {
    res.sendFile(path.join(publicDir, "admin", "index.html"));
  });

  app.use(publicRoutes);
  app.use(adminRoutes);
  app.use(express.static(publicDir, { index: false, maxAge: "10m" }));

  // 统一错误处理
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    console.error("[错误]", error);
    res.status(500).json({ ok: false, error: String(error.message || error).slice(0, 300) });
  });

  app.listen(PORT, () => {
    console.log(`[启动] http://localhost:${PORT}  (管理后台 /admin)`);
  });

  // 首次启动：库为空则自动抓取一次
  const itemRows = await query("SELECT COUNT(*) AS n FROM items");
  if (itemRows[0].n === 0) {
    console.log("[启动] 情报库为空，自动触发首次抓取");
    crawler.runCrawl("startup").catch((error) => console.error("[启动抓取失败]", error.message));
  }

  crawler.startScheduler();

  // 每日洞察日报：北京时间 llm.reportHourBeijing（默认 5 点）后生成一次，按日去重幂等
  setInterval(async () => {
    try {
      const report = await insights.maybeGenerateDailyReport(null, null);
      if (report) {
        dataSnapshot.invalidate();
        console.log(`[日报] 已生成：${report.title}`);
      }
    } catch (error) {
      console.error("[日报] 生成失败：", error.message);
    }
  }, 60 * 1000).unref();
}

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

main().catch((error) => {
  console.error("[启动失败]", error);
  process.exit(1);
});
