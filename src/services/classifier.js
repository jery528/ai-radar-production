const { parseJsonColumn } = require("../util");

// 关键词打分引擎。规则来自 sectors.keywords 列（后台可改）：
//   标题命中 +2，摘要命中 +1；来源 default_sector 偏置 +1.5。
//   tags = 关键词得分 ≥2 的赛道；主赛道 = 总分最高。
//   纯 ASCII 关键词按词边界匹配（避免 "app" 误中 "happen"），含 CJK 的按包含匹配。

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatchers(sectors) {
  return sectors.map((sector) => {
    const keywords = parseJsonColumn(sector.keywords, []);
    const matchers = keywords
      .map((keyword) => {
        const kw = String(keyword).trim().toLowerCase();
        if (!kw) return null;
        if (/^[\x00-\x7f]+$/.test(kw)) {
          return { regex: new RegExp(`\\b${escapeRegex(kw)}\\b`, "i") };
        }
        return { substr: kw };
      })
      .filter(Boolean);
    return { id: sector.id, matchers };
  });
}

function fieldHits(matchers, textLower) {
  let hits = 0;
  for (const matcher of matchers) {
    if (matcher.regex ? matcher.regex.test(textLower) : textLower.includes(matcher.substr)) {
      hits++;
    }
  }
  return hits;
}

/**
 * @param entry {title, summary}
 * @param compiled buildMatchers() 结果
 * @param sourceHint 来源 default_sector（可空）
 * @returns {sectorId|null, tags[], classifiedBy}  sectorId 为 null 表示需要 LLM/兜底
 */
function classify(entry, compiled, sourceHint) {
  const titleLower = String(entry.title || "").toLowerCase();
  const summaryLower = String(entry.summary || "").toLowerCase();

  let bestId = null;
  let bestScore = 0;
  const keywordScores = new Map();

  for (const sector of compiled) {
    const keywordScore =
      fieldHits(sector.matchers, titleLower) * 2 + fieldHits(sector.matchers, summaryLower);
    keywordScores.set(sector.id, keywordScore);
    const total = keywordScore + (sourceHint === sector.id ? 1.5 : 0);
    if (total > bestScore) {
      bestScore = total;
      bestId = sector.id;
    }
  }

  if (!bestId) {
    return { sectorId: null, tags: [], classifiedBy: null };
  }

  const tags = [bestId];
  const ranked = [...keywordScores.entries()]
    .filter(([id, score]) => id !== bestId && score >= 2)
    .sort((a, b) => b[1] - a[1]);
  for (const [id] of ranked) tags.push(id);

  const classifiedBy = (keywordScores.get(bestId) || 0) > 0 ? "keyword" : "source";
  return { sectorId: bestId, tags: tags.slice(0, 6), classifiedBy };
}

/** 条目权重分：来源类型 + 时新 + 多赛道命中 + 有无摘要 */
const TYPE_WEIGHTS = { official: 18, research: 14, analysis: 10, media: 6 };

function scoreItem(entry, sourceType, tagCount) {
  let score = TYPE_WEIGHTS[sourceType] || 6;
  const ageMs = Date.now() - entry.publishedAt.getTime();
  if (ageMs <= 24 * 3600 * 1000) score += 12;
  else if (ageMs <= 72 * 3600 * 1000) score += 8;
  else if (ageMs <= 7 * 86400 * 1000) score += 4;
  score += tagCount * 2;
  if (entry.summary) score += 2;
  return score;
}

module.exports = { buildMatchers, classify, scoreItem };
