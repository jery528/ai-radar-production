const netSocket = require("net");
const { fetch: undiciFetch, ProxyAgent } = require("undici");
const settings = require("./settings");

// 出网代理层：所有抓取 / Google 解链 / GLM 调用统一走这里的 fetchWithProxy。
// 代理地址优先级：后台设置 crawl.proxyUrl > 环境变量 HTTP(S)_PROXY > 直连。
// 代理不可达时自动探测并降级直连（探测结果带 TTL 缓存），保证同一份配置
// 在本机（Clash 运行中）走代理、部署到海外服务器（无代理）时自动直连。

const PROBE_OK_TTL = 10 * 60 * 1000; // 探测成功缓存 10 分钟
const PROBE_FAIL_TTL = 60 * 1000; // 探测失败缓存 60 秒后允许重试

const state = {
  url: null, // 当前生效的代理地址（null = 直连）
  configuredUrl: null, // 配置的代理地址
  dispatcher: null,
  usable: false,
  probedAt: 0,
  source: "none", // settings | env | none
  lastWarnedUrl: null,
};

async function resolveConfiguredProxy() {
  let url = "";
  try {
    // 总开关：关闭后无论配置了什么地址都直连（部署到海外服务器时用）
    const enabled = await settings.get("crawl.proxyEnabled", true);
    if (enabled === false) return { url: "", source: "disabled" };
    url = String((await settings.get("crawl.proxyUrl", "")) || "").trim();
  } catch (_) {
    /* settings 尚不可用时（建表前）忽略，走环境变量 */
  }
  if (url) return { url, source: "settings" };
  const envUrl =
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || "";
  if (envUrl) return { url: String(envUrl).trim(), source: "env" };
  return { url: "", source: "none" };
}

/** TCP 探测代理端口是否可达 */
function probeProxy(proxyUrl, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let host;
    let port;
    try {
      const parsed = new URL(proxyUrl);
      host = parsed.hostname;
      port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    } catch (_) {
      return resolve(false);
    }
    const socket = netSocket.createConnection({ host, port, timeout: timeoutMs });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 取当前应使用的 dispatcher（null = 直连）。配置变化即时生效，探测结果按 TTL 缓存。 */
async function getDispatcher() {
  const { url, source } = await resolveConfiguredProxy();
  if (!url) {
    state.url = null;
    state.configuredUrl = null;
    state.dispatcher = null;
    state.usable = false;
    state.source = "none";
    return null;
  }

  const now = Date.now();
  const ttl = state.usable ? PROBE_OK_TTL : PROBE_FAIL_TTL;
  if (state.configuredUrl === url && now - state.probedAt < ttl) {
    return state.usable ? state.dispatcher : null;
  }

  const usable = await probeProxy(url);
  state.configuredUrl = url;
  state.source = source;
  state.probedAt = now;
  state.usable = usable;
  if (usable) {
    if (state.url !== url || !state.dispatcher) {
      if (state.dispatcher) state.dispatcher.close().catch(() => {});
      state.dispatcher = new ProxyAgent(url);
      state.url = url;
      console.log(`[代理] 使用 ${url}（来源：${source === "settings" ? "后台设置" : "环境变量"}）`);
    }
    state.lastWarnedUrl = null;
    return state.dispatcher;
  }
  state.url = null;
  if (state.lastWarnedUrl !== url) {
    state.lastWarnedUrl = url;
    console.warn(`[代理] ${url} 不可达，自动降级为直连（60 秒后重试探测）`);
  }
  return null;
}

/** 代理感知 fetch：用法与全局 fetch 一致 */
async function fetchWithProxy(url, options = {}) {
  const dispatcher = await getDispatcher();
  return undiciFetch(url, dispatcher ? { ...options, dispatcher } : options);
}

/** 当前代理状态（供后台概览展示） */
async function proxyStatus() {
  const { url, source } = await resolveConfiguredProxy();
  if (source === "disabled") return { configured: "", active: false, source, text: "已关闭（直连）" };
  if (!url) return { configured: "", active: false, source: "none", text: "未配置（直连）" };
  await getDispatcher();
  return {
    configured: url,
    active: state.usable,
    source,
    text: state.usable
      ? `使用中 ${url}（${source === "settings" ? "后台设置" : "环境变量"}）`
      : `${url} 不可达，已降级直连`,
  };
}

module.exports = { fetchWithProxy, proxyStatus, getDispatcher };
