/**
 * 静态导出：把站点打包成纯静态文件（dist/），供 GitHub Pages 部署。
 * 静态版是只读镜像：hash 路由、无刷新按钮、无管理后台；数据烧录在 data.json。
 * 用法：node scripts/export-static.js   （需要 DATABASE_URL 环境变量）
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createPool, query } = require("../src/db");
const { ensureSchema } = require("../src/schema");
const dataSnapshot = require("../src/services/dataSnapshot");
const insights = require("../src/services/insights");
const { parseJsonColumn } = require("../src/util");

const ITEMS_PER_SECTOR = 30; // 每赛道至少打包的条目数
const RECENT_ITEMS = 400; // 额外打包的全局最新条目数

const rootDir = path.join(__dirname, "..");
const distDir = path.join(rootDir, "dist");

function mapItem(row, sectorNameById) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    sourceName: row.source_name,
    sourceType: row.source_type,
    region: row.source_region,
    language: row.source_language,
    sector: row.sector_id,
    sectorName: sectorNameById.get(row.sector_id) || row.sector_id,
    tags: parseJsonColumn(row.tags, []).map((id) => sectorNameById.get(id) || id),
    summary: row.ai_summary || row.summary || "",
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
  };
}

(async () => {
  createPool();
  await ensureSchema();

  console.log("[导出] 组装数据……");
  const snapshot = await dataSnapshot.getSnapshot();
  const insightStats = await insights.computeInsightStats();

  const sectors = await query("SELECT id, name FROM sectors");
  const sectorNameById = new Map(sectors.map((s) => [s.id, s.name]));
  const visibleSectors = await query("SELECT id FROM sectors WHERE is_visible = 1 ORDER BY sort_order");

  const itemSql = `
    SELECT i.id, i.title, i.url, i.tags, i.summary, i.ai_summary, i.published_at, i.sector_id,
           s.name AS source_name, s.type AS source_type, s.region AS source_region, s.language AS source_language
    FROM items i JOIN sources s ON s.id = i.source_id`;

  const pool = new Map();
  const recentRows = await query(
    `${itemSql} JOIN sectors sec ON sec.id = i.sector_id WHERE sec.is_visible = 1
     ORDER BY i.published_at DESC LIMIT ?`,
    [RECENT_ITEMS]
  );
  for (const row of recentRows) pool.set(row.id, row);
  for (const sector of visibleSectors) {
    const rows = await query(`${itemSql} WHERE i.sector_id = ? ORDER BY i.published_at DESC LIMIT ?`, [
      sector.id,
      ITEMS_PER_SECTOR,
    ]);
    for (const row of rows) pool.set(row.id, row);
  }
  const items = [...pool.values()]
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .map((row) => mapItem(row, sectorNameById));

  const countRows = await query(
    `SELECT i.sector_id, COUNT(*) AS n FROM items i JOIN sectors sec ON sec.id = i.sector_id
     WHERE sec.is_visible = 1 GROUP BY i.sector_id`
  );
  const sectorCounts = { all: 0 };
  for (const row of countRows) {
    sectorCounts[row.sector_id] = row.n;
    sectorCounts.all += row.n;
  }

  console.log(`[导出] 打包条目 ${items.length} 条（全库 ${sectorCounts.all} 条），写入 dist/ ……`);
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  // index.html：注入标题/描述 + 静态模式标记 + 相对资源路径
  const site = snapshot.payload.site || {};
  const escapeHtml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let html = fs.readFileSync(path.join(rootDir, "public", "index.html"), "utf8");
  html = html
    .replace("{{SITE_TITLE}}", escapeHtml(site.title || "AI 情报雷达"))
    .replace("{{SITE_META}}", escapeHtml(site.metaDescription || ""))
    .replace('href="/styles.css"', 'href="./styles.css"')
    .replace(
      '<script src="/app.js"></script>',
      '<script>window.__STATIC__ = true;</script>\n    <script src="./app.js"></script>'
    );
  fs.writeFileSync(path.join(distDir, "index.html"), html, "utf8");

  fs.copyFileSync(path.join(rootDir, "public", "styles.css"), path.join(distDir, "styles.css"));
  fs.copyFileSync(path.join(rootDir, "public", "app.js"), path.join(distDir, "app.js"));
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  for (const file of fs.readdirSync(path.join(rootDir, "public", "assets"))) {
    fs.copyFileSync(path.join(rootDir, "public", "assets", file), path.join(distDir, "assets", file));
  }

  fs.writeFileSync(
    path.join(distDir, "data.json"),
    JSON.stringify({
      exportedAt: new Date().toISOString(),
      data: snapshot.payload,
      insights: insightStats,
      items,
      sectorCounts,
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(distDir, ".nojekyll"), "", "utf8");

  const totalSize = fs.readdirSync(distDir).reduce((acc, f) => {
    const stat = fs.statSync(path.join(distDir, f));
    return acc + (stat.isFile() ? stat.size : 0);
  }, 0);
  console.log(`[导出] 完成：dist/（约 ${Math.round(totalSize / 1024)} KB + assets）`);
  process.exit(0);
})().catch((error) => {
  console.error("[导出] 失败：", error);
  process.exit(1);
});
