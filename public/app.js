/* AI破局情报导航 — 多页面前台
 * 路由：/（情报流）/leaderboard /insights /report /sources /method
 * 服务器模式走真实路径 + /api/*；静态模式（GitHub Pages）走 hash 路由 + 打包的 data.json */
(() => {
  "use strict";

  const IS_STATIC = Boolean(window.__STATIC__);

  const state = {
    data: null, // /api/data 瘦身负载
    insights: null, // /api/insights 负载（按需）
    staticBundle: null, // 静态模式打包数据
    username: null, // 当前浏览的用户页（null = 首页/管理员）
    route: "/",
    feed: {
      sector: "all",
      type: "all",
      age: "all",
      q: "",
      page: 1,
      pageSize: 20,
      items: [],
      total: 0,
      sectorCounts: { all: 0 },
      loading: false,
    },
    refreshing: false,
  };

  // ---------- 工具 ----------
  function escapeHtml(value = "") {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  const escapeAttribute = escapeHtml;

  function interpolate(template, vars = {}) {
    return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
        ? String(vars[name])
        : match
    );
  }

  function formatDate(value) {
    if (!value) return "时间未知";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  }

  function formatDateTime(value) {
    if (!value) return "时间未知";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function formatRelative(value) {
    if (!value) return "时间未知";
    const time = Date.parse(value);
    if (Number.isNaN(time)) return "时间未知";
    const diff = Date.now() - time;
    if (diff < 0) return formatDate(value);
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.round(hours / 24);
    if (days < 31) return `${days} 天前`;
    return formatDate(value);
  }

  /** 白名单迷你 markdown */
  function renderMarkdown(md) {
    const lines = String(md || "").split(/\r?\n/);
    const html = [];
    let listOpen = false;
    const closeList = () => {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }
    };
    const inline = (text) => escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        closeList();
        continue;
      }
      if (line.startsWith("### ")) {
        closeList();
        html.push(`<h4>${inline(line.slice(4))}</h4>`);
      } else if (line.startsWith("## ")) {
        closeList();
        html.push(`<h3>${inline(line.slice(3))}</h3>`);
      } else if (line.startsWith("# ")) {
        closeList();
        html.push(`<h3>${inline(line.slice(2))}</h3>`);
      } else if (/^[-*]\s+/.test(line)) {
        if (!listOpen) {
          html.push("<ul>");
          listOpen = true;
        }
        html.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      } else {
        closeList();
        html.push(`<p>${inline(line)}</p>`);
      }
    }
    closeList();
    return html.join("\n");
  }

  // ---------- 数据访问 ----------
  function modules() {
    return (state.data && state.data.modules) || [];
  }
  function moduleById(id) {
    return modules().find((m) => m.id === id) || null;
  }
  function moduleSettings(id) {
    const mod = moduleById(id);
    return (mod && mod.settings) || {};
  }
  function moduleVisible(id) {
    const mod = moduleById(id);
    return Boolean(mod && mod.isVisible);
  }

  // 当前用户名（来自路径首段）拼到 API 查询里，让服务端按对应 profile 返回
  function withUser(params) {
    if (state.username) params.set("u", state.username);
    return params;
  }

  async function loadData() {
    if (IS_STATIC) {
      if (!state.staticBundle) {
        const response = await fetch("./data.json");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.staticBundle = await response.json();
      }
      state.data = state.staticBundle.data;
      return;
    }
    const qs = withUser(new URLSearchParams()).toString();
    const response = await fetch(`/api/data${qs ? `?${qs}` : ""}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
  }

  async function loadInsights() {
    if (state.insights) return state.insights;
    if (IS_STATIC) {
      state.insights = state.staticBundle.insights;
      return state.insights;
    }
    const qs = withUser(new URLSearchParams()).toString();
    const response = await fetch(`/api/insights${qs ? `?${qs}` : ""}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.insights = await response.json();
    return state.insights;
  }

  /** 分页取条目：服务器走 /api/items；静态模式在打包数据里过滤模拟同样的响应 */
  async function fetchItems({ sector, type, age, q, page, pageSize }) {
    if (!IS_STATIC) {
      const params = new URLSearchParams();
      if (sector && sector !== "all") params.set("sector", sector);
      if (type && type !== "all") params.set("type", type);
      if (age && age !== "all") params.set("age", age);
      if (q) params.set("q", q);
      params.set("page", page);
      params.set("pageSize", pageSize);
      withUser(params);
      const response = await fetch(`/api/items?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }
    const pool = state.staticBundle.items || [];
    const query = (q || "").trim().toLowerCase();
    const maxAgeMs = !age || age === "all" ? null : Number(age) * 86400 * 1000;
    const now = Date.now();
    const filtered = pool.filter((item) => {
      if (sector && sector !== "all" && item.sector !== sector) return false;
      if (type && type !== "all" && item.sourceType !== type) return false;
      if (maxAgeMs && item.publishedAt && now - Date.parse(item.publishedAt) > maxAgeMs) return false;
      if (!query) return true;
      return `${item.title} ${item.summary} ${item.sourceName} ${(item.tags || []).join(" ")}`.toLowerCase().includes(query);
    });
    return {
      page,
      pageSize,
      total: filtered.length,
      sectorCounts: state.staticBundle.sectorCounts || { all: pool.length },
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
    };
  }

  // ---------- 路由 ----------
  const PAGES = ["/", "/leaderboard", "/insights", "/report", "/sources", "/method"];
  const PAGE_NAMES = new Set(["leaderboard", "insights", "report", "sources", "method"]);

  /** 解析当前位置 → {username, page}。username 为 null 表示首页（管理员页）。 */
  function parseLocation() {
    if (IS_STATIC) {
      // 静态镜像只有管理员首页，多用户需服务端
      const hash = (location.hash || "").replace(/^#/, "");
      return { username: null, page: PAGES.includes(hash) ? hash : "/" };
    }
    const segs = location.pathname.split("/").filter(Boolean);
    if (!segs.length) return { username: null, page: "/" };
    if (PAGE_NAMES.has(segs[0])) return { username: null, page: `/${segs[0]}` };
    const username = decodeURIComponent(segs[0]);
    const page = segs[1] && PAGE_NAMES.has(segs[1]) ? `/${segs[1]}` : "/";
    return { username, page };
  }

  function hrefFor(page) {
    if (IS_STATIC) return `#${page}`;
    const userBase = state.username ? `/${encodeURIComponent(state.username)}` : "";
    if (page === "/") return userBase || "/";
    return `${userBase}${page}`;
  }

  // ---------- 顶栏 / 页脚 ----------
  function renderTopbar() {
    const el = document.querySelector("[data-topbar]");
    const mod = moduleById("topbar");
    if (!mod || !mod.isVisible) {
      el.hidden = true;
      return;
    }
    const s = mod.settings;
    const navLinks = modules()
      .filter((m) => m.isOrderable && m.isVisible)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .flatMap((m) => m.navItems || [])
      .filter((nav) => nav.path)
      .map((nav) => {
        const active = state.route === nav.path ? ' style="color:var(--ink)"' : "";
        return `<a href="${escapeAttribute(hrefFor(nav.path))}"${active}>${escapeHtml(nav.label)}</a>`;
      })
      .join("");
    // 顶栏右侧：刷新按钮（仅首页/管理员视图且服务端模式）+ 登录入口
    const isAdminHome = !state.username;
    const refreshButton =
      IS_STATIC || !isAdminHome
        ? ""
        : `<button class="refresh-button" type="button" data-refresh>${escapeHtml(s.refreshLabel || "刷新")}</button>`;
    const loginLink = IS_STATIC ? "" : `<a href="/admin">登录</a>`;
    // 副标题：浏览某用户页面时显示其用户名
    const subtitle = state.username
      ? `@${escapeHtml(state.username)} 的情报页`
      : escapeHtml(s.brandSubtitle || "");
    el.innerHTML = `
      <a class="brand" href="${escapeAttribute(hrefFor("/"))}" aria-label="${escapeAttribute(s.brandName || "")}">
        <span class="brand-mark">${escapeHtml(s.brandMark || "")}</span>
        <span>
          ${escapeHtml(s.brandName || "")}
          <small>${subtitle}</small>
        </span>
      </a>
      <nav class="nav" aria-label="主导航">
        ${navLinks}
        ${loginLink}
        ${refreshButton}
      </nav>
    `;
    el.hidden = false;
    const refreshEl = el.querySelector("[data-refresh]");
    if (refreshEl) refreshEl.addEventListener("click", onRefreshClick);
  }

  function linkResolutionText() {
    const footerSettings = moduleSettings("footer");
    const lr = state.data.stats && state.data.stats.linkResolution;
    if (!lr || !lr.googleLinkCount) return "";
    return interpolate(footerSettings.linkResolutionTemplate || "", {
      resolved: lr.resolvedCount,
      google: lr.googleLinkCount,
    });
  }

  function renderFooter() {
    const el = document.querySelector("[data-footer]");
    const mod = moduleById("footer");
    if (!mod || !mod.isVisible) {
      el.hidden = true;
      return;
    }
    const s = mod.settings;
    const stats = state.data.stats || {};
    const health = state.data.generatedAt
      ? interpolate(s.healthTemplate || "", {
          ok: stats.okSourceCount || 0,
          total: stats.sourceCount || 0,
          items: stats.itemCount || 0,
          days: stats.lookbackDays || 30,
          linkText: linkResolutionText(),
        })
      : s.waitingText || "";
    el.innerHTML = `<span>${escapeHtml(s.brandText || "")}</span><span data-health>${escapeHtml(health)}</span>`;
    el.hidden = false;
  }

  // ---------- 首页模块（hero / stats / refresh-status） ----------
  function heroHtml() {
    if (!moduleVisible("hero")) return "";
    const s = moduleSettings("hero");
    const visual = s.imageUrl
      ? `<div class="hero-visual" aria-hidden="true"><img src="${escapeAttribute(IS_STATIC ? String(s.imageUrl).replace(/^\//, "./") : s.imageUrl)}" alt="" /></div>`
      : `<div class="hero-visual" aria-hidden="true"></div>`;
    return `
      <section class="dashboard">
        <div class="hero-copy">
          <p class="eyebrow">${escapeHtml(s.eyebrow || "")}</p>
          <h1>${escapeHtml(s.title || "")}</h1>
          <p>${escapeHtml(s.description || "")}</p>
        </div>
        ${visual}
      </section>
    `;
  }

  function statsHtml() {
    if (!moduleVisible("stats")) return "";
    const s = moduleSettings("stats");
    const stats = state.data.stats || {};
    const updated = state.data.generatedAt ? formatDateTime(state.data.generatedAt) : s.waitingText || "";
    return `
      <section class="summary-strip" aria-label="抓取概览">
        <div class="stat"><strong>${stats.itemCount || 0}</strong><span>${escapeHtml(s.itemsLabel || "")}</span></div>
        <div class="stat"><strong>${stats.sourceCount || 0}</strong><span>${escapeHtml(s.sourcesLabel || "")}</span></div>
        <div class="stat"><strong>${(state.data.sectors || []).length}</strong><span>${escapeHtml(s.sectorsLabel || "")}</span></div>
        <div class="stat wide"><strong>${escapeHtml(updated)}</strong><span>${escapeHtml(s.updatedLabel || "")}</span></div>
      </section>
    `;
  }

  function refreshStatusHtml() {
    if (!moduleVisible("refresh-status")) return "";
    const s = moduleSettings("refresh-status");
    const stats = state.data.stats || {};
    const text = interpolate(s.defaultTemplate || "", { lookbackDays: stats.lookbackDays || 30 });
    return `<div class="refresh-status" data-refresh-status>${escapeHtml(text)}</div>`;
  }

  // ---------- 情报流 ----------
  function radarShellHtml() {
    const s = moduleSettings("radar");
    const typeOptions = (s.typeOptions || [])
      .map((o) => `<option value="${escapeAttribute(o.value)}">${escapeHtml(o.label)}</option>`)
      .join("");
    const ageOptions = (s.ageOptions || [])
      .map((o) => `<option value="${escapeAttribute(o.value)}">${escapeHtml(o.label)}</option>`)
      .join("");
    return `
      <section class="radar-layout">
        <aside class="sector-rail" aria-label="赛道筛选">
          <div class="rail-head">
            <p class="eyebrow">${escapeHtml(s.sectorsEyebrow || "")}</p>
            <h2>${escapeHtml(s.sectorsTitle || "")}</h2>
          </div>
          <div class="sector-list" data-sector-list></div>
        </aside>
        <section class="feed-panel" aria-label="AI 情报流">
          <div class="toolbar">
            <label class="search-box">
              <span>${escapeHtml(s.searchLabel || "")}</span>
              <input type="search" data-search placeholder="${escapeAttribute(s.searchPlaceholder || "")}" />
            </label>
            <label>
              <span>${escapeHtml(s.typeLabel || "")}</span>
              <select data-type-filter>${typeOptions}</select>
            </label>
            <label>
              <span>${escapeHtml(s.ageLabel || "")}</span>
              <select data-age-filter>${ageOptions}</select>
            </label>
          </div>
          <div class="feed-head">
            <div>
              <p class="eyebrow">${escapeHtml(s.feedEyebrow || "")}</p>
              <h2 data-current-title></h2>
            </div>
            <p data-result-count></p>
          </div>
          <div class="featured-grid" data-featured></div>
          <div class="item-list" data-items></div>
          <div class="empty-state" data-empty hidden>
            <h3>${escapeHtml(s.emptyTitle || "")}</h3>
            <p>${escapeHtml(s.emptyBody || "")}</p>
          </div>
          <div class="load-more-wrap" data-load-more-wrap hidden>
            <button class="refresh-button load-more" type="button" data-load-more>${escapeHtml(s.loadMoreLabel || "加载更多")}</button>
          </div>
        </section>
      </section>
    `;
  }

  function renderTags(item, maxTags) {
    return (item.tags || [])
      .slice(0, maxTags)
      .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
      .join("");
  }

  function renderFeaturedCard(item, s) {
    return `
      <article class="featured-card">
        <div>
          <div class="meta-block">
            <span class="source-pill">${escapeHtml(item.sourceName)}</span>
            <span>${escapeHtml(formatRelative(item.publishedAt))} · ${escapeHtml(item.sectorName)}</span>
          </div>
          <h3><a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h3>
          ${item.summary ? `<p class="summary">${escapeHtml(item.summary)}</p>` : ""}
        </div>
        <div class="tag-row">${renderTags(item, s.maxTags || 4)}</div>
      </article>
    `;
  }

  function renderNewsCard(item, s) {
    return `
      <article class="news-card">
        <div class="meta-block">
          <span class="source-pill">${escapeHtml(item.sourceName)}</span>
          <span>${escapeHtml(formatRelative(item.publishedAt))}</span>
          <span>${escapeHtml(item.sourceType)} · ${escapeHtml(item.region)}</span>
        </div>
        <div class="news-body">
          <h3><a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h3>
          ${item.summary ? `<p class="summary">${escapeHtml(item.summary)}</p>` : ""}
          <div class="tag-row">
            <span class="tag">${escapeHtml(item.sectorName)}</span>
            ${renderTags(item, s.maxTags || 4)}
          </div>
        </div>
        <a class="open-link" href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttribute(s.openLinkLabel || "打开原文")}">↗</a>
      </article>
    `;
  }

  function renderSectorRail() {
    const railEl = document.querySelector("[data-sector-list]");
    if (!railEl) return;
    const s = moduleSettings("radar");
    const counts = state.feed.sectorCounts || { all: 0 };
    const buttons = [{ id: "all", name: s.allSectorsLabel || "全部" }, ...(state.data.sectors || [])];
    railEl.innerHTML = buttons
      .map((sector) => {
        const active = state.feed.sector === sector.id ? " active" : "";
        return `
          <button class="sector-button${active}" type="button" data-sector="${escapeAttribute(sector.id)}">
            <strong>${escapeHtml(sector.name)}</strong>
            <span>${counts[sector.id] || 0}</span>
          </button>
        `;
      })
      .join("");
    railEl.querySelectorAll("[data-sector]").forEach((button) => {
      button.addEventListener("click", () => {
        state.feed.sector = button.dataset.sector;
        loadFeed(true);
      });
    });
  }

  function renderFeedItems(append) {
    const s = moduleSettings("radar");
    const featuredEl = document.querySelector("[data-featured]");
    if (!featuredEl) return;
    const itemsEl = document.querySelector("[data-items]");
    const emptyEl = document.querySelector("[data-empty]");
    const titleEl = document.querySelector("[data-current-title]");
    const countEl = document.querySelector("[data-result-count]");
    const moreWrap = document.querySelector("[data-load-more-wrap]");
    const moreButton = document.querySelector("[data-load-more]");

    const items = state.feed.items;
    const featuredCount = Number(s.featuredCount) >= 0 ? Number(s.featuredCount) : 2;
    const featured = items.slice(0, featuredCount);
    const rest = items.slice(featuredCount);

    if (!append) {
      featuredEl.innerHTML = featured.map((item) => renderFeaturedCard(item, s)).join("");
    }
    itemsEl.innerHTML = rest.map((item) => renderNewsCard(item, s)).join("");
    if (!items.length) featuredEl.innerHTML = "";
    emptyEl.hidden = items.length > 0;

    const sector = state.feed.sector === "all" ? null : (state.data.sectors || []).find((x) => x.id === state.feed.sector);
    titleEl.textContent = state.feed.sector === "all" ? s.allItemsTitle || "" : (sector && sector.name) || s.fallbackTitle || "";
    countEl.textContent = interpolate(s.resultCountTemplate || "{count}", { count: state.feed.total });

    const hasMore = items.length < state.feed.total;
    moreWrap.hidden = !hasMore;
    if (moreButton) {
      moreButton.disabled = state.feed.loading;
      moreButton.textContent = state.feed.loading ? s.loadingLabel || "加载中..." : `${s.loadMoreLabel || "加载更多"}（${items.length}/${state.feed.total}）`;
    }
  }

  async function loadFeed(reset) {
    const s = moduleSettings("radar");
    const feed = state.feed;
    if (feed.loading) return;
    feed.loading = true;
    if (reset) {
      feed.page = 1;
      feed.items = [];
    }
    feed.pageSize = Number(s.pageSize) > 0 ? Number(s.pageSize) : 20;
    try {
      const result = await fetchItems({
        sector: feed.sector,
        type: feed.type,
        age: feed.age,
        q: feed.q,
        page: feed.page,
        pageSize: feed.pageSize,
      });
      feed.total = result.total;
      feed.sectorCounts = result.sectorCounts || feed.sectorCounts;
      feed.items = feed.page === 1 ? result.items : feed.items.concat(result.items);
    } catch (error) {
      console.error("加载情报失败", error);
    } finally {
      feed.loading = false;
    }
    renderSectorRail();
    renderFeedItems(!reset && feed.page > 1);
  }

  let searchTimer = null;
  function bindRadarEvents() {
    const searchEl = document.querySelector("[data-search]");
    if (!searchEl) return;
    searchEl.value = state.feed.q;
    searchEl.addEventListener("input", (event) => {
      state.feed.q = event.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadFeed(true), 300);
    });
    const typeEl = document.querySelector("[data-type-filter]");
    typeEl.value = state.feed.type;
    if (typeEl.value !== state.feed.type) {
      state.feed.type = "all";
      typeEl.value = "all";
    }
    typeEl.addEventListener("change", (event) => {
      state.feed.type = event.target.value;
      loadFeed(true);
    });
    const ageEl = document.querySelector("[data-age-filter]");
    ageEl.value = state.feed.age;
    if (ageEl.value !== state.feed.age) {
      state.feed.age = "all";
      ageEl.value = "all";
    }
    ageEl.addEventListener("change", (event) => {
      state.feed.age = event.target.value;
      loadFeed(true);
    });
    const moreButton = document.querySelector("[data-load-more]");
    moreButton.addEventListener("click", () => {
      state.feed.page += 1;
      loadFeed(false);
    });
  }

  // ---------- 机会洞察（排行榜 / 洞察卡） ----------
  function insightsHeadHtml(s, payload) {
    const summary = interpolate(s.summaryTemplate || "", {
      lookbackDays: payload.lookbackDays,
      sourceCount: payload.sourceCount,
      itemCount: payload.totalItems,
      sectorName: payload.targetSector.name,
      sectorCount: payload.incomeCount,
      percent: payload.totalItems ? Math.round((payload.incomeCount / payload.totalItems) * 100) : 0,
      generatedAt: payload.generatedAt ? formatDateTime(payload.generatedAt) : "未知",
    });
    return `
      <div class="section-head">
        <div>
          <p class="eyebrow">${escapeHtml(s.eyebrow || "")}</p>
          <h2>${escapeHtml(s.title || "")}</h2>
        </div>
        <p>${escapeHtml(summary)}</p>
      </div>
    `;
  }

  function insightsMetricsHtml(s, payload) {
    const hottest = [...payload.rows].sort((a, b) => b.count - a.count)[0];
    return `
      <div class="insight-metrics">
        <div class="insight-stat"><strong>${payload.incomeCount}</strong><span>${escapeHtml(s.metric1Label || "")}</span></div>
        <div class="insight-stat"><strong>${payload.incomeSourceCount}</strong><span>${escapeHtml(s.metric2Label || "")}</span></div>
        <div class="insight-stat"><strong>${escapeHtml(hottest && hottest.count ? hottest.title : s.metricEmptyText || "暂无")}</strong><span>${escapeHtml(s.metric3Label || "")}</span></div>
      </div>
    `;
  }

  function renderOpportunityRow(row, index, s) {
    const firstMove = row.firstAction || (row.action || [])[0] || s.defaultFirstAction || "";
    const recentLabel = row.recentCount
      ? interpolate(s.recentTemplate || "{count}", { count: row.recentCount })
      : s.recentEmptyText || "";
    const pinBadge = row.isPinned ? `<span class="tag" style="background:var(--soft-orange);color:#9a3515">置顶</span>` : "";
    const example = row.example
      ? `
        <a class="leaderboard-example" href="${escapeAttribute(row.example.url)}" target="_blank" rel="noopener noreferrer">
          <span>${escapeHtml(s.caseLabel || "案例")}</span>
          <strong>${escapeHtml(row.example.title)}</strong>
        </a>
      `
      : "";
    return `
      <article class="leaderboard-row">
        <div class="rank-badge">#${index + 1}</div>
        <div class="leaderboard-main">
          <div class="leaderboard-title">
            <h4>${escapeHtml(row.title)}</h4>
            ${pinBadge}
            <span>${escapeHtml(row.bestFor || "")}</span>
          </div>
          <p>${escapeHtml(row.thesis || "")}</p>
          <div class="leaderboard-meta">
            <span>${escapeHtml(interpolate(s.itemCountTemplate || "{count}", { count: row.count }))}</span>
            <span>${escapeHtml(interpolate(s.shareTemplate || "{share}%", { share: row.share }))}</span>
            <span>${escapeHtml(interpolate(s.sourceCountTemplate || "{count}", { count: row.sourceCount }))}</span>
            <span>${escapeHtml(recentLabel)}</span>
          </div>
          <div class="leaderboard-action">
            <strong>${escapeHtml(s.firstStepLabel || "第一步")}</strong>
            <span>${escapeHtml(firstMove)}</span>
          </div>
          ${example}
        </div>
        <div class="score-panel">
          <strong>${row.score}</strong>
          <span>${escapeHtml(s.scoreLabel || "机会分")}</span>
          <div class="score-bar" aria-hidden="true"><i style="width: ${row.score}%"></i></div>
        </div>
      </article>
    `;
  }

  function renderInsightCard(row, payload, s) {
    const blocks = s.blockLabels || {};
    const opportunitySentence = row.count
      ? interpolate(s.opportunityTemplate || "{opportunity}", {
          opportunity: row.opportunity || "",
          lookbackDays: payload.lookbackDays,
          count: row.count,
          sectorName: payload.targetSector.name,
          percent: row.share,
          sourceCount: row.sourceCount,
          signal: row.signal || "",
        })
      : interpolate(s.opportunityEmptyTemplate || "{opportunity}", {
          opportunity: row.opportunity || "",
          lookbackDays: payload.lookbackDays,
        });
    const firstAction = row.firstAction || (row.action || [])[0] || s.defaultFirstAction || "";
    const caseList = row.examples && row.examples.length
      ? `<ul class="case-list">${row.examples
          .map(
            (item) => `
              <li>
                <a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
                <span>${escapeHtml(item.sourceName)} · ${escapeHtml(formatRelative(item.publishedAt))}</span>
              </li>
            `
          )
          .join("")}</ul>`
      : `<p>${escapeHtml(s.emptyCaseText || "")}</p>`;
    return `
      <article class="insight-card">
        <div class="insight-card-head">
          <span>${escapeHtml(row.metricLabel || "")}${row.isPinned ? " · 置顶" : ""}</span>
          <strong>${escapeHtml(interpolate(s.topicMetricTemplate || "{count} · {percent}%", { count: row.count, percent: row.share }))}</strong>
        </div>
        <h3>${escapeHtml(row.title)}</h3>
        <p class="insight-thesis">${escapeHtml(row.thesis || "")}</p>
        <div class="insight-block"><h4>${escapeHtml(blocks.opportunity || "机会")}</h4><p>${escapeHtml(opportunitySentence)}</p></div>
        <div class="insight-block"><h4>${escapeHtml(blocks.threshold || "门槛")}</h4><p>${escapeHtml(row.threshold || "")}</p></div>
        <div class="insight-block"><h4>${escapeHtml(blocks.cases || "案例")}</h4>${caseList}</div>
        <div class="insight-block"><h4>${escapeHtml(blocks.tools || "工具")}</h4><div class="tool-list">${(row.tools || []).map((tool) => `<span>${escapeHtml(tool)}</span>`).join("")}</div></div>
        <div class="insight-block first-step-block"><h4>${escapeHtml(blocks.firstAction || "第一步行动")}</h4><p>${escapeHtml(firstAction)}</p></div>
      </article>
    `;
  }

  // ---------- 页面渲染 ----------
  async function renderPageHome(main) {
    main.innerHTML = `
      ${heroHtml()}
      ${statsHtml()}
      ${refreshStatusHtml()}
      ${moduleVisible("radar") ? radarShellHtml() : ""}
    `;
    if (moduleVisible("radar")) {
      bindRadarEvents();
      await loadFeed(true);
    }
  }

  async function renderPageLeaderboard(main) {
    const s = moduleSettings("insights");
    main.innerHTML = `<p class="refresh-status">正在计算各方向机会分...</p>`;
    const payload = await loadInsights();
    main.innerHTML = `
      <section class="section income-insights">
        ${insightsHeadHtml(s, payload)}
        ${insightsMetricsHtml(s, payload)}
        <div class="opportunity-board">
          <div class="leaderboard-head">
            <div>
              <p class="eyebrow">${escapeHtml(s.leaderboardEyebrow || "")}</p>
              <h3>${escapeHtml(s.leaderboardTitle || "")}</h3>
            </div>
            <p>${escapeHtml(
              payload.rows.length && payload.rows[0].count
                ? interpolate(s.leaderboardSummaryTemplate || "", {
                    lookbackDays: payload.lookbackDays,
                    topTitle: payload.rows[0].title,
                    topScore: payload.rows[0].score,
                  })
                : interpolate(s.leaderboardSummaryEmptyTemplate || "", { lookbackDays: payload.lookbackDays })
            )}</p>
          </div>
          <div class="leaderboard-list">${payload.rows.map((row, index) => renderOpportunityRow(row, index, s)).join("")}</div>
        </div>
      </section>
    `;
  }

  async function renderPageInsights(main) {
    const s = moduleSettings("insights");
    main.innerHTML = `<p class="refresh-status">正在读取机会洞察数据...</p>`;
    const payload = await loadInsights();
    // 卡片顺序：置顶优先，其余按话题自身排序
    const cards = [...payload.rows].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return a.sortOrder - b.sortOrder;
    });
    main.innerHTML = `
      <section class="section income-insights">
        ${insightsHeadHtml(s, payload)}
        ${insightsMetricsHtml(s, payload)}
        <div class="insight-grid">${cards.map((row) => renderInsightCard(row, payload, s)).join("")}</div>
      </section>
    `;
  }

  function renderPageReport(main) {
    const s = moduleSettings("report");
    const report = state.data.report;
    const body = report
      ? `
        <article class="report-card">
          <p class="report-meta">${escapeHtml(
            interpolate(s.generatedAtTemplate || "{generatedAt}", {
              generatedAt: formatDateTime(report.createdAt),
              model: report.model || "",
            })
          )}</p>
          <div class="report-content">${renderMarkdown(report.contentMd)}</div>
        </article>
      `
      : `<div class="report-empty">${escapeHtml(s.emptyText || "暂无日报")}</div>`;
    main.innerHTML = `
      <section class="section report-section">
        <div class="section-head">
          <div>
            <p class="eyebrow">${escapeHtml(s.eyebrow || "")}</p>
            <h2>${escapeHtml(report ? report.title : s.title || "")}</h2>
          </div>
        </div>
        ${body}
      </section>
    `;
  }

  function renderPageSources(main) {
    const s = moduleSettings("sources");
    const sources = (state.data.stats && state.data.stats.sources) || [];
    const cards = sources
      .map((source) => {
        const badge = source.ok === false
          ? `<span class="source-status error">${escapeHtml(s.failBadgeText || "失败")}</span>`
          : `<span class="source-status">${escapeHtml(interpolate(s.okBadgeTemplate || "{count}", { count: source.count || 0 }))}</span>`;
        const statusLine = source.ok === false ? escapeHtml(source.error || "") : escapeHtml(s.okText || "");
        return `
          <article class="source-card">
            ${badge}
            <h3><a href="${escapeAttribute(source.homepage || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)}</a></h3>
            <p>${escapeHtml(interpolate(s.typeRegionTemplate || "{type} · {region}", { type: source.type, region: source.region }))}</p>
            <p>${statusLine}</p>
          </article>
        `;
      })
      .join("");
    main.innerHTML = `
      <section class="section sources-section">
        <div class="section-head">
          <div>
            <p class="eyebrow">${escapeHtml(s.eyebrow || "")}</p>
            <h2>${escapeHtml(s.title || "")}</h2>
          </div>
          <p>${escapeHtml(s.description || "")}</p>
        </div>
        <div class="source-grid">${cards}</div>
      </section>
    `;
  }

  function renderPageMethod(main) {
    const s = moduleSettings("method");
    const cards = (s.cards || [])
      .map(
        (card) => `
          <article>
            <strong>${escapeHtml(card.num || "")}</strong>
            <h3>${escapeHtml(card.title || "")}</h3>
            <p>${escapeHtml(card.body || "")}</p>
          </article>
        `
      )
      .join("");
    main.innerHTML = `
      <section class="section method-section">
        <div class="section-head">
          <div>
            <p class="eyebrow">${escapeHtml(s.eyebrow || "")}</p>
            <h2>${escapeHtml(s.title || "")}</h2>
          </div>
        </div>
        <div class="method-grid">${cards}</div>
      </section>
    `;
  }

  const ROUTE_MODULE = {
    "/": "radar",
    "/leaderboard": "insights",
    "/insights": "insights",
    "/report": "report",
    "/sources": "sources",
    "/method": "method",
  };

  function applyLocation() {
    const loc = parseLocation();
    state.username = loc.username;
    state.route = loc.page;
  }

  async function renderRoute() {
    const main = document.querySelector("[data-main]");
    renderTopbar();
    renderFooter();

    // 访问 /<用户名> 但用户不存在/已停用
    if (state.data && state.data.userNotFound) {
      main.innerHTML = `<div class="empty-state" style="margin:40px 0"><h3>用户不存在</h3><p>没有找到用户「${escapeHtml(state.data.requestedUser || state.username || "")}」，可能尚未创建或已停用。</p><p><a href="/" style="color:var(--green);font-weight:800">返回首页</a></p></div>`;
      document.title = "用户不存在";
      return;
    }

    // 模块被隐藏时该页面不可用，回首页内容
    const ownerModule = ROUTE_MODULE[state.route];
    if (state.route !== "/" && ownerModule && !moduleVisible(ownerModule)) {
      main.innerHTML = `<div class="empty-state" style="margin:40px 0"><h3>该板块已隐藏</h3><p>可在配置中重新开启。</p></div>`;
      return;
    }

    // 页面标题
    const navLabel = modules()
      .flatMap((m) => m.navItems || [])
      .find((nav) => nav.path === state.route);
    const siteTitle = (state.data.site && state.data.site.title) || document.title;
    document.title = navLabel && state.route !== "/" ? `${navLabel.label} · ${siteTitle}` : siteTitle;

    try {
      if (state.route === "/leaderboard") await renderPageLeaderboard(main);
      else if (state.route === "/insights") await renderPageInsights(main);
      else if (state.route === "/report") renderPageReport(main);
      else if (state.route === "/sources") renderPageSources(main);
      else if (state.route === "/method") renderPageMethod(main);
      else await renderPageHome(main);
    } catch (error) {
      main.innerHTML = `<div class="empty-state" style="margin:40px 0"><h3>加载失败</h3><p>${escapeHtml(String(error.message || error))}</p></div>`;
    }
  }

  // ---------- 刷新 ----------
  function setRefreshStatus(message, status = "") {
    const el = document.querySelector("[data-refresh-status]");
    if (!el) return;
    el.textContent = message;
    el.className = `refresh-status${status ? ` ${status}` : ""}`;
  }

  function setRefreshButton(busy) {
    const button = document.querySelector("[data-refresh]");
    if (!button) return;
    const s = moduleSettings("topbar");
    button.disabled = busy;
    button.textContent = busy ? s.refreshingLabel || "..." : s.refreshLabel || "刷新";
  }

  async function pollRefreshUntilDone() {
    const statusSettings = moduleSettings("refresh-status");
    const lookbackDays = (state.data.stats || {}).lookbackDays || 30;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      let payload;
      try {
        const response = await fetch("/api/refresh/status");
        payload = await response.json();
      } catch (_) {
        continue;
      }
      if (payload.running) {
        if (payload.phase) {
          setRefreshStatus(`${interpolate(statusSettings.runningText || "", { lookbackDays })}（${payload.phase}）`);
        }
        continue;
      }
      return payload.lastRun;
    }
  }

  async function onRefreshClick() {
    if (state.refreshing || IS_STATIC) return;
    const statusSettings = moduleSettings("refresh-status");
    const lookbackDays = (state.data.stats || {}).lookbackDays || 30;
    state.refreshing = true;
    setRefreshButton(true);
    setRefreshStatus(interpolate(statusSettings.runningText || "正在刷新", { lookbackDays }));
    try {
      const response = await fetch("/api/refresh", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 409) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      const lastRun = await pollRefreshUntilDone();
      state.insights = null;
      await loadData();
      await renderRoute();
      if (lastRun && lastRun.status === "ok") {
        const stats = (lastRun && lastRun.stats) || {};
        setRefreshStatus(
          interpolate(statusSettings.successTemplate || "刷新完成", {
            items: (state.data.stats || {}).itemCount || 0,
            ok: stats.okSourceCount || 0,
            total: stats.sourceCount || 0,
            linkText: linkResolutionText(),
          }),
          "success"
        );
      } else {
        setRefreshStatus(
          interpolate(statusSettings.errorTemplate || "刷新失败：{error}", {
            error: (lastRun && lastRun.error) || "未知错误",
          }),
          "error"
        );
      }
    } catch (error) {
      setRefreshStatus(interpolate(statusSettings.errorTemplate || "刷新失败：{error}", { error: error.message }), "error");
    } finally {
      state.refreshing = false;
      setRefreshButton(false);
    }
  }

  // ---------- 启动 ----------
  async function boot() {
    try {
      applyLocation(); // 先确定 username，再带着它请求数据
      await loadData();
      await renderRoute();
      if (IS_STATIC) {
        window.addEventListener("hashchange", async () => {
          applyLocation();
          await renderRoute();
        });
      }
    } catch (error) {
      document.querySelector("[data-main]").innerHTML =
        `<div class="empty-state" style="margin:40px 0"><h3>数据加载失败</h3><p>${escapeHtml(String(error.message || error))}</p></div>`;
    }
  }

  boot();
})();
