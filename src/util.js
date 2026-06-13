const crypto = require("crypto");

function sha1(text) {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}

function slugify(text) {
  const slug = String(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "item";
}

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|igshid|spm|ref_src|mc_cid|mc_eid)/i;

/** 规范化 URL 用于去重：去跟踪参数、去尾斜杠、host 小写 */
function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    const keep = [];
    for (const [key, value] of url.searchParams.entries()) {
      if (!TRACKING_PARAMS.test(key)) keep.push([key, value]);
    }
    url.search = "";
    for (const [key, value] of keep) url.searchParams.append(key, value);
    let result = url.toString();
    if (result.endsWith("/") && url.pathname !== "/") result = result.slice(0, -1);
    return result;
  } catch (_) {
    return String(rawUrl || "").trim();
  }
}

const ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text) {
  return String(text)
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITY_MAP[m] || m)
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return num > 0 && num < 1114112 ? String.fromCodePoint(num) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const num = parseInt(code, 16);
      return num > 0 && num < 1114112 ? String.fromCodePoint(num) : _;
    });
}

/** 去 HTML 标签 + 解实体 + 压缩空白 */
function stripHtml(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, maxLength) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

/** {name} 占位插值，缺失的占位保留原样 */
function interpolate(template, vars = {}) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
      ? String(vars[name])
      : match
  );
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value; // mysql2 已自动解析 JSON 列
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

/** 简单 promise 并发池 */
async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      try {
        results[current] = { ok: true, value: await tasks[current]() };
      } catch (error) {
        results[current] = { ok: false, error };
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, Math.min(concurrency, tasks.length)); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Date → MySQL DATETIME 字符串（UTC） */
function toMysqlDateTime(date) {
  return new Date(date).toISOString().slice(0, 19).replace("T", " ");
}

module.exports = {
  sha1,
  slugify,
  normalizeUrl,
  stripHtml,
  decodeEntities,
  truncate,
  interpolate,
  parseJsonColumn,
  runPool,
  sleep,
  toMysqlDateTime,
};
