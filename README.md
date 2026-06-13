# AI破局情报导航 · 全球 AI 信息雷达

复刻自 [ai-poju-radar-production.up.railway.app](https://ai-poju-radar-production.up.railway.app) 的增强版：
**数据库驱动 + 页面全要素后台可配置 + GLM-5.1 智能分类/摘要/洞察日报**。

## 功能总览

- **情报聚合**：内置 157 个公开来源（官方博客 / arXiv / 科技媒体 / Google News 搜索源，反推自参考站），自动抓取最近 30 天 AI 资讯并按 13 个赛道归类
- **赛道入库**：赛道与分类关键词存 MySQL，后台可增删改、调序、显隐；关键词规则即改即用（支持一键全量重分类）
- **全要素可配置**：页面上所有可见文案（品牌、导航、标题、筛选项、方法卡、页脚、**「全部 AI 情报」汇总标签**等）都在后台「页面与文案」中编辑
- **模块排序**：首页各模块（Hero / 统计 / 机会洞察 / AI日报 / 情报流 / 来源库 / 抓取策略）支持上下移调序与显隐，导航自动联动
- **GLM-5.1 三能力**：关键词判不准的条目智能分类、热门英文条目中文摘要、每轮抓取后生成「AI 机会洞察日报」；支持每轮上限、每日 token 预算、熔断降级（大模型故障不影响抓取）
- **Google News 解链**：搜索源的跳转链接自动解析回原文链接（base64 解码 + batchexecute 双通道 + 持久缓存 + 存量分批升级）
- **多用户**：全局唯一管理员（其配置即首页 `/`），可创建普通用户；用户登录后在「我的主页配置」里挑选展示赛道及顺序、置顶话题、自定义标题，通过 `主页网址/用户名` 访问自己的页面。情报抓取全站共享，个人配置只改呈现
- **管理后台** `/admin`：用户名+密码登录（管理员默认 `admin` / `admin123`，请尽快修改）；管理员看到全部管理面板 + 用户管理 + 我的主页配置，普通用户只看到「我的主页配置」

## 多用户使用

| 角色 | 登录 | 能做什么 | 页面地址 |
|---|---|---|---|
| 管理员（唯一） | `admin` / 初始 `admin123` | 全局抓取/来源/赛道/文案管理 + 用户管理 + 配置自己的首页 | `/`（即站点首页） |
| 普通用户 | 管理员在「用户管理」里创建并给初始密码 | 只配置自己的展示页（赛道筛选与排序、置顶话题、标题文案、默认赛道） | `/<用户名>` |

- 管理员在后台「用户管理」创建用户、改名、重置密码、停用/删除
- 任何人在公开页右上角点「登录」进入 `/admin`
- 普通用户保存配置后，访问 `https://你的站点/用户名` 即可看到个性化页面（子页面如 `/用户名/leaderboard`）
- 普通用户**不能**改动全局抓取与来源（那是共享的、按 admin 配置统一抓取）

> 多用户依赖 Node 服务（本地 `npm start` 或 Railway）。GitHub Pages 静态镜像只发布**管理员的首页**（无登录、无多用户）。

## 本地运行

要求：Node.js ≥ 20

```bash
npm install
cp .env.example .env   # 填入 DATABASE_URL / GLM_API_KEY / ADMIN_PASSWORD
npm start
```

- 首次启动自动建表、写入种子数据（13 赛道 / 157 来源 / 39 洞察话题 / 10 页面模块 / 全部默认文案），并触发首次抓取
- 前台 http://localhost:3000 ，后台 http://localhost:3000/admin
- **国内网络**：访问 Google News 需要代理。代理地址是后台设置项（系统设置 → 抓取 → **出网代理地址**，默认 `http://127.0.0.1:7890`，即 Clash 本地端口），改完即时生效无需重启；留空则用 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，都没有则直连。**代理不可达时自动探测并降级直连**，因此同一份配置部署到海外服务器也能正常工作。当前代理状态显示在后台「概览与抓取」

## 部署到 GitHub Pages（免费公开镜像）

GitHub Pages 只能托管静态文件，因此采用「**GitHub Actions 定时抓取 → 静态导出 → Pages 发布**」模式：
公网访客看到的是只读镜像（hash 路由、无刷新按钮、无后台），数据由 Actions 定时更新。

1. 推送本仓库到 GitHub（`main` 分支）
2. 仓库 **Settings → Secrets and variables → Actions** 添加两个 Secret：
   - `DATABASE_URL`：MySQL 连接串
   - `GLM_API_KEY`：智谱 API Key
3. 工作流 `.github/workflows/deploy.yml` 会自动运行：
   - 北京时间 **05:00**：抓取 + 生成当日 AI 日报 + 发布
   - 北京时间 09:00 / 15:00 / 21:00：抓取最新数据 + 发布
   - 每次 push 到 main 也会触发
4. 首次运行后访问 `https://<你的用户名>.github.io/ai-radar-production/`

> 管理后台不在静态镜像里：本地 `npm start` 后访问 /admin 管理（赛道、来源、文案、置顶等改动存数据库，下次 Actions 发布时自动带上）。

## 部署到 Railway

1. 新建项目，连接本仓库（或 `railway up`）
2. 环境变量：
   | 变量 | 说明 |
   |---|---|
   | `DATABASE_URL` | `mysql://user:password@host:port/database`（密码需 URL 编码） |
   | `GLM_API_KEY` | 智谱 BigModel API Key |
   | `ADMIN_PASSWORD` | 后台初始密码（仅首次种子生效） |
3. 启动命令默认 `npm start`；健康检查路径 `/api/health`
4. 部署后立即登录 `/admin` → 系统设置 → 修改管理密码

## 配置项（后台「系统设置」）

| 分组 | 关键项 | 默认 |
|---|---|---|
| 抓取 | 保留天数 / 并发数 / 定时间隔（分钟，0=关）/ 公共刷新冷却 / Google 解链开关与每轮上限 | 30 / 12 / 360 / 300s / 开、150 |
| 大模型 | 总开关 / API 地址 / Key / 模型 / 分类·摘要·日报独立开关与上限 / 每日 token 预算 | glm-5.1，预算 50 万 |
| 站点 | 浏览器标题 / SEO 描述 | — |

## 架构

```
server.js                 入口（代理自举 → 建池 → 建表 → 种子 → 路由 → 定时器）
src/
  db.js                   mysql2 连接池（腾讯云 TXSQL 强制 latin1，已显式 SET NAMES utf8mb4）
  schema.js / seed.js     10 张表 DDL + 幂等种子（seed.version 哨兵）
  auth.js                 scrypt 口令 + 无状态 HMAC token（改密即全失效）+ 登录限速
  routes/public.js        GET /api/data（30s 缓存+ETag）、POST /api/refresh（异步+轮询）等
  routes/admin.js         /api/admin/*：登录、各资源 CRUD、排序、设置、测试
  services/
    crawler.js            抓取编排：并发池（Google 限4 / Reddit 串行+1.5s）→ 解链 → 去重 → 分类 → 入库 → 清理 → LLM 三阶段
    feedParser.js         RSS2/Atom/RDF 归一化（fast-xml-parser，自带实体解码）
    googleNews.js         解链三级降级 + link_cache + 存量升级
    classifier.js         关键词打分（标题+2/摘要+1/来源偏置+1.5；ASCII 词边界、CJK 包含）
    llm.js                GLM 客户端（默认关思考模式、超时重试、熔断、llm_usage 记账）
    insights.js           日报数据聚合与生成
    dataSnapshot.js       /api/data 负载组装
seed/*.json               种子数据（来源库反推结果在 sources.json）
public/                   前台（app.js 按 modules 表驱动渲染）+ admin/ 后台 SPA
scripts/extract-seeds.js  开发期工具：从参考站资产再生成种子
scripts/run-crawl.js      手动跑一轮抓取（--no-llm / --llm）
```

### 数据表

`sectors` 赛道（含分类关键词） · `sources` 来源库 · `items` 情报条目（url_hash 身份键去重） · `insight_topics` 39 个洞察话题 · `modules` 页面模块（顺序/显隐/文案 settings） · `site_settings` K-V 设置 · `crawl_runs` 抓取历史 · `ai_reports` 洞察日报 · `link_cache` Google 解链缓存 · `llm_usage` 大模型日用量

### 已知行为

- 同一文章在 Google News 多个搜索源出现时按规范化文章 ID 去重；解链额度用尽时先保留 Google 跳转链接，后续轮次自动分批升级为原文链接
- Reddit 对未认证 RSS 限流较严，偶发 `HTTP 429` 失败属正常，下轮自动恢复；`Microsoft AI Blog` feed 已死（HTTP 410，参考站同样失败）
- GLM-5.1 是思考型模型，本项目默认关闭 thinking 以节省 token；日报生成约 10–30 秒
