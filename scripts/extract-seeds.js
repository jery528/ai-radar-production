/**
 * 开发期一次性工具：从参考站下载的资产中提取种子数据。
 * 输入（默认在系统临时目录，可用 argv[2] 覆盖）：
 *   radar_items.js   —— window.AI_RADAR_DATA 快照（赛道 + 来源 + 条目）
 *   radar_script.js  —— 前端逻辑（incomeInsightDefinitions 39 个洞察话题）
 * 输出：seed/sectors.json、seed/sources.json、seed/topics.json、seed/modules.json、seed/settings.json
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const inputDir = process.argv[2] || os.tmpdir();
const outDir = path.join(__dirname, "..", "seed");
fs.mkdirSync(outDir, { recursive: true });

function readInput(name) {
  return fs.readFileSync(path.join(inputDir, name), "utf8");
}

function writeSeed(name, data) {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`seed/${name} written (${Array.isArray(data) ? data.length + " entries" : "object"})`);
}

// ---------- 解析参考站数据快照 ----------
const snapshotCode = readInput("radar_items.js");
const sandbox = {};
new Function("window", snapshotCode)(sandbox);
const snapshot = sandbox.AI_RADAR_DATA;
if (!snapshot || !snapshot.sectors || !snapshot.stats) {
  throw new Error("radar_items.js 解析失败");
}

// ---------- 赛道：参考站 13 条 + 自行设计的分类关键词 ----------
// 关键词用于抓取端自动归类：纯 ASCII 词按词边界匹配，含 CJK 的词按包含匹配（见 classifier.js）
const sectorKeywords = {
  "foundation-models": [
    "gpt", "chatgpt", "claude", "gemini", "llama", "mistral", "qwen", "deepseek", "grok", "kimi",
    "通义", "文心", "豆包", "大模型", "基础模型", "foundation model", "frontier model", "llm",
    "language model", "anthropic", "openai", "model release", "模型发布", "旗舰模型", "o3", "o4"
  ],
  agents: [
    "agent", "agents", "agentic", "智能体", "multi-agent", "多智能体", "tool use", "工具调用",
    "mcp", "computer use", "autonomous", "自动化执行", "工作流", "workflow", "autogpt", "操作电脑"
  ],
  "open-source": [
    "open source", "open-source", "开源", "hugging face", "huggingface", "open weights", "开放权重",
    "权重开源", "ollama", "local llm", "本地部署", "本地运行", "apache 2.0", "mit license", "开源社区"
  ],
  multimodal: [
    "多模态", "multimodal", "text-to-image", "text-to-video", "文生图", "文生视频", "image generation",
    "video generation", "图像生成", "视频生成", "midjourney", "stable diffusion", "sora", "veo",
    "语音合成", "speech", "tts", "voice", "音乐生成", "music generation", "vision language", "diffusion", "3d 生成"
  ],
  "developer-tools": [
    "sdk", "api 接口", "ide", "cursor", "copilot", "vs code", "vscode", "developer", "开发者",
    "coding", "编程", "code generation", "代码生成", "代码智能体", "inference engine", "推理框架",
    "vllm", "langchain", "devtools", "开发工具", "deployment", "github"
  ],
  "enterprise-ai": [
    "enterprise", "企业", "b2b", "saas", "crm", "行业解决方案", "数字化转型", "云服务", "azure",
    "aws", "组织提效", "knowledge management", "知识管理", "salesforce", "partnership", "战略合作",
    "落地", "提效", "办公自动化", "workplace"
  ],
  "ai-apps": [
    "app", "应用", "产品发布", "product launch", "consumer", "消费级", "ai search", "ai 搜索",
    "assistant", "助手", "chatbot", "聊天机器人", "startup", "创业公司", "融资", "funding",
    "上线", "新功能", "应用产品", "增长"
  ],
  "ordinary-income": [
    "变现", "副业", "赚钱", "收入", "月入", "写作", "自媒体", "带货", "跨境电商", "电商",
    "小红书", "抖音", "直播", "个人ip", "知识付费", "课程", "训练营", "接单", "私域", "获客",
    "种草", "公众号", "短视频", "数字人", "提示词", "模板", "freelance", "side hustle",
    "make money", "passive income", "monetize", "monetization", "creator economy", "solopreneur",
    "etsy", "shopify", "dropshipping", "print on demand", "newsletter", "course", "gig"
  ],
  "chips-infra": [
    "gpu", "芯片", "chip", "nvidia", "英伟达", "amd", "tpu", "算力", "compute", "data center",
    "数据中心", "semiconductor", "半导体", "台积电", "tsmc", "h100", "b200", "blackwell", "cuda",
    "训练成本", "推理成本", "infrastructure", "基础设施", "超算"
  ],
  research: [
    "arxiv", "paper", "论文", "research", "研究", "study", "学术", "benchmark", "评测基准",
    "evaluation", "理论", "neurips", "icml", "iclr", "acl", "实验结果", "方法论", "scaling law"
  ],
  "safety-policy": [
    "safety", "安全", "alignment", "对齐", "regulation", "监管", "policy", "政策", "copyright",
    "版权", "privacy", "隐私", "lawsuit", "诉讼", "ethics", "伦理", "governance", "治理",
    "ai act", "法案", "合规", "deepfake", "深度伪造", "风险"
  ],
  robotics: [
    "robot", "机器人", "具身智能", "embodied", "humanoid", "人形机器人", "自动驾驶",
    "autonomous driving", "self-driving", "drone", "无人机", "waymo", "特斯拉", "figure", "机械臂"
  ],
  healthcare: [
    "医疗", "health", "medical", "drug", "药物", "制药", "biotech", "生物科技", "临床", "clinical",
    "医院", "诊断", "diagnosis", "protein", "蛋白质", "alphafold", "生命科学", "life science", "基因"
  ],
};

// 自定义赛道：用户主营方向，置顶（sort_order 最小）
const customSectors = [
  {
    id: "short-video",
    name: "AI短视频与数字人",
    description: "AI短视频、数字人口播、无人直播、虚拟主播、AI剪辑与视频带货变现",
    keywords: [
      "短视频", "数字人", "数字人直播", "虚拟主播", "虚拟人", "口播", "无人直播", "ai剪辑",
      "剪映", "capcut", "heygen", "faceless", "ai视频", "带货视频", "短剧", "推文视频",
      "影视解说", "矩阵号", "avatar video", "talking head", "ai influencer", "虚拟网红",
      "digital human", "video clone", "ai主播"
    ],
    sort_order: 5,
    is_visible: 1,
  },
];

const sectors = [
  ...customSectors,
  ...snapshot.sectors.map((sector, index) => ({
    id: sector.id,
    name: sector.name,
    description: sector.description,
    keywords: sectorKeywords[sector.id] || [],
    sort_order: (index + 1) * 10,
    is_visible: 1,
  })),
];
writeSeed("sectors.json", sectors);

// ---------- 来源库：157 条反推结果 + language / default_sector 富化 ----------
function inferLanguage(source) {
  if ((source.feedUrl || "").includes("hl=zh-CN")) return "zh";
  if ((source.region || "").startsWith("CN")) return "zh";
  return "en";
}

function inferDefaultSector(source) {
  const id = source.id;
  const sectorMatch = id.match(/^google-news-sector-(.+)$/);
  if (sectorMatch && sectorKeywords[sectorMatch[1]]) return sectorMatch[1];
  if (/^google-news-(income|ai-income|ai-creator|ai-cross-border)/.test(id)) return "ordinary-income";
  if (/^reddit-/.test(id)) return "ordinary-income";
  if (id === "medium-side-hustle" || id === "medium-no-code") return "ordinary-income";
  if (id === "creator-economy-peter-yang" || id === "printify-blog") return "ordinary-income";
  if (/^arxiv-/.test(id) || source.type === "research") return "research";
  if (/^producthunt-/.test(id)) return "ai-apps";
  if (id === "n8n-blog") return "agents";
  if (id === "apify-blog") return "developer-tools";
  return null;
}

const sources = snapshot.stats.sources.map((source, index) => ({
  id: source.id,
  name: source.name,
  homepage: source.homepage || "",
  feed_url: source.feedUrl,
  type: source.type,
  region: source.region || "Global",
  language: inferLanguage(source),
  default_sector: inferDefaultSector(source),
  is_enabled: 1,
  sort_order: (index + 1) * 10,
  notes: "",
}));
writeSeed("sources.json", sources);

// ---------- 洞察话题：39 条 incomeInsightDefinitions ----------
const scriptCode = readInput("radar_script.js");
const defStart = scriptCode.indexOf("const incomeInsightDefinitions = [");
if (defStart === -1) throw new Error("未找到 incomeInsightDefinitions");
const arrStart = scriptCode.indexOf("[", defStart);
const arrEnd = scriptCode.indexOf("\n];", arrStart);
const definitions = new Function("return " + scriptCode.slice(arrStart, arrEnd + 2))();

const topics = definitions.map((def, index) => ({
  id: def.id,
  title: def.title,
  thesis: def.thesis || "",
  signal_text: def.signal || "",
  keywords: def.keywords || [],
  metric_label: def.metricLabel || "",
  best_for: def.bestFor || "",
  opportunity: def.opportunity || "",
  threshold_text: def.threshold || "",
  tools: def.tools || [],
  first_action: def.firstAction || "",
  actions: def.action || [],
  sort_order: (index + 1) * 10,
  is_visible: 1,
}));
writeSeed("topics.json", topics);

// ---------- 页面模块：10 个模块 + 参考站逐字默认文案 ----------
const modules = [
  {
    id: "topbar",
    name: "顶部导航栏",
    anchor: "top",
    nav_items: [],
    is_orderable: 0,
    sort_order: 0,
    is_visible: 1,
    settings: {
      brandMark: "破",
      brandName: "AI破局情报导航",
      brandSubtitle: "Global AI Radar",
      refreshLabel: "刷新情报",
      refreshingLabel: "刷新中...",
    },
  },
  {
    id: "hero",
    name: "首屏横幅",
    anchor: "hero",
    nav_items: [],
    is_orderable: 1,
    sort_order: 10,
    is_visible: 1,
    settings: {
      eyebrow: "Public feeds · RSS/Atom · Sector routing",
      title: "全球 AI 信息雷达",
      description:
        "聚合可公开抓取的信息源，自动按细分赛道归类；从前沿模型到 AI写作变现、自媒体、带货、跨境电商，给 AI破局俱乐部做一张持续更新的情报导航图。",
      imageUrl: "/assets/hero-ai-club.png",
    },
  },
  {
    id: "stats",
    name: "抓取概览统计条",
    anchor: "stats",
    nav_items: [],
    is_orderable: 1,
    sort_order: 20,
    is_visible: 1,
    settings: {
      itemsLabel: "情报条目",
      sourcesLabel: "公开来源",
      sectorsLabel: "细分赛道",
      updatedLabel: "最近更新",
      waitingText: "等待抓取",
    },
  },
  {
    id: "refresh-status",
    name: "刷新状态提示行",
    anchor: "refresh-status",
    nav_items: [],
    is_orderable: 1,
    sort_order: 30,
    is_visible: 1,
    settings: {
      defaultTemplate: "当前规则：只保留最近 {lookbackDays} 天内的情报。",
      runningText: "正在抓取最近 {lookbackDays} 天内的全球 AI 情报，请稍等。",
      successTemplate: "刷新完成：{items} 条情报，{ok}/{total} 个来源正常{linkText}。",
      errorTemplate: "刷新失败：{error}",
    },
  },
  {
    id: "insights",
    name: "机会洞察与排行榜",
    anchor: "insights",
    nav_items: [
      { label: "排行榜", path: "/leaderboard" },
      { label: "机会洞察", path: "/insights" },
    ],
    is_orderable: 1,
    sort_order: 40,
    is_visible: 1,
    settings: {
      eyebrow: "Actionable insights",
      title: "普通人能做的 AI 机会洞察",
      targetSectorId: "ordinary-income",
      summaryTemplate:
        "基于最近 {lookbackDays} 天、{sourceCount} 个来源、{itemCount} 条情报生成；其中{sectorName} {sectorCount} 条，占 {percent}%。更新时间：{generatedAt}。",
      metric1Label: "普通人热门情报",
      metric2Label: "相关来源",
      metric3Label: "当前热度最高",
      metricEmptyText: "暂无",
      leaderboardEyebrow: "Income ranking",
      leaderboardTitle: "AI变现机会排行榜",
      leaderboardSummaryTemplate:
        "按最近 {lookbackDays} 天情报量、来源覆盖、7 天内新增信号和案例可用性计算。当前第一名：{topTitle}，机会分 {topScore}。",
      leaderboardSummaryEmptyTemplate:
        "按最近 {lookbackDays} 天情报量、来源覆盖、7 天内新增信号和案例可用性计算。",
      scoreWeights: { count: 42, sources: 28, recent: 20, example: 10 },
      itemCountTemplate: "{count} 条情报",
      shareTemplate: "{share}% 占比",
      sourceCountTemplate: "{count} 个来源",
      recentTemplate: "{count} 条 7 天内",
      recentEmptyText: "等待近 7 天新信号",
      scoreLabel: "机会分",
      firstStepLabel: "第一步",
      caseLabel: "案例",
      blockLabels: {
        opportunity: "机会",
        threshold: "门槛",
        cases: "案例",
        tools: "工具",
        firstAction: "第一步行动",
      },
      opportunityTemplate:
        "{opportunity} 过去 {lookbackDays} 天抓到 {count} 条相关情报，占{sectorName}赛道 {percent}%，覆盖 {sourceCount} 个来源。{signal}",
      opportunityEmptyTemplate:
        "{opportunity} 过去 {lookbackDays} 天暂未抓到足够样本，刷新后会继续补充信号。",
      topicMetricTemplate: "{count} 条 · {percent}%",
      emptyCaseText: "当前样本不足，刷新后会继续补充。",
      defaultFirstAction: "先拿一个真实场景做 7 天测试。",
      showTopicCards: true,
    },
  },
  {
    id: "report",
    name: "AI 机会洞察日报",
    anchor: "report",
    nav_items: [{ label: "AI日报", path: "/report" }],
    is_orderable: 1,
    sort_order: 50,
    is_visible: 1,
    settings: {
      eyebrow: "AI Daily",
      title: "AI 机会洞察日报",
      emptyText: "暂无日报，完成一次抓取后自动生成。",
      generatedAtTemplate: "生成于 {generatedAt} · {model}",
    },
  },
  {
    id: "radar",
    name: "情报流（赛道+列表）",
    anchor: "radar",
    nav_items: [{ label: "情报流", path: "/" }],
    is_orderable: 1,
    sort_order: 60,
    is_visible: 1,
    settings: {
      sectorsEyebrow: "Sectors",
      sectorsTitle: "赛道",
      allSectorsLabel: "全部赛道",
      searchLabel: "搜索",
      searchPlaceholder: "模型、Agent、OpenAI、arXiv...",
      typeLabel: "来源",
      typeOptions: [
        { value: "all", label: "全部来源" },
        { value: "official", label: "官方发布" },
        { value: "research", label: "研究论文" },
        { value: "media", label: "媒体报道" },
        { value: "analysis", label: "深度分析" },
      ],
      ageLabel: "时间",
      ageOptions: [
        { value: "all", label: "不限时间" },
        { value: "1", label: "24 小时内" },
        { value: "7", label: "7 天内" },
        { value: "30", label: "30 天内" },
      ],
      feedEyebrow: "Latest",
      allItemsTitle: "全部 AI 情报",
      fallbackTitle: "AI 情报",
      resultCountTemplate: "{count} 条结果",
      featuredCount: 2,
      pageSize: 20,
      loadMoreLabel: "加载更多",
      loadingLabel: "加载中...",
      maxTags: 4,
      emptyTitle: "没有匹配结果",
      emptyBody: "换一个关键词、赛道或时间范围。",
      openLinkLabel: "打开原文",
    },
  },
  {
    id: "sources",
    name: "全球来源库",
    anchor: "sources",
    nav_items: [{ label: "来源库", path: "/sources" }],
    is_orderable: 1,
    sort_order: 70,
    is_visible: 1,
    settings: {
      eyebrow: "Source graph",
      title: "全球来源库",
      description:
        "默认接入公开 RSS/Atom 源，也加入普通人热门 AI 机会的搜索型来源，后续可以扩展到站点地图、官方 API、企业白名单来源。",
      okBadgeTemplate: "{count} 条",
      failBadgeText: "失败",
      okText: "已接入公开 Feed",
      typeRegionTemplate: "{type} · {region}",
    },
  },
  {
    id: "method",
    name: "抓取策略说明",
    anchor: "method",
    nav_items: [{ label: "抓取策略", path: "/method" }],
    is_orderable: 1,
    sort_order: 80,
    is_visible: 1,
    settings: {
      eyebrow: "Crawler policy",
      title: "抓取策略",
      cards: [
        {
          num: "01",
          title: "优先公开 Feed",
          body: "使用 RSS、Atom、官方博客和论文源，减少对目标网站的压力，也降低版权和反爬风险。",
        },
        {
          num: "02",
          title: "自动赛道归类",
          body: "抓取后根据关键词和来源类型分配到基础模型、Agent、开源、多模态、普通人热门、企业落地等赛道。",
        },
        {
          num: "03",
          title: "保留来源链接",
          body: "本站只呈现标题、摘要、时间、分类和跳转，不复制全文，适合做导航入口和情报看板。",
        },
      ],
    },
  },
  {
    id: "footer",
    name: "页脚",
    anchor: "footer",
    nav_items: [],
    is_orderable: 0,
    sort_order: 1000,
    is_visible: 1,
    settings: {
      brandText: "AI破局情报导航",
      waitingText: "等待数据",
      healthTemplate: "{ok}/{total} 来源正常 · {items} 条 · 最近 {days} 天{linkText}",
      linkResolutionTemplate: " · 原文链接 {resolved}/{google}",
    },
  },
];
writeSeed("modules.json", modules);

// ---------- 系统设置默认值 ----------
const settings = [
  // 站点
  { setting_key: "site.title", value: "AI破局情报导航 | 全球 AI 信息雷达", type: "string", category: "site", label: "站点标题", description: "浏览器标签页与 SEO 标题" },
  { setting_key: "site.metaDescription", value: "AI破局情报导航聚合全球公开 AI 信息源，按基础模型、Agent、开源模型、多模态、普通人热门AI变现、企业落地等赛道分类。", type: "string", category: "site", label: "SEO 描述", description: "meta description" },
  // 抓取
  { setting_key: "crawl.proxyEnabled", value: true, type: "boolean", category: "crawl", label: "启用出网代理", description: "本机开发时开启；部署到海外服务器可关闭（关闭后始终直连）" },
  { setting_key: "crawl.proxyUrl", value: "http://127.0.0.1:7890", type: "string", category: "crawl", label: "出网代理地址", description: "抓取与大模型出网代理（HTTP），留空=直连；不可达时自动降级直连" },
  { setting_key: "crawl.lookbackDays", value: 30, type: "number", category: "crawl", label: "保留天数", description: "只保留最近 N 天内的情报" },
  { setting_key: "crawl.concurrency", value: 12, type: "number", category: "crawl", label: "抓取并发数", description: "同时抓取的来源数量" },
  { setting_key: "crawl.timeoutMs", value: 12000, type: "number", category: "crawl", label: "单源超时(毫秒)", description: "单个来源抓取超时时间" },
  { setting_key: "crawl.maxItemsPerSource", value: 60, type: "number", category: "crawl", label: "单源条目上限", description: "每个来源最多保留的条目数" },
  { setting_key: "crawl.intervalMinutes", value: 360, type: "number", category: "crawl", label: "定时抓取间隔(分钟)", description: "0 表示关闭定时抓取" },
  { setting_key: "crawl.publicRefreshCooldownSec", value: 300, type: "number", category: "crawl", label: "公共刷新冷却(秒)", description: "前台刷新按钮的全局冷却时间" },
  { setting_key: "crawl.resolveGoogleLinks", value: true, type: "boolean", category: "crawl", label: "解析 Google News 原文链接", description: "关闭后保留 Google News 跳转链接" },
  { setting_key: "crawl.googleResolveMaxPerRun", value: 150, type: "number", category: "crawl", label: "每轮解链上限", description: "每次抓取最多新解析的 Google 链接数" },
  { setting_key: "crawl.fallbackSector", value: "ai-apps", type: "string", category: "crawl", label: "兜底赛道", description: "无法分类时归入的赛道 ID" },
  // 大模型
  { setting_key: "llm.enabled", value: true, type: "boolean", category: "llm", label: "启用大模型", description: "GLM 总开关" },
  { setting_key: "llm.baseUrl", value: "https://open.bigmodel.cn/api/paas/v4", type: "string", category: "llm", label: "API 地址", description: "OpenAI 兼容接口基址" },
  { setting_key: "llm.apiKey", value: "", type: "secret", category: "llm", label: "API Key", description: "智谱 BigModel API Key" },
  { setting_key: "llm.model", value: "glm-5.1", type: "string", category: "llm", label: "模型名称", description: "如 glm-5.1" },
  { setting_key: "llm.temperature", value: 0.3, type: "number", category: "llm", label: "温度", description: "生成随机性 0-1" },
  { setting_key: "llm.maxTokens", value: 2048, type: "number", category: "llm", label: "单次最大输出 token", description: "" },
  { setting_key: "llm.classifyEnabled", value: true, type: "boolean", category: "llm", label: "启用智能分类", description: "关键词判不准的条目交给 GLM 分类" },
  { setting_key: "llm.classifyMaxPerRun", value: 80, type: "number", category: "llm", label: "每轮分类上限", description: "每次抓取最多交给 GLM 分类的条目数" },
  { setting_key: "llm.summaryEnabled", value: true, type: "boolean", category: "llm", label: "启用中文摘要", description: "为热门英文条目生成中文摘要" },
  { setting_key: "llm.summaryMaxPerRun", value: 20, type: "number", category: "llm", label: "每轮摘要上限", description: "每次抓取最多生成的摘要数" },
  { setting_key: "llm.reportHourBeijing", value: 5, type: "number", category: "llm", label: "日报生成时间(北京小时)", description: "每天该整点后生成一次当日日报，0-23" },
  { setting_key: "llm.reportFocus", value: "AI短视频与数字人", type: "string", category: "llm", label: "日报重点关注", description: "日报内容优先覆盖的方向，留空则不偏重" },
  { setting_key: "llm.reportEnabled", value: true, type: "boolean", category: "llm", label: "启用洞察日报", description: "每次抓取后生成 AI 机会洞察日报" },
  { setting_key: "llm.dailyTokenBudget", value: 500000, type: "number", category: "llm", label: "每日 token 预算", description: "超过后当日不再调用大模型" },
  // 管理
  { setting_key: "admin.sessionTtlHours", value: 72, type: "number", category: "admin", label: "登录有效期(小时)", description: "管理后台 token 有效期" },
];
writeSeed("settings.json", settings);

console.log("全部种子文件生成完毕。");
