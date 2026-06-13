const express = require("express");
const { query, transaction } = require("../db");
const settings = require("../settings");
const auth = require("../auth");
const users = require("../users");
const { proxyStatus } = require("../net");
const crawler = require("../services/crawler");
const dataSnapshot = require("../services/dataSnapshot");
const insights = require("../services/insights");
const llm = require("../services/llm");
const { fetchFeed } = require("../services/feedParser");
const { buildMatchers, classify } = require("../services/classifier");
const { slugify, parseJsonColumn } = require("../util");

const router = express.Router();
const base = "/api/admin";

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------- 登录（用户名 + 密码，所有角色统一入口） ----------
router.post(
  `${base}/login`,
  asyncHandler(async (req, res) => {
    const ip = clientIp(req);
    if (auth.isLoginBlocked(ip)) {
      return res.status(429).json({ ok: false, error: "失败次数过多，请 10 分钟后再试" });
    }
    const username = users.normalizeUsername(req.body && req.body.username);
    const password = String((req.body && req.body.password) || "");
    const user = await users.getByUsername(username);
    if (!user || !user.isEnabled || !auth.verifyPassword(password, user.passwordHash)) {
      auth.recordLoginFailure(ip);
      return res.status(401).json({ ok: false, error: "用户名或密码错误" });
    }
    auth.clearLoginFailures(ip);
    const { token, expiresAt } = await auth.issueToken(user);
    res.json({ ok: true, token, expiresAt, username: user.username, role: user.role });
  })
);

// 以下均需登录
router.use(base, auth.requireAuth);

// 当前登录用户信息
router.get(
  `${base}/me`,
  asyncHandler(async (req, res) => {
    res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role, profile: req.user.profile } });
  })
);

// 自助：修改自己的密码（仅失效自己的旧 token）
router.post(
  `${base}/password`,
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!auth.verifyPassword(String(oldPassword || ""), req.user.passwordHash)) {
      return res.status(400).json({ ok: false, error: "原密码错误" });
    }
    const result = await users.updatePassword(req.user.id, String(newPassword || ""));
    if (!result.ok) return res.status(400).json(result);
    const fresh = await users.getById(req.user.id);
    const { token, expiresAt } = await auth.issueToken(fresh);
    res.json({ ok: true, token, expiresAt });
  })
);

// 自助：读取个人主页配置 + 可选项（赛道/话题列表）
router.get(
  `${base}/profile`,
  asyncHandler(async (req, res) => {
    const [sectors, topics] = await Promise.all([
      query("SELECT id, name FROM sectors WHERE is_visible = 1 ORDER BY sort_order, id"),
      query("SELECT id, title FROM insight_topics WHERE is_visible = 1 ORDER BY sort_order, id"),
    ]);
    res.json({ profile: req.user.profile, username: req.user.username, role: req.user.role, sectors, topics });
  })
);

// 自助：保存个人主页配置
router.put(
  `${base}/profile`,
  asyncHandler(async (req, res) => {
    const result = await users.setProfile(req.user.id, req.body && req.body.profile);
    res.json(result);
  })
);

// ---------- 以下为管理员专属 ----------
router.use(base, auth.requireAdmin);

// 用户管理
router.get(
  `${base}/users`,
  asyncHandler(async (req, res) => {
    res.json({ users: await users.list() });
  })
);

router.post(
  `${base}/users`,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await users.create({ username: body.username, password: body.password, role: "user" });
    res.status(result.ok ? 200 : 400).json(result);
  })
);

router.put(
  `${base}/users/:id`,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await users.getById(id);
    if (!target) return res.status(404).json({ ok: false, error: "用户不存在" });
    const body = req.body || {};
    if (body.username !== undefined) {
      const result = await users.rename(id, body.username);
      if (!result.ok) return res.status(400).json(result);
      if (target.role === "admin") await settings.set("admin.username", result.username);
    }
    if (body.isEnabled !== undefined) {
      if (target.role === "admin" && !body.isEnabled) {
        return res.status(400).json({ ok: false, error: "不能停用管理员" });
      }
      await users.setEnabled(id, Boolean(body.isEnabled));
    }
    res.json({ ok: true });
  })
);

router.post(
  `${base}/users/:id/password`,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await users.getById(id);
    if (!target) return res.status(404).json({ ok: false, error: "用户不存在" });
    const result = await users.updatePassword(id, String((req.body && req.body.newPassword) || ""));
    res.status(result.ok ? 200 : 400).json(result);
  })
);

router.delete(
  `${base}/users/:id`,
  asyncHandler(async (req, res) => {
    const result = await users.remove(Number(req.params.id));
    res.status(result.ok ? 200 : 400).json(result);
  })
);

// ---------- 概览 ----------
router.get(
  `${base}/overview`,
  asyncHandler(async (req, res) => {
    const [counts] = await Promise.all([
      query(`SELECT
        (SELECT COUNT(*) FROM items) AS items,
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM sources WHERE is_enabled = 1) AS enabledSources,
        (SELECT COUNT(*) FROM sectors) AS sectors,
        (SELECT COUNT(*) FROM insight_topics) AS topics,
        (SELECT COUNT(*) FROM ai_reports) AS reports`),
    ]);
    const runs = await query("SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 5");
    const usage = await llm.todayUsage();
    const failingSources = await query(
      "SELECT id, name, last_error FROM sources WHERE is_enabled = 1 AND last_ok = 0 ORDER BY sort_order LIMIT 30"
    );
    res.json({
      counts: counts[0],
      crawlerState: crawler.getState(),
      proxy: await proxyStatus(),
      runs: runs.map((r) => ({ ...r, stats: parseJsonColumn(r.stats, null) })),
      llmUsageToday: usage,
      failingSources,
    });
  })
);

// ---------- 通用排序 ----------
function orderEndpoint(table) {
  return asyncHandler(async (req, res) => {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ ok: false, error: "ids 必须是非空数组" });
    }
    await transaction(async (q) => {
      for (let i = 0; i < ids.length; i++) {
        await q(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [(i + 1) * 10, ids[i]]);
      }
    });
    dataSnapshot.invalidate();
    res.json({ ok: true });
  });
}

// ---------- 赛道 ----------
router.get(
  `${base}/sectors`,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.sector_id = s.id) AS item_count
       FROM sectors s ORDER BY s.sort_order, s.id`
    );
    res.json({
      sectors: rows.map((r) => ({ ...r, keywords: parseJsonColumn(r.keywords, []) })),
    });
  })
);

router.post(
  `${base}/sectors`,
  asyncHandler(async (req, res) => {
    const { id, name, description = "", keywords = [], is_visible = 1 } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: "缺少名称" });
    const slug = slugify(id || name);
    const existing = await query("SELECT id FROM sectors WHERE id = ?", [slug]);
    if (existing.length) return res.status(409).json({ ok: false, error: `ID ${slug} 已存在` });
    const maxRows = await query("SELECT COALESCE(MAX(sort_order), 0) AS m FROM sectors");
    await query(
      "INSERT INTO sectors (id, name, description, keywords, sort_order, is_visible) VALUES (?, ?, ?, ?, ?, ?)",
      [slug, name, description, JSON.stringify(keywords), maxRows[0].m + 10, is_visible ? 1 : 0]
    );
    dataSnapshot.invalidate();
    res.json({ ok: true, id: slug });
  })
);

router.put(`${base}/sectors/order`, orderEndpoint("sectors"));

router.put(
  `${base}/sectors/:id`,
  asyncHandler(async (req, res) => {
    const { name, description, keywords, is_visible } = req.body || {};
    const rows = await query("SELECT id FROM sectors WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "赛道不存在" });
    const sets = [];
    const params = [];
    if (name !== undefined) { sets.push("name = ?"); params.push(name); }
    if (description !== undefined) { sets.push("description = ?"); params.push(description); }
    if (keywords !== undefined) { sets.push("keywords = ?"); params.push(JSON.stringify(keywords)); }
    if (is_visible !== undefined) { sets.push("is_visible = ?"); params.push(is_visible ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ ok: false, error: "没有要更新的字段" });
    params.push(req.params.id);
    await query(`UPDATE sectors SET ${sets.join(", ")} WHERE id = ?`, params);
    dataSnapshot.invalidate();
    res.json({ ok: true });
  })
);

router.delete(
  `${base}/sectors/:id`,
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const countRows = await query("SELECT COUNT(*) AS n FROM items WHERE sector_id = ?", [id]);
    const itemCount = countRows[0].n;
    const reassignTo = req.query.reassignTo;
    if (itemCount > 0 && !reassignTo) {
      return res.status(409).json({ ok: false, itemCount, error: `该赛道还有 ${itemCount} 条情报，请指定转移目标赛道` });
    }
    if (reassignTo) {
      const target = await query("SELECT id FROM sectors WHERE id = ?", [reassignTo]);
      if (!target.length || reassignTo === id) {
        return res.status(400).json({ ok: false, error: "转移目标赛道无效" });
      }
      await query("UPDATE items SET sector_id = ? WHERE sector_id = ?", [reassignTo, id]);
    }
    await query("UPDATE sources SET default_sector = NULL WHERE default_sector = ?", [id]);
    await query("DELETE FROM sectors WHERE id = ?", [id]);
    dataSnapshot.invalidate();
    res.json({ ok: true, reassigned: itemCount });
  })
);

// 全量重分类（manual 豁免）
router.post(
  `${base}/items/reclassify`,
  asyncHandler(async (req, res) => {
    const sectors = await query("SELECT * FROM sectors ORDER BY sort_order");
    const compiled = buildMatchers(sectors);
    const sectorIds = new Set(sectors.map((s) => s.id));
    const items = await query(
      `SELECT i.id, i.title, i.summary, i.sector_id, i.tags, s.default_sector, s.type AS source_type
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.classified_by != 'manual'`
    );
    let changed = 0;
    for (const item of items) {
      const hint = item.default_sector && sectorIds.has(item.default_sector) ? item.default_sector : null;
      const result = classify({ title: item.title, summary: item.summary }, compiled, hint);
      let sectorId = result.sectorId;
      let tags = result.tags;
      let classifiedBy = result.classifiedBy;
      if (!sectorId && item.source_type === "research" && sectorIds.has("research")) {
        sectorId = "research";
        tags = ["research"];
        classifiedBy = "source";
      }
      if (!sectorId) continue; // 关键词判不出的保持原状（LLM 在抓取时兜底）
      const oldTags = JSON.stringify(parseJsonColumn(item.tags, []));
      if (sectorId !== item.sector_id || JSON.stringify(tags) !== oldTags) {
        await query("UPDATE items SET sector_id = ?, tags = ?, classified_by = ? WHERE id = ?", [
          sectorId,
          JSON.stringify(tags),
          classifiedBy,
          item.id,
        ]);
        changed++;
      }
    }
    dataSnapshot.invalidate();
    res.json({ ok: true, scanned: items.length, changed });
  })
);

// ---------- 来源库 ----------
router.get(
  `${base}/sources`,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS item_count
       FROM sources s ORDER BY s.sort_order, s.id`
    );
    res.json({ sources: rows });
  })
);

router.post(
  `${base}/sources`,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (!body.name || !body.feed_url) return res.status(400).json({ ok: false, error: "缺少名称或 Feed 地址" });
    const slug = slugify(body.id || body.name);
    const existing = await query("SELECT id FROM sources WHERE id = ?", [slug]);
    if (existing.length) return res.status(409).json({ ok: false, error: `ID ${slug} 已存在` });
    const maxRows = await query("SELECT COALESCE(MAX(sort_order), 0) AS m FROM sources");
    await query(
      `INSERT INTO sources (id, name, homepage, feed_url, type, region, language, default_sector, is_enabled, sort_order, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        body.name,
        body.homepage || "",
        body.feed_url,
        ["official", "research", "media", "analysis"].includes(body.type) ? body.type : "media",
        body.region || "Global",
        body.language || "en",
        body.default_sector || null,
        body.is_enabled === 0 || body.is_enabled === false ? 0 : 1,
        maxRows[0].m + 10,
        body.notes || "",
      ]
    );
    dataSnapshot.invalidate();
    res.json({ ok: true, id: slug });
  })
);

router.put(`${base}/sources/order`, orderEndpoint("sources"));

router.put(
  `${base}/sources/:id`,
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT id FROM sources WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "来源不存在" });
    const body = req.body || {};
    const fields = {
      name: body.name,
      homepage: body.homepage,
      feed_url: body.feed_url,
      type: ["official", "research", "media", "analysis"].includes(body.type) ? body.type : undefined,
      region: body.region,
      language: body.language,
      default_sector: body.default_sector === "" ? null : body.default_sector,
      is_enabled: body.is_enabled === undefined ? undefined : body.is_enabled ? 1 : 0,
      notes: body.notes,
    };
    const sets = [];
    const params = [];
    for (const [column, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: "没有要更新的字段" });
    params.push(req.params.id);
    await query(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`, params);
    dataSnapshot.invalidate();
    res.json({ ok: true });
  })
);

router.delete(
  `${base}/sources/:id`,
  asyncHandler(async (req, res) => {
    const countRows = await query("SELECT COUNT(*) AS n FROM items WHERE source_id = ?", [req.params.id]);
    const itemCount = countRows[0].n;
    if (itemCount > 0 && req.query.confirm !== "1") {
      return res.status(409).json({ ok: false, itemCount, error: `删除该来源会级联删除 ${itemCount} 条情报，确认请加 confirm=1` });
    }
    await query("DELETE FROM sources WHERE id = ?", [req.params.id]);
    dataSnapshot.invalidate();
    res.json({ ok: true, deletedItems: itemCount });
  })
);

// 来源测试抓取（不入库）
router.post(
  `${base}/sources/:id/test`,
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM sources WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "来源不存在" });
    try {
      const items = await fetchFeed(rows[0].feed_url, { timeoutMs: 15000, maxItems: 10 });
      res.json({ ok: true, count: items.length, sampleTitles: items.slice(0, 5).map((i) => i.title) });
    } catch (error) {
      res.json({ ok: false, error: String(error.message || error).slice(0, 300) });
    }
  })
);

// 测试任意 Feed 地址（新增来源前验证）
router.post(
  `${base}/sources/test-url`,
  asyncHandler(async (req, res) => {
    const feedUrl = String((req.body && req.body.feed_url) || "");
    if (!/^https?:\/\//.test(feedUrl)) return res.status(400).json({ ok: false, error: "无效的 Feed 地址" });
    try {
      const items = await fetchFeed(feedUrl, { timeoutMs: 15000, maxItems: 10 });
      res.json({ ok: true, count: items.length, sampleTitles: items.slice(0, 5).map((i) => i.title) });
    } catch (error) {
      res.json({ ok: false, error: String(error.message || error).slice(0, 300) });
    }
  })
);

// ---------- 洞察话题 ----------
router.get(
  `${base}/topics`,
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM insight_topics ORDER BY sort_order, id");
    res.json({
      topics: rows.map((r) => ({
        ...r,
        keywords: parseJsonColumn(r.keywords, []),
        tools: parseJsonColumn(r.tools, []),
        actions: parseJsonColumn(r.actions, []),
      })),
    });
  })
);

router.post(
  `${base}/topics`,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (!body.title) return res.status(400).json({ ok: false, error: "缺少标题" });
    const slug = slugify(body.id || body.title);
    const existing = await query("SELECT id FROM insight_topics WHERE id = ?", [slug]);
    if (existing.length) return res.status(409).json({ ok: false, error: `ID ${slug} 已存在` });
    const maxRows = await query("SELECT COALESCE(MAX(sort_order), 0) AS m FROM insight_topics");
    await query(
      `INSERT INTO insight_topics
         (id, title, thesis, signal_text, keywords, metric_label, best_for, opportunity, threshold_text, tools, first_action, actions, sort_order, is_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        body.title,
        body.thesis || "",
        body.signal_text || "",
        JSON.stringify(body.keywords || []),
        body.metric_label || "",
        body.best_for || "",
        body.opportunity || "",
        body.threshold_text || "",
        JSON.stringify(body.tools || []),
        body.first_action || "",
        JSON.stringify(body.actions || []),
        maxRows[0].m + 10,
        body.is_visible === 0 || body.is_visible === false ? 0 : 1,
      ]
    );
    dataSnapshot.invalidate();
    res.json({ ok: true, id: slug });
  })
);

router.put(`${base}/topics/order`, orderEndpoint("insight_topics"));

router.put(
  `${base}/topics/:id`,
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT id FROM insight_topics WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "话题不存在" });
    const body = req.body || {};
    const jsonFields = new Set(["keywords", "tools", "actions"]);
    const allowed = [
      "title", "thesis", "signal_text", "keywords", "metric_label", "best_for",
      "opportunity", "threshold_text", "tools", "first_action", "actions", "is_visible", "is_pinned",
    ];
    const sets = [];
    const params = [];
    for (const field of allowed) {
      if (body[field] === undefined) continue;
      sets.push(`${field} = ?`);
      if (jsonFields.has(field)) params.push(JSON.stringify(body[field]));
      else if (field === "is_visible" || field === "is_pinned") params.push(body[field] ? 1 : 0);
      else params.push(body[field]);
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: "没有要更新的字段" });
    params.push(req.params.id);
    await query(`UPDATE insight_topics SET ${sets.join(", ")} WHERE id = ?`, params);
    dataSnapshot.invalidate();
    res.json({ ok: true });
  })
);

router.delete(
  `${base}/topics/:id`,
  asyncHandler(async (req, res) => {
    await query("DELETE FROM insight_topics WHERE id = ?", [req.params.id]);
    dataSnapshot.invalidate();
    res.json({ ok: true });
  })
);

// ---------- 页面模块 ----------
router.get(
  `${base}/modules`,
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM modules ORDER BY sort_order, id");
    res.json({
      modules: rows.map((r) => ({
        ...r,
        nav_items: parseJsonColumn(r.nav_items, []),
        settings: parseJsonColumn(r.settings, {}),
      })),
    });
  })
);

router.put(`${base}/modules/order`, orderEndpoint("modules"));

router.put(
  `${base}/modules/:id`,
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT id FROM modules WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "模块不存在" });
    const body = req.body || {};
    const sets = [];
    const params = [];
    if (body.is_visible !== undefined) {
      sets.push("is_visible = ?");
      params.push(body.is_visible ? 1 : 0);
    }
    if (body.settings !== undefined) {
      if (typeof body.settings !== "object" || Array.isArray(body.settings)) {
        return res.status(400).json({ ok: false, error: "settings 必须是对象" });
      }
      sets.push("settings = ?");
      params.push(JSON.stringify(body.settings));
    }
    if (body.nav_items !== undefined) {
      if (!Array.isArray(body.nav_items)) {
        return res.status(400).json({ ok: false, error: "nav_items 必须是数组" });
      }
      sets.push("nav_items = ?");
      params.push(JSON.stringify(body.nav_items));
    }
    if (body.name !== undefined) {
      sets.push("name = ?");
      params.push(String(body.name));
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: "没有要更新的字段" });
    params.push(req.params.id);
    await query(`UPDATE modules SET ${sets.join(", ")} WHERE id = ?`, params);
    dataSnapshot.invalidate();
    res.json({ ok: true });
  })
);

// ---------- 系统设置 ----------
function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  return `****${text.slice(-4)}`;
}

router.get(
  `${base}/settings`,
  asyncHandler(async (req, res) => {
    const all = await settings.listAll();
    const grouped = {};
    for (const entry of all) {
      if (entry.category === "seed") continue;
      if (entry.setting_key === "admin.passwordHash" || entry.setting_key === "admin.tokenSecret") continue;
      if (!grouped[entry.category]) grouped[entry.category] = [];
      grouped[entry.category].push({
        key: entry.setting_key,
        value: entry.type === "secret" ? maskSecret(entry.value) : entry.value,
        type: entry.type,
        label: entry.label,
        description: entry.description,
      });
    }
    res.json({ settings: grouped });
  })
);

router.put(
  `${base}/settings`,
  asyncHandler(async (req, res) => {
    const updates = (req.body && req.body.settings) || {};
    const all = new Map((await settings.listAll()).map((s) => [s.setting_key, s]));
    let updated = 0;
    for (const [key, value] of Object.entries(updates)) {
      const existing = all.get(key);
      if (!existing) continue;
      if (key === "admin.passwordHash" || key === "admin.tokenSecret" || existing.category === "seed") continue;
      // secret 字段收到掩码值（****xxxx）则跳过不覆盖
      if (existing.type === "secret" && /^\*{4}/.test(String(value))) continue;
      let coerced = value;
      if (existing.type === "number") coerced = Number(value);
      if (existing.type === "boolean") coerced = value === true || value === "true" || value === 1 || value === "1";
      await settings.set(key, coerced);
      updated++;
    }
    dataSnapshot.invalidate();
    res.json({ ok: true, updated });
  })
);

// ---------- 情报条目 ----------
router.get(
  `${base}/items`,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 50;
    const where = [];
    const params = [];
    if (req.query.q) {
      where.push("(i.title LIKE ? OR i.summary LIKE ?)");
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    if (req.query.sector) {
      where.push("i.sector_id = ?");
      params.push(req.query.sector);
    }
    if (req.query.source) {
      where.push("i.source_id = ?");
      params.push(req.query.source);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countRows = await query(`SELECT COUNT(*) AS n FROM items i ${whereSql}`, params);
    const rows = await query(
      `SELECT i.id, i.title, i.url, i.source_id, i.sector_id, i.published_at, i.score, i.classified_by,
              i.ai_summary IS NOT NULL AS has_ai_summary,
              s.name AS source_name, sec.name AS sector_name
       FROM items i
       JOIN sources s ON s.id = i.source_id
       JOIN sectors sec ON sec.id = i.sector_id
       ${whereSql}
       ORDER BY i.published_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    res.json({ items: rows, total: countRows[0].n, page, pageSize });
  })
);

router.put(
  `${base}/items/:id`,
  asyncHandler(async (req, res) => {
    const sectorId = req.body && req.body.sector_id;
    if (!sectorId) return res.status(400).json({ ok: false, error: "缺少 sector_id" });
    const target = await query("SELECT id FROM sectors WHERE id = ?", [sectorId]);
    if (!target.length) return res.status(400).json({ ok: false, error: "赛道不存在" });
    await query("UPDATE items SET sector_id = ?, tags = ?, classified_by = 'manual' WHERE id = ?", [
      sectorId,
      JSON.stringify([sectorId]),
      req.params.id,
    ]);
    dataSnapshot.invalidate();
    res.json({ ok: true });
  })
);

router.delete(
  `${base}/items/:id`,
  asyncHandler(async (req, res) => {
    await query("DELETE FROM items WHERE id = ?", [req.params.id]);
    dataSnapshot.invalidate();
    res.json({ ok: true });
  })
);

// ---------- 抓取 ----------
router.post(
  `${base}/refresh`,
  asyncHandler(async (req, res) => {
    try {
      const { runId } = await crawler.runCrawl("admin");
      res.status(202).json({ ok: true, runId });
    } catch (error) {
      if (error.code === "RUNNING") {
        return res.status(409).json({ ok: false, running: true, error: "已有抓取任务在运行" });
      }
      throw error;
    }
  })
);

router.get(
  `${base}/runs`,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await query("SELECT * FROM crawl_runs ORDER BY id DESC LIMIT ?", [limit]);
    res.json({ runs: rows.map((r) => ({ ...r, stats: parseJsonColumn(r.stats, null) })) });
  })
);

// ---------- 日报 ----------
router.get(
  `${base}/reports`,
  asyncHandler(async (req, res) => {
    const rows = await query(
      "SELECT id, run_id, title, model, tokens_used, is_published, created_at FROM ai_reports ORDER BY id DESC LIMIT 50"
    );
    res.json({ reports: rows });
  })
);

router.get(
  `${base}/reports/:id`,
  asyncHandler(async (req, res) => {
    const rows = await query("SELECT * FROM ai_reports WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "日报不存在" });
    res.json({ report: rows[0] });
  })
);

router.put(
  `${base}/reports/:id`,
  asyncHandler(async (req, res) => {
    const isPublished = req.body && req.body.is_published;
    await query("UPDATE ai_reports SET is_published = ? WHERE id = ?", [isPublished ? 1 : 0, req.params.id]);
    dataSnapshot.invalidate();
    res.json({ ok: true });
  })
);

router.delete(
  `${base}/reports/:id`,
  asyncHandler(async (req, res) => {
    await query("DELETE FROM ai_reports WHERE id = ?", [req.params.id]);
    dataSnapshot.invalidate();
    res.json({ ok: true });
  })
);

router.post(
  `${base}/reports/generate`,
  asyncHandler(async (req, res) => {
    const lastRun = await crawler.lastRun();
    const report = await insights.generateReport(lastRun ? lastRun.id : null, lastRun ? lastRun.stats : null, {
      force: true,
    });
    if (!report) return res.status(502).json({ ok: false, error: "生成失败：大模型未配置、超出预算或调用失败" });
    dataSnapshot.invalidate();
    res.json({ ok: true, report });
  })
);

// ---------- LLM 测试 ----------
router.post(
  `${base}/llm/test`,
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const result = await llm.chat(
      [
        { role: "system", content: "你是连接测试助手。" },
        { role: "user", content: "请回复：连接正常" },
      ],
      { ignoreEnabled: true, ignoreCircuit: true, maxTokens: 128, timeoutMs: 20000 }
    );
    const config = await llm.getConfig();
    if (!result) {
      return res.json({ ok: false, model: config.model, error: "调用失败（检查 API Key / 网络 / 预算）" });
    }
    res.json({ ok: true, model: config.model, reply: result.content.slice(0, 100), latencyMs: Date.now() - startedAt });
  })
);

module.exports = router;
