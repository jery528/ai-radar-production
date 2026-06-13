const { query } = require("../db");
const { sha1, runPool, toMysqlDateTime } = require("../util");
const { USER_AGENT } = require("./feedParser");
const { fetchWithProxy } = require("../net");

// Google News RSS 链接解析回原文链接。三级降级：
//   1) link_cache 持久缓存命中
//   2) 老格式文章 id（CBMi 开头）base64url 解码扫描 URL
//   3) 新格式走 batchexecute 接口（先取文章页签名参数）
// 全部失败则保留 Google 链接（写 fail 缓存，7 天后允许重试）。

function isGoogleNewsLink(link) {
  try {
    return new URL(link).hostname === "news.google.com";
  } catch (_) {
    return false;
  }
}

function articleIdOf(link) {
  const match = String(link).match(/\/(?:rss\/)?articles\/([^?/]+)/);
  return match ? match[1] : null;
}

/**
 * Google 链接的规范形式：去掉 hl/gl/ceid/oc 等随 feed 变化的查询参数，
 * 同一篇文章无论来自哪个搜索源都得到同一身份（用作去重键和缓存键）。
 */
function canonicalGoogleUrl(link) {
  const articleId = articleIdOf(link);
  return articleId ? `https://news.google.com/rss/articles/${articleId}` : String(link);
}

/** 老格式：base64url 解码后扫描可打印 URL */
function decodeArticleId(articleId) {
  let buffer;
  try {
    buffer = Buffer.from(articleId, "base64url");
  } catch (_) {
    return null;
  }
  const text = buffer.toString("latin1");
  const matches = text.match(/https?:\/\/[\x21-\x7e]+/g);
  if (!matches) return null;
  const candidate = matches.find((u) => !u.includes("news.google.com")) || matches[0];
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? candidate : null;
  } catch (_) {
    return null;
  }
}

/** 新格式：取文章页 data-n-a-sg / data-n-a-ts 签名，再调 batchexecute(Fbv4je) */
async function resolveViaBatchExecute(articleId, timeoutMs) {
  const pageResponse = await fetchWithProxy(`https://news.google.com/rss/articles/${articleId}`, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  const html = await pageResponse.text();
  const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sg || !ts) return null;

  const inner = JSON.stringify([
    "garturlreq",
    [
      ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
    ],
    articleId,
    Number(ts),
    sg,
  ]);
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]]));

  const response = await fetchWithProxy("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();

  // 响应为 )]}' 前缀 + 长度分块的 JSON；逐行找含 garturlres 的块结构化解析，失败再用正则兜底
  for (const line of text.split("\n")) {
    if (!line.startsWith("[[") || !line.includes("garturlres")) continue;
    try {
      const chunk = JSON.parse(line);
      for (const entry of chunk) {
        if (Array.isArray(entry) && typeof entry[2] === "string" && entry[2].includes("garturlres")) {
          const payload = JSON.parse(entry[2]);
          if (Array.isArray(payload) && typeof payload[1] === "string" && /^https?:\/\//.test(payload[1])) {
            return payload[1];
          }
        }
      }
    } catch (_) {
      /* 继续尝试下一行 */
    }
  }
  const fallback = text.match(/garturlres\\",\\"(https?:[^\\"]+)/);
  return fallback ? fallback[1] : null;
}

/** 剥掉 Google News 标题尾部的 “ - 发布者名” */
function cleanGoogleTitle(title) {
  const stripped = String(title).replace(/\s+-\s+[^-]{1,80}$/, "").trim();
  return stripped.length >= 10 ? stripped : title;
}

/**
 * 批量解析 entries（就地替换 entry.link / entry.title）。
 * 返回与参考站同构的 linkResolution 统计。
 */
async function resolveGoogleLinks(entries, options = {}) {
  const {
    enabled = true,
    maxPerRun = 150,
    concurrency = 6,
    timeoutMs = 8000,
  } = options;

  const stats = {
    googleLinkCount: 0,
    cacheHitCount: 0,
    attemptedCount: 0,
    paramSuccessCount: 0,
    decodedCount: 0,
    resolvedCount: 0,
    failedCount: 0,
  };

  const googleEntries = entries.filter((entry) => isGoogleNewsLink(entry.link));
  stats.googleLinkCount = googleEntries.length;
  if (!googleEntries.length) return stats;

  for (const entry of googleEntries) {
    entry.title = cleanGoogleTitle(entry.title);
  }
  if (!enabled) {
    stats.failedCount = googleEntries.length;
    return stats;
  }

  // 一级：批量查缓存（按规范化链接哈希，不同 feed 的同一文章共享缓存）
  const hashOf = new Map(googleEntries.map((entry) => [entry.link, sha1(canonicalGoogleUrl(entry.link))]));
  const allHashes = [...new Set(hashOf.values())];
  const cached = new Map();
  for (let i = 0; i < allHashes.length; i += 500) {
    const batch = allHashes.slice(i, i + 500);
    const rows = await query(
      `SELECT google_hash, resolved_url, method, created_at FROM link_cache WHERE google_hash IN (${batch.map(() => "?").join(",")})`,
      batch
    );
    for (const row of rows) cached.set(row.google_hash, row);
  }

  const retryBefore = Date.now() - 7 * 86400 * 1000;
  const pendingByLink = new Map(); // 规范化链接 -> entries[]（同一文章只解析一次）
  for (const entry of googleEntries) {
    const hit = cached.get(hashOf.get(entry.link));
    if (hit && hit.resolved_url) {
      entry.link = hit.resolved_url;
      stats.cacheHitCount++;
      stats.resolvedCount++;
      continue;
    }
    if (hit && !hit.resolved_url && new Date(hit.created_at).getTime() > retryBefore) {
      stats.failedCount++; // 近期已失败过，跳过重试
      continue;
    }
    const canonical = canonicalGoogleUrl(entry.link);
    if (!pendingByLink.has(canonical)) pendingByLink.set(canonical, []);
    pendingByLink.get(canonical).push(entry);
  }

  // 二/三级：新解析（限量 + 限并发）
  const pendingLinks = [...pendingByLink.keys()].slice(0, maxPerRun);
  const skippedLinks = [...pendingByLink.keys()].slice(maxPerRun);
  stats.failedCount += skippedLinks.reduce((acc, link) => acc + pendingByLink.get(link).length, 0);

  const cacheWrites = [];
  const tasks = pendingLinks.map((link) => async () => {
    stats.attemptedCount++;
    const articleId = articleIdOf(link);
    let resolved = null;
    let method = "fail";

    if (articleId) {
      resolved = decodeArticleId(articleId);
      if (resolved) {
        method = "decode";
        stats.decodedCount++;
      } else {
        try {
          resolved = await resolveViaBatchExecute(articleId, timeoutMs);
          if (resolved) {
            method = "batch";
            stats.paramSuccessCount++;
          }
        } catch (_) {
          resolved = null;
        }
      }
    }

    const targets = pendingByLink.get(link) || [];
    if (resolved) {
      for (const entry of targets) entry.link = resolved;
      stats.resolvedCount += targets.length;
    } else {
      stats.failedCount += targets.length;
    }
    cacheWrites.push([
      sha1(canonicalGoogleUrl(link)),
      canonicalGoogleUrl(link).slice(0, 1024),
      resolved ? resolved.slice(0, 2048) : null,
      method,
    ]);
  });

  await runPool(tasks, concurrency);

  if (cacheWrites.length) {
    const placeholders = cacheWrites.map(() => "(?, ?, ?, ?, ?)").join(",");
    const now = toMysqlDateTime(new Date());
    const params = [];
    for (const [hash, url, resolved, method] of cacheWrites) {
      params.push(hash, url, resolved, method, now);
    }
    await query(
      `INSERT INTO link_cache (google_hash, google_url, resolved_url, method, created_at)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE resolved_url = VALUES(resolved_url), method = VALUES(method), created_at = VALUES(created_at)`,
      params
    );
  }

  return stats;
}

/**
 * 存量升级通道：把库里仍是 news.google.com 的条目分批解析为原文链接（只改 url，不动 url_hash 身份键）。
 * 返回 {scanned, upgraded, attempted}。
 */
async function upgradeStoredLinks({ maxPerRun = 150, concurrency = 6, timeoutMs = 8000 } = {}) {
  const result = { scanned: 0, upgraded: 0, attempted: 0 };
  const rows = await query(
    "SELECT id, url FROM items WHERE url LIKE 'https://news.google.com/%' ORDER BY published_at DESC LIMIT ?",
    [maxPerRun * 3]
  );
  result.scanned = rows.length;
  if (!rows.length) return result;

  // 先查缓存：缓存命中的直接升级，不消耗解析额度
  const canonicalOf = new Map(rows.map((row) => [row.id, canonicalGoogleUrl(row.url)]));
  const hashes = [...new Set([...canonicalOf.values()].map((u) => sha1(u)))];
  const cached = new Map();
  for (let i = 0; i < hashes.length; i += 500) {
    const batch = hashes.slice(i, i + 500);
    const cacheRows = await query(
      `SELECT google_hash, resolved_url, created_at FROM link_cache WHERE google_hash IN (${batch.map(() => "?").join(",")})`,
      batch
    );
    for (const row of cacheRows) cached.set(row.google_hash, row);
  }

  const retryBefore = Date.now() - 7 * 86400 * 1000;
  const pending = [];
  for (const row of rows) {
    const canonical = canonicalOf.get(row.id);
    const hit = cached.get(sha1(canonical));
    if (hit && hit.resolved_url) {
      await query("UPDATE items SET url = ? WHERE id = ?", [hit.resolved_url.slice(0, 2048), row.id]);
      result.upgraded++;
      continue;
    }
    if (hit && !hit.resolved_url && new Date(hit.created_at).getTime() > retryBefore) continue;
    pending.push({ id: row.id, canonical });
  }

  const toAttempt = pending.slice(0, maxPerRun);
  const cacheWrites = [];
  const tasks = toAttempt.map(({ id, canonical }) => async () => {
    result.attempted++;
    const articleId = articleIdOf(canonical);
    let resolved = articleId ? decodeArticleId(articleId) : null;
    let method = resolved ? "decode" : "fail";
    if (!resolved && articleId) {
      try {
        resolved = await resolveViaBatchExecute(articleId, timeoutMs);
        if (resolved) method = "batch";
      } catch (_) {
        resolved = null;
      }
    }
    if (resolved) {
      await query("UPDATE items SET url = ? WHERE id = ?", [resolved.slice(0, 2048), id]);
      result.upgraded++;
    }
    cacheWrites.push([sha1(canonical), canonical.slice(0, 1024), resolved ? resolved.slice(0, 2048) : null, method]);
  });
  await runPool(tasks, concurrency);

  if (cacheWrites.length) {
    const placeholders = cacheWrites.map(() => "(?, ?, ?, ?, ?)").join(",");
    const now = toMysqlDateTime(new Date());
    const params = [];
    for (const [hash, url, resolved, method] of cacheWrites) {
      params.push(hash, url, resolved, method, now);
    }
    await query(
      `INSERT INTO link_cache (google_hash, google_url, resolved_url, method, created_at)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE resolved_url = VALUES(resolved_url), method = VALUES(method), created_at = VALUES(created_at)`,
      params
    );
  }
  return result;
}

module.exports = {
  resolveGoogleLinks,
  upgradeStoredLinks,
  isGoogleNewsLink,
  canonicalGoogleUrl,
  decodeArticleId,
  cleanGoogleTitle,
};
