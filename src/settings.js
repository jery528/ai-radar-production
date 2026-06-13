const { query } = require("./db");

// site_settings K-V 读写 + 进程内缓存。value 统一 JSON 编码存储。
let cache = null;

async function loadAll() {
  const rows = await query("SELECT setting_key, value, type, category, label, description FROM site_settings");
  cache = new Map();
  for (const row of rows) {
    let value;
    try {
      value = JSON.parse(row.value);
    } catch (_) {
      value = row.value;
    }
    cache.set(row.setting_key, { ...row, value });
  }
  return cache;
}

async function ensureCache() {
  if (!cache) await loadAll();
  return cache;
}

async function get(key, fallback) {
  const map = await ensureCache();
  const entry = map.get(key);
  return entry === undefined ? fallback : entry.value;
}

/** 一次取一组设置：get('crawl') → {lookbackDays: 30, ...}（按 "crawl." 前缀） */
async function getCategory(prefix) {
  const map = await ensureCache();
  const result = {};
  for (const [key, entry] of map.entries()) {
    if (key.startsWith(prefix + ".")) {
      result[key.slice(prefix.length + 1)] = entry.value;
    }
  }
  return result;
}

async function set(key, value, meta = {}) {
  const map = await ensureCache();
  const existing = map.get(key);
  const row = {
    type: meta.type || (existing && existing.type) || "string",
    category: meta.category || (existing && existing.category) || "site",
    label: meta.label !== undefined ? meta.label : (existing && existing.label) || "",
    description: meta.description !== undefined ? meta.description : (existing && existing.description) || "",
  };
  await query(
    `INSERT INTO site_settings (setting_key, value, type, category, label, description)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), type = VALUES(type), category = VALUES(category),
       label = VALUES(label), description = VALUES(description)`,
    [key, JSON.stringify(value), row.type, row.category, row.label, row.description]
  );
  map.set(key, { setting_key: key, value, ...row });
}

async function listAll() {
  const map = await ensureCache();
  return [...map.values()];
}

function invalidate() {
  cache = null;
}

module.exports = { get, getCategory, set, listAll, loadAll, invalidate };
