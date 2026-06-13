const { XMLParser } = require("fast-xml-parser");
const { stripHtml, truncate, sleep, decodeEntities } = require("../util");
const { fetchWithProxy } = require("../net");

// processEntities 关闭：部分 feed（Dev.to/Reddit 等）实体数量超过 fast-xml-parser 的
// 1000 上限会直接抛错；实体解码改用 util.decodeEntities 自行处理。
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  trimValues: true,
});

// 浏览器 UA：MarkTechPost 等站点对 bot UA 返回 403
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 抓取并解析一个 Feed，返回归一化条目数组。网络错/5xx/429 重试一次。 */
async function fetchFeed(feedUrl, { timeoutMs = 12000, maxItems = 60 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(500 + Math.random() * 1000);
    try {
      const response = await fetchWithProxy(feedUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        },
        redirect: "follow",
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        if (response.status >= 500 || response.status === 429) continue;
        throw lastError;
      }
      const xml = await response.text();
      return parseFeedXml(xml, maxItems);
    } catch (error) {
      lastError = error.name === "TimeoutError" ? new Error("timeout") : error;
      const retryable =
        error.name === "TimeoutError" ||
        error.code === "ECONNRESET" ||
        error.code === "UND_ERR_CONNECT_TIMEOUT" ||
        /HTTP (5\d\d|429)/.test(error.message || "");
      if (!retryable) break;
    }
  }
  throw lastError || new Error("fetch failed");
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === "object") {
    if (node["#text"] !== undefined) return String(node["#text"]);
    if (node.__cdata !== undefined) return String(node.__cdata);
  }
  return "";
}

/** 取 Atom <link>：优先 rel=alternate，其次第一个 href */
function atomLink(linkNode) {
  const links = asArray(linkNode);
  let fallback = "";
  for (const link of links) {
    if (typeof link === "string") {
      if (!fallback) fallback = link;
      continue;
    }
    const href = link["@_href"] || "";
    const rel = link["@_rel"] || "alternate";
    if (href && rel === "alternate") return href;
    if (href && !fallback) fallback = href;
  }
  return fallback;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value).trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 解析 RSS2 / Atom / RDF（RSS1.0），返回 [{title, link, summary, publishedAt}] */
function parseFeedXml(xml, maxItems) {
  const doc = parser.parse(xml);
  let rawItems = [];
  let kind = "";

  if (doc.rss && doc.rss.channel) {
    kind = "rss";
    rawItems = asArray(doc.rss.channel.item);
  } else if (doc.feed) {
    kind = "atom";
    rawItems = asArray(doc.feed.entry);
  } else if (doc["rdf:RDF"]) {
    kind = "rdf";
    rawItems = asArray(doc["rdf:RDF"].item);
  } else {
    throw new Error("unknown feed format");
  }

  const items = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    let title = "";
    let link = "";
    let summary = "";
    let publishedAt = null;

    if (kind === "atom") {
      title = textOf(raw.title);
      link = atomLink(raw.link);
      summary = textOf(raw.summary) || textOf(raw.content);
      publishedAt = parseDate(textOf(raw.published)) || parseDate(textOf(raw.updated));
    } else {
      title = textOf(raw.title);
      link = textOf(raw.link) || (raw.guid && textOf(raw.guid)) || "";
      summary = textOf(raw.description) || textOf(raw["content:encoded"]);
      publishedAt =
        parseDate(textOf(raw.pubDate)) ||
        parseDate(textOf(raw["dc:date"])) ||
        parseDate(textOf(raw.date));
    }

    title = truncate(stripHtml(title), 500);
    link = decodeEntities(String(link || "").trim());
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    if (!publishedAt) continue; // 无可解析日期的条目丢弃

    items.push({
      title,
      link,
      summary: truncate(stripHtml(summary), 300),
      publishedAt,
    });
    if (items.length >= maxItems) break;
  }
  return items;
}

module.exports = { fetchFeed, parseFeedXml, USER_AGENT };
