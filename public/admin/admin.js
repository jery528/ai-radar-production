/* 管理后台 SPA：8 个 tab，全部数据走 /api/admin/*，Bearer token 鉴权 */
(() => {
  "use strict";

  const TOKEN_KEY = "radar_admin_token";
  let token = localStorage.getItem(TOKEN_KEY) || "";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function escapeHtml(value = "") {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "—"
      : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // ---------- 基础设施 ----------
  let toastTimer = null;
  function toast(message, isError = false) {
    const el = $("[data-toast]");
    el.textContent = message;
    el.className = `toast${isError ? " error" : ""}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && typeof options.body !== "string") {
      options = { ...options, body: JSON.stringify(options.body) };
      headers["content-type"] = "application/json";
    }
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401) {
      showLogin();
      throw new Error("登录已过期");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && !options.allowError) {
      throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { payload, status: response.status });
    }
    return payload;
  }

  // ---------- 登录 ----------
  function showLogin() {
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    $("[data-shell]").hidden = true;
    $("[data-login]").hidden = false;
    setTimeout(() => $("[data-login-password]").focus(), 50);
  }

  function showShell() {
    $("[data-login]").hidden = true;
    $("[data-shell]").hidden = false;
  }

  $("[data-login-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = $("[data-login-error]");
    errorEl.hidden = true;
    try {
      const result = await api("/api/admin/login", {
        method: "POST",
        body: {
          username: $("[data-login-username]").value.trim(),
          password: $("[data-login-password]").value,
        },
      });
      token = result.token;
      localStorage.setItem(TOKEN_KEY, token);
      $("[data-login-password]").value = "";
      await start();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    }
  });

  $("[data-logout]").addEventListener("click", showLogin);

  // ---------- Tab 路由 ----------
  const views = {};
  let currentTab = "profile";
  let currentUser = null; // { username, role }

  /** 按角色显示可用 tab，普通用户只看到「我的主页配置」 */
  function setupTabsForRole(role) {
    $$("[data-tab]").forEach((button) => {
      const need = button.dataset.role;
      button.hidden = need === "admin" && role !== "admin";
    });
    const viewLink = $("[data-view-site]");
    if (viewLink && currentUser) {
      viewLink.href = currentUser.role === "admin" ? "/" : `/${encodeURIComponent(currentUser.username)}`;
    }
  }

  function switchTab(tab) {
    currentTab = tab;
    $$("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    const panel = $("[data-panel]");
    panel.innerHTML = `<p class="muted">加载中...</p>`;
    views[tab](panel).catch((error) => {
      panel.innerHTML = `<p class="muted">加载失败：${escapeHtml(error.message)}</p>`;
    });
  }

  $("[data-tabs]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button) switchTab(button.dataset.tab);
  });

  // ---------- 通用控件 ----------
  function switchControl(checked, onChange) {
    const label = document.createElement("label");
    label.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    input.addEventListener("change", () => onChange(input.checked, input));
    const knob = document.createElement("i");
    label.append(input, knob);
    return label;
  }

  function fieldWrap(labelText, control) {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(span, control);
    return label;
  }

  /** 通用 JSON 值编辑器：就地修改 holder[key] */
  function buildValueEditor(holder, key) {
    const value = holder[key];

    if (typeof value === "boolean") {
      const wrap = document.createElement("div");
      wrap.className = "field-inline";
      wrap.append(switchControl(value, (checked) => (holder[key] = checked)));
      const span = document.createElement("span");
      span.textContent = key;
      wrap.append(span);
      return wrap;
    }

    if (typeof value === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.value = value;
      input.addEventListener("change", () => (holder[key] = Number(input.value)));
      return fieldWrap(key, input);
    }

    if (typeof value === "string") {
      const useArea = value.length > 60 || value.includes("\n");
      const input = document.createElement(useArea ? "textarea" : "input");
      if (!useArea) input.type = "text";
      input.value = value;
      input.addEventListener("change", () => (holder[key] = input.value));
      return fieldWrap(key, input);
    }

    if (Array.isArray(value)) {
      const allStrings = value.every((v) => typeof v === "string");
      if (allStrings) {
        const area = document.createElement("textarea");
        area.value = value.join("\n");
        area.addEventListener("change", () => {
          holder[key] = area.value.split(/\r?\n|,|，/).map((s) => s.trim()).filter(Boolean);
        });
        return fieldWrap(`${key}（每行一条）`, area);
      }
      // 对象数组：子表格
      const fieldset = document.createElement("fieldset");
      fieldset.className = "nested";
      const legend = document.createElement("legend");
      legend.textContent = key;
      fieldset.append(legend);
      const columns = [...new Set(value.flatMap((row) => Object.keys(row || {})))];
      const table = document.createElement("table");
      table.className = "subtable";
      const renderRows = () => {
        table.innerHTML = "";
        holder[key].forEach((row, index) => {
          const tr = document.createElement("tr");
          for (const column of columns) {
            const td = document.createElement("td");
            const input = document.createElement("input");
            input.placeholder = column;
            input.value = row[column] === undefined || row[column] === null ? "" : row[column];
            input.addEventListener("change", () => (row[column] = input.value));
            td.append(input);
            tr.append(td);
          }
          const tdDel = document.createElement("td");
          const del = document.createElement("button");
          del.type = "button";
          del.className = "icon-btn";
          del.textContent = "✕";
          del.title = "删除此行";
          del.addEventListener("click", () => {
            holder[key].splice(index, 1);
            renderRows();
          });
          tdDel.append(del);
          tr.append(tdDel);
          table.append(tr);
        });
      };
      renderRows();
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn small";
      add.textContent = "+ 添加一行";
      add.addEventListener("click", () => {
        const blank = {};
        for (const column of columns) blank[column] = "";
        holder[key].push(blank);
        renderRows();
      });
      fieldset.append(table, add);
      return fieldset;
    }

    if (value && typeof value === "object") {
      const fieldset = document.createElement("fieldset");
      fieldset.className = "nested";
      const legend = document.createElement("legend");
      legend.textContent = key;
      fieldset.append(legend);
      for (const childKey of Object.keys(value)) {
        fieldset.append(buildValueEditor(value, childKey));
      }
      return fieldset;
    }

    // null/undefined：当作文本
    const input = document.createElement("input");
    input.type = "text";
    input.value = value === null || value === undefined ? "" : String(value);
    input.addEventListener("change", () => (holder[key] = input.value || null));
    return fieldWrap(key, input);
  }

  function arrowPair(onUp, onDown, upDisabled, downDisabled) {
    const wrap = document.createElement("div");
    wrap.className = "row-actions";
    const up = document.createElement("button");
    up.className = "icon-btn";
    up.textContent = "↑";
    up.disabled = upDisabled;
    up.addEventListener("click", onUp);
    const down = document.createElement("button");
    down.className = "icon-btn";
    down.textContent = "↓";
    down.disabled = downDisabled;
    down.addEventListener("click", onDown);
    wrap.append(up, down);
    return wrap;
  }

  // ---------- Tab 1：概览与抓取 ----------
  views.overview = async (panel) => {
    const data = await api("/api/admin/overview");
    panel.innerHTML = `
      <h2>概览与抓取</h2>
      <p class="panel-sub">系统运行状态、抓取历史与大模型用量</p>
      <div class="grid-stats">
        <div class="stat"><strong>${data.counts.items}</strong><span>情报条目</span></div>
        <div class="stat"><strong>${data.counts.enabledSources}/${data.counts.sources}</strong><span>启用来源</span></div>
        <div class="stat"><strong>${data.counts.sectors}</strong><span>赛道</span></div>
        <div class="stat"><strong>${data.counts.topics}</strong><span>洞察话题</span></div>
        <div class="stat"><strong>${data.counts.reports}</strong><span>AI 日报</span></div>
        <div class="stat"><strong>${data.llmUsageToday.calls || 0} 次</strong><span>今日 LLM 调用（${(data.llmUsageToday.prompt_tokens || 0) + (data.llmUsageToday.completion_tokens || 0)} tokens，失败 ${data.llmUsageToday.errors || 0}）</span></div>
      </div>
      <div class="card">
        <h3>抓取控制</h3>
        <div class="toolbar-row">
          <button class="btn primary" data-crawl-now>立即抓取</button>
          <span class="muted" data-crawl-state></span>
        </div>
        <p class="muted" style="margin:10px 0 0">出网代理：<span class="pill ${data.proxy && data.proxy.active ? "ok" : "dim"}">${escapeHtml((data.proxy && data.proxy.text) || "未知")}</span>　可在「系统设置 → 抓取 → 出网代理地址」修改</p>
      </div>
      <div class="card">
        <h3>失败来源（${data.failingSources.length}）</h3>
        ${data.failingSources.length
          ? `<table class="list"><tr><th>来源</th><th>错误</th></tr>${data.failingSources
              .map((s) => `<tr><td>${escapeHtml(s.name)}</td><td class="mono">${escapeHtml(s.last_error || "")}</td></tr>`)
              .join("")}</table>`
          : `<p class="muted">全部来源正常</p>`}
      </div>
      <div class="card">
        <h3>最近抓取</h3>
        <table class="list"><tr><th>#</th><th>触发</th><th>状态</th><th>开始</th><th>新增</th><th>总量</th><th>来源</th><th>LLM</th></tr>
        ${data.runs
          .map((run) => {
            const s = run.stats || {};
            const llmInfo = s.llm ? `${s.llm.classified || 0} 分类 / ${s.llm.summarized || 0} 摘要${s.llm.reportGenerated ? " / 日报" : ""}` : "—";
            return `<tr>
              <td>${run.id}</td>
              <td>${escapeHtml(run.trigger_type)}</td>
              <td><span class="pill ${run.status === "ok" ? "ok" : run.status === "running" ? "dim" : "bad"}">${run.status}</span></td>
              <td>${fmtTime(run.started_at)}</td>
              <td class="num">${s.newItemCount === undefined ? "—" : s.newItemCount}</td>
              <td class="num">${s.itemCount === undefined ? "—" : s.itemCount}</td>
              <td class="num">${s.okSourceCount === undefined ? "—" : `${s.okSourceCount}/${s.sourceCount}`}</td>
              <td>${llmInfo}</td>
            </tr>`;
          })
          .join("")}</table>
      </div>
    `;

    const stateEl = $("[data-crawl-state]", panel);
    const crawlButton = $("[data-crawl-now]", panel);

    async function trackProgress() {
      crawlButton.disabled = true;
      for (;;) {
        let status;
        try {
          status = await fetch("/api/refresh/status").then((r) => r.json());
        } catch (_) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (!status.running) {
          crawlButton.disabled = false;
          stateEl.textContent = status.lastRun
            ? `上次：${status.lastRun.status}（${fmtTime(status.lastRun.finishedAt)}）`
            : "";
          if (currentTab === "overview") switchTab("overview");
          return;
        }
        stateEl.textContent = `运行中：${status.phase || "..."}`;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (data.crawlerState.running) trackProgress();

    crawlButton.addEventListener("click", async () => {
      try {
        await api("/api/admin/refresh", { method: "POST" });
        toast("已触发抓取");
        trackProgress();
      } catch (error) {
        if (error.status === 409) {
          toast("已有任务在运行");
          trackProgress();
        } else {
          toast(error.message, true);
        }
      }
    });
  };

  // ---------- Tab 2：页面与文案（模块） ----------
  views.modules = async (panel) => {
    const { modules } = await api("/api/admin/modules");
    panel.innerHTML = `
      <h2>页面与文案</h2>
      <p class="panel-sub">控制前台各模块的显示、顺序、导航与全部文案。「全部 AI 情报」标题在「情报流」模块的 allItemsTitle 设置项里。</p>
      <div data-module-list></div>
    `;
    const listEl = $("[data-module-list]", panel);

    const orderable = modules.filter((m) => m.is_orderable);

    async function saveOrder() {
      await api("/api/admin/modules/order", { method: "PUT", body: { ids: orderable.map((m) => m.id) } });
      toast("顺序已保存");
      switchTab("modules");
    }

    function renderList() {
      listEl.innerHTML = "";
      for (const mod of modules) {
        const row = document.createElement("div");
        row.className = "module-row";

        const name = document.createElement("span");
        name.className = "name";
        name.textContent = mod.name;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = `${mod.id}${mod.nav_items.length ? ` · 导航：${mod.nav_items.map((n) => n.label).join("/")}` : ""}`;
        const spacer = document.createElement("span");
        spacer.className = "spacer";

        const visible = switchControl(mod.is_visible, async (checked) => {
          try {
            await api(`/api/admin/modules/${mod.id}`, { method: "PUT", body: { is_visible: checked } });
            toast(`${mod.name} 已${checked ? "显示" : "隐藏"}`);
          } catch (error) {
            toast(error.message, true);
          }
        });
        visible.title = "显示/隐藏";

        row.append(name, meta, spacer, visible);

        if (mod.is_orderable) {
          const index = orderable.indexOf(mod);
          row.append(
            arrowPair(
              () => {
                [orderable[index - 1], orderable[index]] = [orderable[index], orderable[index - 1]];
                saveOrder();
              },
              () => {
                [orderable[index + 1], orderable[index]] = [orderable[index], orderable[index + 1]];
                saveOrder();
              },
              index <= 0,
              index >= orderable.length - 1
            )
          );
        }

        const editor = document.createElement("details");
        editor.className = "editor";
        editor.style.flexBasis = "100%";
        const summary = document.createElement("summary");
        summary.textContent = "编辑文案与设置";
        editor.append(summary);

        let built = false;
        editor.addEventListener("toggle", () => {
          if (!editor.open || built) return;
          built = true;
          const working = JSON.parse(JSON.stringify(mod.settings));
          const navWorking = { nav_items: JSON.parse(JSON.stringify(mod.nav_items)) };
          const form = document.createElement("div");
          form.className = "form-grid mt";
          for (const key of Object.keys(working)) {
            form.append(buildValueEditor(working, key));
          }
          if (mod.nav_items.length || mod.is_orderable) {
            form.append(buildValueEditor(navWorking, "nav_items"));
          }
          const save = document.createElement("button");
          save.className = "btn primary";
          save.textContent = "保存此模块";
          save.addEventListener("click", async () => {
            try {
              await api(`/api/admin/modules/${mod.id}`, {
                method: "PUT",
                body: { settings: working, nav_items: navWorking.nav_items },
              });
              toast(`${mod.name} 已保存`);
              mod.settings = working;
              mod.nav_items = navWorking.nav_items;
            } catch (error) {
              toast(error.message, true);
            }
          });
          form.append(save);
          editor.append(form);
        });
        row.append(editor);
        listEl.append(row);
      }
    }
    renderList();
  };

  // ---------- Tab 3：赛道 ----------
  views.sectors = async (panel) => {
    const { sectors } = await api("/api/admin/sectors");
    panel.innerHTML = `
      <h2>赛道管理</h2>
      <p class="panel-sub">赛道与分类关键词存数据库；关键词命中标题 +2 / 摘要 +1，得分最高者为主赛道</p>
      <div class="card">
        <h3>新增赛道</h3>
        <div class="form-grid cols-2">
          <label class="field"><span>名称（必填）</span><input type="text" data-new-name /></label>
          <label class="field"><span>ID（可选，留空自动生成）</span><input type="text" data-new-id placeholder="如 ai-education" /></label>
          <label class="field" style="grid-column:1/-1"><span>描述</span><input type="text" data-new-desc /></label>
          <label class="field" style="grid-column:1/-1"><span>分类关键词（每行一条或逗号分隔）</span><textarea data-new-keywords></textarea></label>
        </div>
        <div class="toolbar-row mt">
          <button class="btn primary" data-create>创建赛道</button>
          <button class="btn" data-reclassify>按关键词重新分类全部条目</button>
          <span class="muted">重新分类不会改动手工指定赛道的条目</span>
        </div>
      </div>
      <div data-sector-list></div>
    `;

    $("[data-create]", panel).addEventListener("click", async () => {
      try {
        const result = await api("/api/admin/sectors", {
          method: "POST",
          body: {
            name: $("[data-new-name]", panel).value.trim(),
            id: $("[data-new-id]", panel).value.trim(),
            description: $("[data-new-desc]", panel).value.trim(),
            keywords: $("[data-new-keywords]", panel).value.split(/\r?\n|,|，/).map((s) => s.trim()).filter(Boolean),
          },
        });
        toast(`已创建赛道 ${result.id}`);
        switchTab("sectors");
      } catch (error) {
        toast(error.message, true);
      }
    });

    $("[data-reclassify]", panel).addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const result = await api("/api/admin/items/reclassify", { method: "POST" });
        toast(`扫描 ${result.scanned} 条，调整 ${result.changed} 条`);
      } catch (error) {
        toast(error.message, true);
      } finally {
        event.target.disabled = false;
      }
    });

    const listEl = $("[data-sector-list]", panel);

    async function saveOrder() {
      await api("/api/admin/sectors/order", { method: "PUT", body: { ids: sectors.map((s) => s.id) } });
      toast("顺序已保存");
      switchTab("sectors");
    }

    for (let i = 0; i < sectors.length; i++) {
      const sector = sectors[i];
      const row = document.createElement("div");
      row.className = "module-row";

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = sector.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${sector.id} · ${sector.item_count} 条`;
      const spacer = document.createElement("span");
      spacer.className = "spacer";

      const visible = switchControl(sector.is_visible, async (checked) => {
        try {
          await api(`/api/admin/sectors/${sector.id}`, { method: "PUT", body: { is_visible: checked } });
          toast(`${sector.name} 已${checked ? "显示" : "隐藏"}`);
        } catch (error) {
          toast(error.message, true);
        }
      });

      const del = document.createElement("button");
      del.className = "btn small danger";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        try {
          if (sector.item_count > 0) {
            const others = sectors.filter((s) => s.id !== sector.id).map((s) => s.id);
            const target = prompt(
              `「${sector.name}」还有 ${sector.item_count} 条情报。\n请输入转移目标赛道 ID：\n${others.join("、")}`,
              others[0] || ""
            );
            if (!target) return;
            await api(`/api/admin/sectors/${sector.id}?reassignTo=${encodeURIComponent(target)}`, { method: "DELETE" });
          } else {
            if (!confirm(`确认删除赛道「${sector.name}」？`)) return;
            await api(`/api/admin/sectors/${sector.id}`, { method: "DELETE" });
          }
          toast("已删除");
          switchTab("sectors");
        } catch (error) {
          toast(error.message, true);
        }
      });

      row.append(
        name,
        meta,
        spacer,
        visible,
        arrowPair(
          () => { [sectors[i - 1], sectors[i]] = [sectors[i], sectors[i - 1]]; saveOrder(); },
          () => { [sectors[i + 1], sectors[i]] = [sectors[i], sectors[i + 1]]; saveOrder(); },
          i <= 0,
          i >= sectors.length - 1
        ),
        del
      );

      const editor = document.createElement("details");
      editor.className = "editor";
      editor.style.flexBasis = "100%";
      editor.innerHTML = `<summary>编辑</summary>`;
      let built = false;
      editor.addEventListener("toggle", () => {
        if (!editor.open || built) return;
        built = true;
        const working = { name: sector.name, description: sector.description, keywords: [...sector.keywords] };
        const form = document.createElement("div");
        form.className = "form-grid mt";
        form.append(buildValueEditor(working, "name"));
        form.append(buildValueEditor(working, "description"));
        form.append(buildValueEditor(working, "keywords"));
        const save = document.createElement("button");
        save.className = "btn primary";
        save.textContent = "保存";
        save.addEventListener("click", async () => {
          try {
            await api(`/api/admin/sectors/${sector.id}`, { method: "PUT", body: working });
            toast("已保存");
          } catch (error) {
            toast(error.message, true);
          }
        });
        form.append(save);
        editor.append(form);
      });
      row.append(editor);
      listEl.append(row);
    }
  };

  // ---------- Tab 4：来源库 ----------
  views.sources = async (panel) => {
    const [{ sources }, { sectors }] = await Promise.all([
      api("/api/admin/sources"),
      api("/api/admin/sectors"),
    ]);
    panel.innerHTML = `
      <h2>来源库（${sources.length}）</h2>
      <p class="panel-sub">公开 RSS/Atom 与 Google News 搜索源；可增删改、启用停用、测试抓取</p>
      <div class="card">
        <h3>新增来源</h3>
        <div class="form-grid cols-2">
          <label class="field"><span>名称（必填）</span><input type="text" data-src-name /></label>
          <label class="field"><span>Feed 地址（必填）</span><input type="url" data-src-feed placeholder="https://.../rss.xml" /></label>
          <label class="field"><span>主页</span><input type="url" data-src-home /></label>
          <label class="field"><span>类型</span>
            <select data-src-type>
              <option value="official">official 官方发布</option>
              <option value="research">research 研究论文</option>
              <option value="media" selected>media 媒体报道</option>
              <option value="analysis">analysis 深度分析</option>
            </select>
          </label>
          <label class="field"><span>地区</span><input type="text" data-src-region value="Global" /></label>
          <label class="field"><span>语言</span>
            <select data-src-lang><option value="en">en</option><option value="zh">zh</option></select>
          </label>
          <label class="field"><span>默认赛道（可选）</span>
            <select data-src-sector><option value="">（无）</option>${sectors
              .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
              .join("")}</select>
          </label>
        </div>
        <div class="toolbar-row mt">
          <button class="btn" data-src-testurl>先测试抓取</button>
          <button class="btn primary" data-src-create>添加来源</button>
          <span class="muted" data-src-test-result></span>
        </div>
      </div>
      <div class="toolbar-row">
        <input type="text" placeholder="搜索名称 / ID" data-filter-q />
        <select data-filter-type>
          <option value="">全部类型</option>
          <option value="official">official</option><option value="research">research</option>
          <option value="media">media</option><option value="analysis">analysis</option>
        </select>
        <select data-filter-status>
          <option value="">全部状态</option>
          <option value="ok">正常</option><option value="fail">失败</option><option value="off">已停用</option>
        </select>
      </div>
      <div data-source-list></div>
    `;

    $("[data-src-testurl]", panel).addEventListener("click", async (event) => {
      const resultEl = $("[data-src-test-result]", panel);
      event.target.disabled = true;
      resultEl.textContent = "测试中...";
      try {
        const result = await api("/api/admin/sources/test-url", {
          method: "POST",
          body: { feed_url: $("[data-src-feed]", panel).value.trim() },
        });
        resultEl.textContent = result.ok
          ? `✓ 抓到 ${result.count} 条：${(result.sampleTitles[0] || "").slice(0, 50)}...`
          : `✗ ${result.error}`;
      } catch (error) {
        resultEl.textContent = `✗ ${error.message}`;
      } finally {
        event.target.disabled = false;
      }
    });

    $("[data-src-create]", panel).addEventListener("click", async () => {
      try {
        const result = await api("/api/admin/sources", {
          method: "POST",
          body: {
            name: $("[data-src-name]", panel).value.trim(),
            feed_url: $("[data-src-feed]", panel).value.trim(),
            homepage: $("[data-src-home]", panel).value.trim(),
            type: $("[data-src-type]", panel).value,
            region: $("[data-src-region]", panel).value.trim() || "Global",
            language: $("[data-src-lang]", panel).value,
            default_sector: $("[data-src-sector]", panel).value || null,
          },
        });
        toast(`已添加 ${result.id}`);
        switchTab("sources");
      } catch (error) {
        toast(error.message, true);
      }
    });

    const listEl = $("[data-source-list]", panel);

    function renderList() {
      const q = $("[data-filter-q]", panel).value.trim().toLowerCase();
      const type = $("[data-filter-type]", panel).value;
      const status = $("[data-filter-status]", panel).value;
      const filtered = sources.filter((s) => {
        if (q && !`${s.name} ${s.id}`.toLowerCase().includes(q)) return false;
        if (type && s.type !== type) return false;
        if (status === "ok" && !(s.is_enabled && s.last_ok === 1)) return false;
        if (status === "fail" && !(s.is_enabled && s.last_ok === 0)) return false;
        if (status === "off" && s.is_enabled) return false;
        return true;
      });

      listEl.innerHTML = "";
      const table = document.createElement("table");
      table.className = "list";
      table.innerHTML = `<tr><th>来源</th><th>类型</th><th>最近抓取</th><th>条目</th><th>启用</th><th></th></tr>`;
      for (const source of filtered) {
        const tr = document.createElement("tr");
        const statusPill = !source.is_enabled
          ? `<span class="pill dim">停用</span>`
          : source.last_ok === null
            ? `<span class="pill dim">未抓取</span>`
            : source.last_ok
              ? `<span class="pill ok">${source.last_count} 条</span>`
              : `<span class="pill bad" title="${escapeHtml(source.last_error || "")}">失败</span>`;
        tr.innerHTML = `
          <td><strong>${escapeHtml(source.name)}</strong><br /><span class="mono muted">${escapeHtml(source.id)}</span></td>
          <td>${escapeHtml(source.type)} · ${escapeHtml(source.region)}</td>
          <td>${statusPill}<br /><span class="muted mono">${fmtTime(source.last_fetched_at)}</span></td>
          <td class="num">${source.item_count}</td>
        `;
        const tdSwitch = document.createElement("td");
        tdSwitch.append(
          switchControl(source.is_enabled, async (checked) => {
            try {
              await api(`/api/admin/sources/${source.id}`, { method: "PUT", body: { is_enabled: checked } });
              source.is_enabled = checked ? 1 : 0;
              toast(`${source.name} 已${checked ? "启用" : "停用"}`);
            } catch (error) {
              toast(error.message, true);
            }
          })
        );
        tr.append(tdSwitch);

        const tdActions = document.createElement("td");
        const actions = document.createElement("div");
        actions.className = "row-actions";

        const test = document.createElement("button");
        test.className = "btn small";
        test.textContent = "测试";
        test.addEventListener("click", async () => {
          test.disabled = true;
          test.textContent = "测试中";
          try {
            const result = await api(`/api/admin/sources/${source.id}/test`, { method: "POST" });
            alert(result.ok ? `✓ 抓到 ${result.count} 条\n\n${result.sampleTitles.join("\n")}` : `✗ ${result.error}`);
          } catch (error) {
            toast(error.message, true);
          } finally {
            test.disabled = false;
            test.textContent = "测试";
          }
        });

        const edit = document.createElement("button");
        edit.className = "btn small";
        edit.textContent = "编辑";
        edit.addEventListener("click", () => {
          const working = {
            name: source.name,
            homepage: source.homepage,
            feed_url: source.feed_url,
            type: source.type,
            region: source.region,
            language: source.language,
            default_sector: source.default_sector || "",
            notes: source.notes,
          };
          const editorTr = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 6;
          const form = document.createElement("div");
          form.className = "form-grid cols-2";
          for (const key of Object.keys(working)) {
            if (key === "type") {
              const select = document.createElement("select");
              for (const t of ["official", "research", "media", "analysis"]) {
                const option = document.createElement("option");
                option.value = t;
                option.textContent = t;
                option.selected = working.type === t;
                select.append(option);
              }
              select.addEventListener("change", () => (working.type = select.value));
              form.append(fieldWrap("type", select));
            } else if (key === "default_sector") {
              const select = document.createElement("select");
              const none = document.createElement("option");
              none.value = "";
              none.textContent = "（无）";
              select.append(none);
              for (const s of sectors) {
                const option = document.createElement("option");
                option.value = s.id;
                option.textContent = s.name;
                option.selected = working.default_sector === s.id;
                select.append(option);
              }
              select.addEventListener("change", () => (working.default_sector = select.value));
              form.append(fieldWrap("default_sector 默认赛道", select));
            } else {
              form.append(buildValueEditor(working, key));
            }
          }
          const save = document.createElement("button");
          save.className = "btn primary";
          save.textContent = "保存";
          save.addEventListener("click", async () => {
            try {
              await api(`/api/admin/sources/${source.id}`, { method: "PUT", body: working });
              toast("已保存");
              switchTab("sources");
            } catch (error) {
              toast(error.message, true);
            }
          });
          form.append(save);
          td.append(form);
          editorTr.append(td);
          tr.after(editorTr);
          edit.disabled = true;
        });

        const del = document.createElement("button");
        del.className = "btn small danger";
        del.textContent = "删除";
        del.addEventListener("click", async () => {
          try {
            if (source.item_count > 0) {
              if (!confirm(`删除「${source.name}」会同时删除它的 ${source.item_count} 条情报，确认？`)) return;
              await api(`/api/admin/sources/${source.id}?confirm=1`, { method: "DELETE" });
            } else {
              if (!confirm(`确认删除来源「${source.name}」？`)) return;
              await api(`/api/admin/sources/${source.id}`, { method: "DELETE" });
            }
            toast("已删除");
            switchTab("sources");
          } catch (error) {
            toast(error.message, true);
          }
        });

        actions.append(test, edit, del);
        tdActions.append(actions);
        tr.append(tdActions);
        table.append(tr);
      }
      listEl.append(table);
    }

    renderList();
    $("[data-filter-q]", panel).addEventListener("input", renderList);
    $("[data-filter-type]", panel).addEventListener("change", renderList);
    $("[data-filter-status]", panel).addEventListener("change", renderList);
  };

  // ---------- Tab 5：洞察话题 ----------
  views.topics = async (panel) => {
    const { topics } = await api("/api/admin/topics");
    panel.innerHTML = `
      <h2>洞察话题（${topics.length}）</h2>
      <p class="panel-sub">「机会洞察」卡片与「AI变现机会排行榜」的话题定义；按关键词匹配普通人热门赛道的条目</p>
      <div class="toolbar-row"><button class="btn primary" data-topic-new>+ 新增话题</button></div>
      <div data-topic-list></div>
    `;

    $("[data-topic-new]", panel).addEventListener("click", async () => {
      const title = prompt("话题标题（如：AI视频剪辑接单）");
      if (!title) return;
      try {
        const result = await api("/api/admin/topics", {
          method: "POST",
          body: { title, keywords: [title], actions: ["", "", ""] },
        });
        toast(`已创建 ${result.id}，请展开编辑完善字段`);
        switchTab("topics");
      } catch (error) {
        toast(error.message, true);
      }
    });

    const listEl = $("[data-topic-list]", panel);

    async function saveOrder() {
      await api("/api/admin/topics/order", { method: "PUT", body: { ids: topics.map((t) => t.id) } });
      toast("顺序已保存");
      switchTab("topics");
    }

    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      const row = document.createElement("div");
      row.className = "module-row";

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = topic.title;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${topic.id} · ${topic.metric_label}`;
      const spacer = document.createElement("span");
      spacer.className = "spacer";

      const visible = switchControl(topic.is_visible, async (checked) => {
        try {
          await api(`/api/admin/topics/${topic.id}`, { method: "PUT", body: { is_visible: checked } });
          toast(`已${checked ? "显示" : "隐藏"}`);
        } catch (error) {
          toast(error.message, true);
        }
      });

      const pinWrap = document.createElement("span");
      pinWrap.className = "meta";
      pinWrap.textContent = "置顶";
      const pinned = switchControl(topic.is_pinned, async (checked) => {
        try {
          await api(`/api/admin/topics/${topic.id}`, { method: "PUT", body: { is_pinned: checked } });
          toast(checked ? "已置顶（排行榜与卡片均排第一）" : "已取消置顶");
        } catch (error) {
          toast(error.message, true);
        }
      });

      const del = document.createElement("button");
      del.className = "btn small danger";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        if (!confirm(`确认删除话题「${topic.title}」？`)) return;
        try {
          await api(`/api/admin/topics/${topic.id}`, { method: "DELETE" });
          toast("已删除");
          switchTab("topics");
        } catch (error) {
          toast(error.message, true);
        }
      });

      row.append(
        name, meta, spacer, pinWrap, pinned, visible,
        arrowPair(
          () => { [topics[i - 1], topics[i]] = [topics[i], topics[i - 1]]; saveOrder(); },
          () => { [topics[i + 1], topics[i]] = [topics[i], topics[i + 1]]; saveOrder(); },
          i <= 0,
          i >= topics.length - 1
        ),
        del
      );

      const editor = document.createElement("details");
      editor.className = "editor";
      editor.style.flexBasis = "100%";
      editor.innerHTML = `<summary>编辑全部字段</summary>`;
      let built = false;
      editor.addEventListener("toggle", () => {
        if (!editor.open || built) return;
        built = true;
        const working = {
          title: topic.title,
          thesis: topic.thesis,
          signal_text: topic.signal_text,
          keywords: [...topic.keywords],
          metric_label: topic.metric_label,
          best_for: topic.best_for,
          opportunity: topic.opportunity,
          threshold_text: topic.threshold_text,
          tools: [...topic.tools],
          first_action: topic.first_action,
          actions: [...topic.actions],
        };
        const form = document.createElement("div");
        form.className = "form-grid mt";
        for (const key of Object.keys(working)) form.append(buildValueEditor(working, key));
        const save = document.createElement("button");
        save.className = "btn primary";
        save.textContent = "保存";
        save.addEventListener("click", async () => {
          try {
            await api(`/api/admin/topics/${topic.id}`, { method: "PUT", body: working });
            toast("已保存");
          } catch (error) {
            toast(error.message, true);
          }
        });
        form.append(save);
        editor.append(form);
      });
      row.append(editor);
      listEl.append(row);
    }
  };

  // ---------- Tab 6：情报条目 ----------
  views.items = async (panel) => {
    const { sectors } = await api("/api/admin/sectors");
    panel.innerHTML = `
      <h2>情报条目</h2>
      <p class="panel-sub">搜索、筛选、手工调整赛道（调整后标记为 manual，重新分类时不会被覆盖）</p>
      <div class="toolbar-row">
        <input type="text" placeholder="搜索标题/摘要" data-items-q />
        <select data-items-sector>
          <option value="">全部赛道</option>
          ${sectors.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("")}
        </select>
        <button class="btn" data-items-search>查询</button>
      </div>
      <div data-items-list></div>
      <div class="pager">
        <button class="btn small" data-prev>上一页</button>
        <span data-page-info></span>
        <button class="btn small" data-next>下一页</button>
      </div>
    `;

    let page = 1;

    async function load() {
      const q = encodeURIComponent($("[data-items-q]", panel).value.trim());
      const sector = encodeURIComponent($("[data-items-sector]", panel).value);
      const data = await api(`/api/admin/items?page=${page}&q=${q}&sector=${sector}`);
      const listEl = $("[data-items-list]", panel);
      listEl.innerHTML = "";
      const table = document.createElement("table");
      table.className = "list";
      table.innerHTML = `<tr><th>标题</th><th>来源</th><th>时间</th><th>赛道</th><th>分类方式</th><th></th></tr>`;
      for (const item of data.items) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="max-width:420px"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></td>
          <td>${escapeHtml(item.source_name)}</td>
          <td class="num">${fmtTime(item.published_at)}</td>
        `;
        const tdSector = document.createElement("td");
        const select = document.createElement("select");
        for (const s of sectors) {
          const option = document.createElement("option");
          option.value = s.id;
          option.textContent = s.name;
          option.selected = item.sector_id === s.id;
          select.append(option);
        }
        select.addEventListener("change", async () => {
          try {
            await api(`/api/admin/items/${item.id}`, { method: "PUT", body: { sector_id: select.value } });
            toast("已调整（manual）");
          } catch (error) {
            toast(error.message, true);
          }
        });
        tdSector.append(select);
        tr.append(tdSector);

        const tdBy = document.createElement("td");
        tdBy.innerHTML = `<span class="pill ${item.classified_by === "manual" ? "ok" : "dim"}">${item.classified_by}${item.has_ai_summary ? " · AI摘要" : ""}</span>`;
        tr.append(tdBy);

        const tdDel = document.createElement("td");
        const del = document.createElement("button");
        del.className = "btn small danger";
        del.textContent = "删除";
        del.addEventListener("click", async () => {
          if (!confirm("确认删除该条目？")) return;
          try {
            await api(`/api/admin/items/${item.id}`, { method: "DELETE" });
            tr.remove();
            toast("已删除");
          } catch (error) {
            toast(error.message, true);
          }
        });
        tdDel.append(del);
        tr.append(tdDel);
        table.append(tr);
      }
      listEl.append(table);
      $("[data-page-info]", panel).textContent = `第 ${data.page} 页 / 共 ${Math.max(1, Math.ceil(data.total / data.pageSize))} 页（${data.total} 条）`;
      $("[data-prev]", panel).disabled = page <= 1;
      $("[data-next]", panel).disabled = page * data.pageSize >= data.total;
    }

    $("[data-items-search]", panel).addEventListener("click", () => { page = 1; load(); });
    $("[data-items-q]", panel).addEventListener("keydown", (e) => { if (e.key === "Enter") { page = 1; load(); } });
    $("[data-items-sector]", panel).addEventListener("change", () => { page = 1; load(); });
    $("[data-prev]", panel).addEventListener("click", () => { page = Math.max(1, page - 1); load(); });
    $("[data-next]", panel).addEventListener("click", () => { page += 1; load(); });
    await load();
  };

  // ---------- Tab 7：AI 日报 ----------
  views.reports = async (panel) => {
    const { reports } = await api("/api/admin/reports");
    panel.innerHTML = `
      <h2>AI 机会洞察日报</h2>
      <p class="panel-sub">每次抓取后由 GLM 自动生成；也可手动重新生成。前台日报模块展示最新一篇已发布的日报。</p>
      <div class="toolbar-row"><button class="btn primary" data-generate>手动生成日报</button><span class="muted" data-generate-state></span></div>
      <div data-report-list></div>
      <div class="card mt" data-report-view-card hidden>
        <h3 data-report-view-title></h3>
        <div class="report-view" data-report-view></div>
      </div>
    `;

    $("[data-generate]", panel).addEventListener("click", async (event) => {
      event.target.disabled = true;
      $("[data-generate-state]", panel).textContent = "生成中（约 10-30 秒）...";
      try {
        await api("/api/admin/reports/generate", { method: "POST" });
        toast("日报已生成");
        switchTab("reports");
      } catch (error) {
        $("[data-generate-state]", panel).textContent = "";
        toast(error.message, true);
        event.target.disabled = false;
      }
    });

    const listEl = $("[data-report-list]", panel);
    const table = document.createElement("table");
    table.className = "list";
    table.innerHTML = `<tr><th>#</th><th>标题</th><th>模型</th><th>tokens</th><th>时间</th><th>发布</th><th></th></tr>`;
    for (const report of reports) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${report.id}</td>
        <td><strong>${escapeHtml(report.title)}</strong></td>
        <td class="mono">${escapeHtml(report.model)}</td>
        <td class="num">${report.tokens_used}</td>
        <td class="num">${fmtTime(report.created_at)}</td>
      `;
      const tdPub = document.createElement("td");
      tdPub.append(
        switchControl(report.is_published, async (checked) => {
          try {
            await api(`/api/admin/reports/${report.id}`, { method: "PUT", body: { is_published: checked } });
            toast(checked ? "已发布" : "已下线");
          } catch (error) {
            toast(error.message, true);
          }
        })
      );
      tr.append(tdPub);

      const tdActions = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "row-actions";
      const view = document.createElement("button");
      view.className = "btn small";
      view.textContent = "查看";
      view.addEventListener("click", async () => {
        const data = await api(`/api/admin/reports/${report.id}`);
        $("[data-report-view-card]", panel).hidden = false;
        $("[data-report-view-title]", panel).textContent = data.report.title;
        $("[data-report-view]", panel).textContent = data.report.content_md;
        $("[data-report-view-card]", panel).scrollIntoView({ behavior: "smooth" });
      });
      const del = document.createElement("button");
      del.className = "btn small danger";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        if (!confirm("确认删除该日报？")) return;
        try {
          await api(`/api/admin/reports/${report.id}`, { method: "DELETE" });
          tr.remove();
          toast("已删除");
        } catch (error) {
          toast(error.message, true);
        }
      });
      actions.append(view, del);
      tdActions.append(actions);
      tr.append(tdActions);
      table.append(tr);
    }
    listEl.append(reports.length ? table : Object.assign(document.createElement("p"), { className: "muted", textContent: "暂无日报" }));
  };

  // ---------- Tab 8：系统设置 ----------
  views.settings = async (panel) => {
    const { settings } = await api("/api/admin/settings");
    panel.innerHTML = `
      <h2>系统设置</h2>
      <p class="panel-sub">站点信息、抓取参数与大模型配置（API Key 已脱敏，重新输入即可更新）</p>
      <div data-settings-groups></div>
      <div class="card">
        <h3>修改管理密码</h3>
        <div class="form-grid cols-2">
          <label class="field"><span>原密码</span><input type="password" data-old-pass /></label>
          <label class="field"><span>新密码（至少 6 位）</span><input type="password" data-new-pass /></label>
        </div>
        <div class="toolbar-row mt"><button class="btn primary" data-change-pass>修改密码</button></div>
      </div>
    `;

    const groupsEl = $("[data-settings-groups]", panel);
    const groupNames = { site: "站点", crawl: "抓取", llm: "大模型（GLM）", admin: "管理" };

    for (const [category, entries] of Object.entries(settings)) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<h3>${escapeHtml(groupNames[category] || category)}</h3>`;
      const form = document.createElement("div");
      form.className = "form-grid cols-2";
      const working = {};
      for (const entry of entries) {
        working[entry.key] = entry.value;
        let control;
        if (entry.type === "boolean") {
          control = document.createElement("div");
          control.className = "field-inline";
          control.append(
            switchControl(entry.value, (checked) => (working[entry.key] = checked)),
            Object.assign(document.createElement("span"), { textContent: entry.description || entry.key })
          );
          const wrap = document.createElement("label");
          wrap.className = "field";
          wrap.innerHTML = `<span>${escapeHtml(entry.label || entry.key)}</span>`;
          wrap.append(control);
          form.append(wrap);
          continue;
        }
        const input = document.createElement("input");
        input.type = entry.type === "number" ? "number" : "text";
        if (entry.type === "number") input.step = "any";
        input.value = entry.value === null || entry.value === undefined ? "" : entry.value;
        input.addEventListener("change", () => {
          working[entry.key] = entry.type === "number" ? Number(input.value) : input.value;
        });
        const label = document.createElement("label");
        label.className = "field";
        label.title = entry.description || "";
        label.innerHTML = `<span>${escapeHtml(entry.label || entry.key)}${entry.description ? `（${escapeHtml(entry.description)}）` : ""}</span>`;
        label.append(input);
        form.append(label);
      }
      card.append(form);

      const bar = document.createElement("div");
      bar.className = "toolbar-row mt";
      const save = document.createElement("button");
      save.className = "btn primary";
      save.textContent = `保存${groupNames[category] || category}设置`;
      save.addEventListener("click", async () => {
        try {
          const result = await api("/api/admin/settings", { method: "PUT", body: { settings: working } });
          toast(`已保存 ${result.updated} 项`);
        } catch (error) {
          toast(error.message, true);
        }
      });
      bar.append(save);

      if (category === "llm") {
        const test = document.createElement("button");
        test.className = "btn";
        test.textContent = "测试连接";
        const stateSpan = document.createElement("span");
        stateSpan.className = "muted";
        test.addEventListener("click", async () => {
          test.disabled = true;
          stateSpan.textContent = "测试中...";
          try {
            const result = await api("/api/admin/llm/test", { method: "POST" });
            stateSpan.textContent = result.ok
              ? `✓ ${result.model} 回复「${result.reply}」（${result.latencyMs}ms）`
              : `✗ ${result.error}`;
          } catch (error) {
            stateSpan.textContent = `✗ ${error.message}`;
          } finally {
            test.disabled = false;
          }
        });
        bar.append(test, stateSpan);
      }
      card.append(bar);
      groupsEl.append(card);
    }

    $("[data-change-pass]", panel).addEventListener("click", async () => {
      try {
        const result = await api("/api/admin/password", {
          method: "POST",
          body: {
            oldPassword: $("[data-old-pass]", panel).value,
            newPassword: $("[data-new-pass]", panel).value,
          },
        });
        token = result.token;
        localStorage.setItem(TOKEN_KEY, token);
        toast("密码已修改，旧登录已全部失效");
        $("[data-old-pass]", panel).value = "";
        $("[data-new-pass]", panel).value = "";
      } catch (error) {
        toast(error.message, true);
      }
    });
  };

  // ---------- Tab：我的主页配置（所有用户） ----------
  views.profile = async (panel) => {
    const data = await api("/api/admin/profile");
    const profile = data.profile || {};
    const allSectors = data.sectors || [];
    const allTopics = data.topics || [];
    const myUrl = data.role === "admin" ? "/" : `/${encodeURIComponent(data.username)}`;

    panel.innerHTML = `
      <h2>我的主页配置</h2>
      <p class="panel-sub">这些设置决定 <a href="${escapeHtml(myUrl)}" target="_blank" style="color:var(--green);font-weight:800">${escapeHtml(data.role === "admin" ? "首页（站点主页）" : myUrl)}</a> 的展示；情报内容由系统统一抓取，这里只调整你自己的呈现方式。</p>
      <div class="card">
        <h3>页面文案</h3>
        <div class="form-grid">
          <label class="field"><span>页面标题（浏览器标签，留空用默认）</span><input type="text" data-p-title /></label>
          <label class="field"><span>首屏大标题（留空用默认）</span><input type="text" data-p-hero-title /></label>
          <label class="field"><span>首屏描述（留空用默认）</span><textarea data-p-hero-desc></textarea></label>
        </div>
      </div>
      <div class="card">
        <h3>显示哪些赛道 · 顺序（不勾选=显示全部）</h3>
        <div data-p-sectors></div>
      </div>
      <div class="card">
        <h3>置顶话题（排行榜与机会洞察中排最前；不选=用站点默认）</h3>
        <div data-p-topics class="form-grid"></div>
      </div>
      <div class="card">
        <h3>默认赛道</h3>
        <label class="field" style="max-width:320px"><span>进入情报流时默认选中</span><select data-p-default></select></label>
      </div>
      <div class="toolbar-row"><button class="btn primary" data-p-save>保存我的配置</button></div>
      <div class="card mt">
        <h3>修改我的密码</h3>
        <div class="form-grid cols-2">
          <label class="field"><span>原密码</span><input type="password" data-p-oldpass /></label>
          <label class="field"><span>新密码（至少 6 位）</span><input type="password" data-p-newpass /></label>
        </div>
        <div class="toolbar-row mt"><button class="btn" data-p-changepass>修改密码</button></div>
      </div>
    `;

    $("[data-p-title]", panel).value = profile.siteTitle || "";
    $("[data-p-hero-title]", panel).value = profile.heroTitle || "";
    $("[data-p-hero-desc]", panel).value = profile.heroDescription || "";

    // 赛道：已选（按 profile 顺序）在前并勾选，其余在后未勾选；可上下移
    const selectedIds = (profile.sectorIds || []).filter((id) => allSectors.some((s) => s.id === id));
    const rest = allSectors.filter((s) => !selectedIds.includes(s.id)).map((s) => s.id);
    const sel = [
      ...selectedIds.map((id) => ({ id, checked: true })),
      ...rest.map((id) => ({ id, checked: false })),
    ];
    const sectorName = (id) => (allSectors.find((s) => s.id === id) || {}).name || id;
    const sectorsEl = $("[data-p-sectors]", panel);

    function renderSectors() {
      sectorsEl.innerHTML = "";
      sel.forEach((row, index) => {
        const line = document.createElement("div");
        line.className = "module-row";
        line.style.padding = "8px 12px";
        line.append(
          switchControl(row.checked, (checked) => {
            row.checked = checked;
          })
        );
        const name = document.createElement("span");
        name.className = "name";
        name.style.minWidth = "auto";
        name.textContent = sectorName(row.id);
        const spacer = document.createElement("span");
        spacer.className = "spacer";
        line.append(name, spacer);
        line.append(
          arrowPair(
            () => { [sel[index - 1], sel[index]] = [sel[index], sel[index - 1]]; renderSectors(); },
            () => { [sel[index + 1], sel[index]] = [sel[index], sel[index + 1]]; renderSectors(); },
            index <= 0,
            index >= sel.length - 1
          )
        );
        sectorsEl.append(line);
      });
    }
    renderSectors();

    // 话题置顶（多选）
    const pinnedSet = new Set(profile.pinnedTopicIds || []);
    const topicsEl = $("[data-p-topics]", panel);
    const topicChecks = new Map();
    for (const topic of allTopics) {
      const wrap = document.createElement("label");
      wrap.className = "field-inline";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = pinnedSet.has(topic.id);
      topicChecks.set(topic.id, cb);
      const span = document.createElement("span");
      span.textContent = topic.title;
      wrap.append(cb, span);
      topicsEl.append(wrap);
    }

    // 默认赛道
    const defaultSel = $("[data-p-default]", panel);
    defaultSel.innerHTML =
      `<option value="all">全部</option>` +
      allSectors.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
    defaultSel.value = profile.defaultSector || "all";

    $("[data-p-save]", panel).addEventListener("click", async () => {
      const next = {
        siteTitle: $("[data-p-title]", panel).value.trim(),
        heroTitle: $("[data-p-hero-title]", panel).value.trim(),
        heroDescription: $("[data-p-hero-desc]", panel).value.trim(),
        sectorIds: sel.filter((r) => r.checked).map((r) => r.id),
        pinnedTopicIds: allTopics.map((t) => t.id).filter((id) => topicChecks.get(id).checked),
        defaultSector: defaultSel.value,
      };
      try {
        await api("/api/admin/profile", { method: "PUT", body: { profile: next } });
        toast("已保存，刷新你的页面即可看到");
      } catch (error) {
        toast(error.message, true);
      }
    });

    $("[data-p-changepass]", panel).addEventListener("click", async () => {
      try {
        const result = await api("/api/admin/password", {
          method: "POST",
          body: { oldPassword: $("[data-p-oldpass]", panel).value, newPassword: $("[data-p-newpass]", panel).value },
        });
        token = result.token;
        localStorage.setItem(TOKEN_KEY, token);
        toast("密码已修改");
        $("[data-p-oldpass]", panel).value = "";
        $("[data-p-newpass]", panel).value = "";
      } catch (error) {
        toast(error.message, true);
      }
    });
  };

  // ---------- Tab：用户管理（仅管理员） ----------
  views.users = async (panel) => {
    const { users } = await api("/api/admin/users");
    panel.innerHTML = `
      <h2>用户管理</h2>
      <p class="panel-sub">系统唯一管理员的配置即首页；普通用户登录后配置自己的页面，通过「主页网址/用户名」访问</p>
      <div class="card">
        <h3>新增普通用户</h3>
        <div class="form-grid cols-2">
          <label class="field"><span>用户名（2-32 位小写字母/数字/_/-）</span><input type="text" data-nu-name /></label>
          <label class="field"><span>初始密码（至少 6 位）</span><input type="text" data-nu-pass /></label>
        </div>
        <div class="toolbar-row mt"><button class="btn primary" data-nu-create>创建用户</button></div>
      </div>
      <div data-user-list></div>
    `;

    $("[data-nu-create]", panel).addEventListener("click", async () => {
      try {
        const result = await api("/api/admin/users", {
          method: "POST",
          body: { username: $("[data-nu-name]", panel).value.trim(), password: $("[data-nu-pass]", panel).value },
        });
        if (!result.ok) throw new Error(result.error);
        toast(`已创建用户 ${result.username}`);
        switchTab("users");
      } catch (error) {
        toast(error.message, true);
      }
    });

    const listEl = $("[data-user-list]", panel);
    const table = document.createElement("table");
    table.className = "list";
    table.innerHTML = `<tr><th>用户名</th><th>角色</th><th>页面</th><th>启用</th><th></th></tr>`;
    for (const user of users) {
      const tr = document.createElement("tr");
      const pageUrl = user.role === "admin" ? "/" : `/${encodeURIComponent(user.username)}`;
      tr.innerHTML = `
        <td><strong>${escapeHtml(user.username)}</strong></td>
        <td><span class="pill ${user.role === "admin" ? "ok" : "dim"}">${user.role === "admin" ? "管理员" : "普通用户"}</span></td>
        <td><a href="${escapeHtml(pageUrl)}" target="_blank" class="mono">${escapeHtml(pageUrl)}</a></td>
      `;
      const tdEnabled = document.createElement("td");
      if (user.role === "admin") {
        tdEnabled.innerHTML = `<span class="muted">—</span>`;
      } else {
        tdEnabled.append(
          switchControl(user.isEnabled, async (checked) => {
            try {
              await api(`/api/admin/users/${user.id}`, { method: "PUT", body: { isEnabled: checked } });
              toast(checked ? "已启用" : "已停用");
            } catch (error) {
              toast(error.message, true);
            }
          })
        );
      }
      tr.append(tdEnabled);

      const tdActions = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "row-actions";

      const rename = document.createElement("button");
      rename.className = "btn small";
      rename.textContent = user.role === "admin" ? "改用户名" : "改名";
      rename.addEventListener("click", async () => {
        const name = prompt(`新用户名（当前 ${user.username}）`, user.username);
        if (!name || name === user.username) return;
        try {
          const result = await api(`/api/admin/users/${user.id}`, { method: "PUT", body: { username: name } });
          if (!result.ok) throw new Error(result.error);
          toast("已修改用户名");
          switchTab("users");
        } catch (error) {
          toast(error.message, true);
        }
      });

      const resetPass = document.createElement("button");
      resetPass.className = "btn small";
      resetPass.textContent = "重置密码";
      resetPass.addEventListener("click", async () => {
        const pass = prompt(`给 ${user.username} 设置新密码（至少 6 位）`);
        if (!pass) return;
        try {
          const result = await api(`/api/admin/users/${user.id}/password`, { method: "POST", body: { newPassword: pass } });
          if (!result.ok) throw new Error(result.error);
          toast("密码已重置");
        } catch (error) {
          toast(error.message, true);
        }
      });

      actions.append(rename, resetPass);
      if (user.role !== "admin") {
        const del = document.createElement("button");
        del.className = "btn small danger";
        del.textContent = "删除";
        del.addEventListener("click", async () => {
          if (!confirm(`确认删除用户「${user.username}」？其个人配置会一并删除。`)) return;
          try {
            const result = await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
            if (!result.ok) throw new Error(result.error);
            toast("已删除");
            switchTab("users");
          } catch (error) {
            toast(error.message, true);
          }
        });
        actions.append(del);
      }
      tdActions.append(actions);
      tr.append(tdActions);
      table.append(tr);
    }
    listEl.append(table);
  };

  // ---------- 启动 ----------
  async function start() {
    try {
      const me = await api("/api/admin/me");
      currentUser = me.user;
      setupTabsForRole(currentUser.role);
      showShell();
      switchTab(currentUser.role === "admin" ? "overview" : "profile");
    } catch (_) {
      /* api() 内部已在 401 时跳登录 */
    }
  }

  (async () => {
    if (!token) return showLogin();
    await start();
  })();
})();
