const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { query, transaction } = require("./db");
const settings = require("./settings");
const { hashPassword } = require("./auth");

const SEED_VERSION = "3"; // v2: crawl.proxyUrl；v3: 多页面导航、short-video 赛道、话题置顶、日报定时
const seedDir = path.join(__dirname, "..", "seed");

function readSeed(name) {
  return JSON.parse(fs.readFileSync(path.join(seedDir, name), "utf8"));
}

/** 幂等种子：site_settings['seed.version'] 哨兵存在且一致则跳过 */
async function seedIfNeeded() {
  const current = await settings.get("seed.version", null);
  if (current === SEED_VERSION) {
    return { seeded: false };
  }

  const sectors = readSeed("sectors.json");
  const sources = readSeed("sources.json");
  const topics = readSeed("topics.json");
  const modules = readSeed("modules.json");
  const defaultSettings = readSeed("settings.json");

  await transaction(async (q) => {
    for (const s of sectors) {
      await q(
        `INSERT IGNORE INTO sectors (id, name, description, keywords, sort_order, is_visible)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [s.id, s.name, s.description, JSON.stringify(s.keywords), s.sort_order, s.is_visible]
      );
    }
    for (const s of sources) {
      await q(
        `INSERT IGNORE INTO sources (id, name, homepage, feed_url, type, region, language, default_sector, is_enabled, sort_order, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, s.name, s.homepage, s.feed_url, s.type, s.region, s.language, s.default_sector, s.is_enabled, s.sort_order, s.notes]
      );
    }
    for (const t of topics) {
      await q(
        `INSERT IGNORE INTO insight_topics
           (id, title, thesis, signal_text, keywords, metric_label, best_for, opportunity, threshold_text, tools, first_action, actions, sort_order, is_visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id, t.title, t.thesis, t.signal_text, JSON.stringify(t.keywords), t.metric_label,
          t.best_for, t.opportunity, t.threshold_text, JSON.stringify(t.tools), t.first_action,
          JSON.stringify(t.actions), t.sort_order, t.is_visible,
        ]
      );
    }
    for (const m of modules) {
      await q(
        `INSERT IGNORE INTO modules (id, name, anchor, nav_items, is_orderable, sort_order, is_visible, settings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.id, m.name, m.anchor, JSON.stringify(m.nav_items), m.is_orderable, m.sort_order, m.is_visible, JSON.stringify(m.settings)]
      );
    }
  });

  // 默认设置（不覆盖已有值）
  const existingKeys = new Set((await settings.listAll()).map((s) => s.setting_key));
  for (const s of defaultSettings) {
    if (existingKeys.has(s.setting_key)) continue;
    let value = s.value;
    if (s.setting_key === "llm.apiKey") {
      value = process.env.GLM_API_KEY || s.value || "";
    }
    await settings.set(s.setting_key, value, {
      type: s.type,
      category: s.category,
      label: s.label,
      description: s.description,
    });
  }

  // 管理口令与 token 密钥（仅首次生成）
  if (!existingKeys.has("admin.passwordHash")) {
    await settings.set("admin.passwordHash", hashPassword(process.env.ADMIN_PASSWORD || "admin123"), {
      type: "secret",
      category: "admin",
      label: "管理密码哈希",
      description: "scrypt 哈希，请通过后台修改密码",
    });
  }
  if (!existingKeys.has("admin.tokenSecret")) {
    await settings.set("admin.tokenSecret", crypto.randomBytes(32).toString("hex"), {
      type: "secret",
      category: "admin",
      label: "Token 签名密钥",
      description: "自动生成",
    });
  }

  // ---------- v3 数据迁移（对已有库幂等更新；新库种子本身已是新形态） ----------
  if (Number(current || 0) < 3) {
    // 导航从锚点改为独立页面路径
    const navUpdates = {
      insights: [
        { label: "排行榜", path: "/leaderboard" },
        { label: "机会洞察", path: "/insights" },
      ],
      report: [{ label: "AI日报", path: "/report" }],
      radar: [{ label: "情报流", path: "/" }],
      sources: [{ label: "来源库", path: "/sources" }],
      method: [{ label: "抓取策略", path: "/method" }],
    };
    for (const [id, navItems] of Object.entries(navUpdates)) {
      await query("UPDATE modules SET nav_items = ? WHERE id = ?", [JSON.stringify(navItems), id]);
    }
    // 用户主营方向置顶：AI短视频与数字人话题 + 相关来源排前
    await query("UPDATE insight_topics SET is_pinned = 1 WHERE id = 'video'");
    const videoSources = [
      "google-news-income-short-video",
      "google-news-income-faceless-youtube",
      "google-news-income-ugc-ads",
      "google-news-income-virtual-influencer",
    ];
    for (let i = 0; i < videoSources.length; i++) {
      await query("UPDATE sources SET sort_order = ? WHERE id = ?", [i + 1, videoSources[i]]);
    }
  }

  await settings.set("seed.version", SEED_VERSION, {
    type: "string",
    category: "seed",
    label: "种子版本",
    description: "内部哨兵，请勿修改",
  });

  return { seeded: true };
}

async function itemCount() {
  const rows = await query("SELECT COUNT(*) AS n FROM items");
  return rows[0].n;
}

module.exports = { seedIfNeeded, itemCount };
