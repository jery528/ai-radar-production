const { query } = require("../db");
const settings = require("../settings");
const { sleep } = require("../util");
const { fetchWithProxy } = require("../net");

// GLM（智谱 BigModel，OpenAI 兼容）客户端。
// 防护：30s 超时、2 次指数退避重试、连续 3 次失败本轮熔断、每日 token 预算记账。
// 任何失败都不向上抛出致命错误 —— 调用方拿到 null 自行降级。

const state = {
  consecutiveFailures: 0,
  brokenUntilRun: null, // 熔断标记（由 crawler 每轮 reset）
};

function resetCircuit() {
  state.consecutiveFailures = 0;
  state.brokenUntilRun = null;
}

function isBroken() {
  return state.consecutiveFailures >= 3;
}

async function getConfig() {
  return {
    enabled: Boolean(await settings.get("llm.enabled", false)),
    baseUrl: String(await settings.get("llm.baseUrl", "https://open.bigmodel.cn/api/paas/v4")).replace(/\/+$/, ""),
    apiKey: String(await settings.get("llm.apiKey", "") || ""),
    model: String(await settings.get("llm.model", "glm-5.1")),
    temperature: Number(await settings.get("llm.temperature", 0.3)),
    maxTokens: Number(await settings.get("llm.maxTokens", 2048)),
    dailyTokenBudget: Number(await settings.get("llm.dailyTokenBudget", 500000)),
  };
}

async function todayUsage() {
  const rows = await query("SELECT calls, prompt_tokens, completion_tokens, errors FROM llm_usage WHERE usage_date = CURDATE()");
  return rows[0] || { calls: 0, prompt_tokens: 0, completion_tokens: 0, errors: 0 };
}

async function recordUsage({ promptTokens = 0, completionTokens = 0, isError = false }) {
  await query(
    `INSERT INTO llm_usage (usage_date, calls, prompt_tokens, completion_tokens, errors)
     VALUES (CURDATE(), 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE calls = calls + 1, prompt_tokens = prompt_tokens + VALUES(prompt_tokens),
       completion_tokens = completion_tokens + VALUES(completion_tokens), errors = errors + VALUES(errors)`,
    [promptTokens, completionTokens, isError ? 1 : 0]
  );
}

/**
 * 单次对话调用。成功返回 {content, promptTokens, completionTokens}，失败/被限返回 null。
 * @param messages OpenAI 格式 [{role, content}]
 */
async function chat(messages, options = {}) {
  const config = await getConfig();
  if (!config.enabled && !options.ignoreEnabled) return null;
  if (!config.apiKey) return null;
  if (isBroken() && !options.ignoreCircuit) return null;

  const usage = await todayUsage();
  if (usage.prompt_tokens + usage.completion_tokens >= config.dailyTokenBudget) return null;

  const body = JSON.stringify({
    model: options.model || config.model,
    messages,
    temperature: options.temperature !== undefined ? options.temperature : config.temperature,
    max_tokens: options.maxTokens || config.maxTokens,
    stream: false,
    // GLM-5.1 是思考型模型，reasoning_content 会大量消耗 token；
    // 分类/摘要/日报这类任务不需要深度推理，默认关闭（可用 options.thinking 打开）。
    thinking: { type: options.thinking ? "enabled" : "disabled" },
  });

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000 * Math.pow(2, attempt - 1) + Math.random() * 500);
    try {
      const response = await fetchWithProxy(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs || 30000),
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        if (response.status === 429 || response.status >= 500) continue;
        break;
      }
      const data = JSON.parse(text);
      const content = data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || "")
        : "";
      const promptTokens = (data.usage && data.usage.prompt_tokens) || 0;
      const completionTokens = (data.usage && data.usage.completion_tokens) || 0;
      state.consecutiveFailures = 0;
      await recordUsage({ promptTokens, completionTokens });
      return { content, promptTokens, completionTokens };
    } catch (error) {
      lastError = error.name === "TimeoutError" ? new Error("timeout") : error;
    }
  }

  state.consecutiveFailures++;
  await recordUsage({ isError: true });
  if (options.collectErrors) options.collectErrors.push(String(lastError && lastError.message).slice(0, 200));
  return null;
}

/** 从回复中提取第一个 JSON 数组/对象（容忍 markdown 代码块包裹） */
function extractJson(content) {
  const text = String(content || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : text;
  for (const open of ["[", "{"]) {
    const close = open === "[" ? "]" : "}";
    const start = candidate.indexOf(open);
    const end = candidate.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (_) {
        /* 尝试下一种 */
      }
    }
  }
  return null;
}

/**
 * 批量分类：entries [{index, title, summary}]，sectors [{id, name, description}]。
 * 返回 Map(index -> sectorId)，失败返回空 Map。
 */
async function classifyBatch(entries, sectors, options = {}) {
  const sectorList = sectors.map((s) => `- ${s.id}：${s.name}（${s.description}）`).join("\n");
  const itemList = entries
    .map((e) => `${e.index}. ${e.title}${e.summary ? ` —— ${String(e.summary).slice(0, 100)}` : ""}`)
    .join("\n");
  const result = await chat(
    [
      {
        role: "system",
        content: "你是 AI 行业资讯分类器。只输出 JSON 数组，不要输出任何解释。",
      },
      {
        role: "user",
        content: `可选赛道（必须使用下列 id）：\n${sectorList}\n\n请为下面每条资讯选择最合适的一个赛道，输出 JSON 数组，每个元素形如 {"i": 序号, "sector": "赛道id"}：\n${itemList}`,
      },
    ],
    { ...options, temperature: 0 }
  );
  const mapping = new Map();
  if (!result) return mapping;
  const parsed = extractJson(result.content);
  if (!Array.isArray(parsed)) return mapping;
  const validIds = new Set(sectors.map((s) => s.id));
  for (const row of parsed) {
    if (row && validIds.has(row.sector) && Number.isInteger(row.i)) {
      mapping.set(row.i, row.sector);
    }
  }
  if (options.usageCollector && result) {
    options.usageCollector.promptTokens += result.promptTokens;
    options.usageCollector.completionTokens += result.completionTokens;
  }
  return mapping;
}

/**
 * 批量中文摘要：entries [{index, title, summary}]。返回 Map(index -> 摘要)。
 */
async function summarizeBatch(entries, options = {}) {
  const itemList = entries
    .map((e) => `${e.index}. 标题：${e.title}\n原摘要：${String(e.summary || "").slice(0, 200) || "（无）"}`)
    .join("\n\n");
  const result = await chat(
    [
      {
        role: "system",
        content: "你是 AI 资讯编辑。为英文资讯写不超过 80 字的中文摘要，信息准确、不夸张。只输出 JSON 数组。",
      },
      {
        role: "user",
        content: `请为下面每条资讯生成中文摘要，输出 JSON 数组，每个元素形如 {"i": 序号, "summary": "中文摘要"}：\n\n${itemList}`,
      },
    ],
    options
  );
  const mapping = new Map();
  if (!result) return mapping;
  const parsed = extractJson(result.content);
  if (!Array.isArray(parsed)) return mapping;
  for (const row of parsed) {
    if (row && Number.isInteger(row.i) && typeof row.summary === "string" && row.summary.trim()) {
      mapping.set(row.i, row.summary.trim().slice(0, 300));
    }
  }
  if (options.usageCollector && result) {
    options.usageCollector.promptTokens += result.promptTokens;
    options.usageCollector.completionTokens += result.completionTokens;
  }
  return mapping;
}

module.exports = { chat, classifyBatch, summarizeBatch, extractJson, getConfig, todayUsage, resetCircuit, isBroken };
