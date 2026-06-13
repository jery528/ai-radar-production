const users = require("../users");

// 把用户个人 profile 应用到全局快照 / 洞察统计上（不改动全局缓存，按请求克隆）。

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * 解析请求对应的展示 profile。
 *  - 无 username（首页）→ 管理员 profile
 *  - username 存在且启用 → 该用户 profile
 *  - username 给了但不存在/停用 → 全局默认 + userNotFound 标记
 */
async function resolveProfile(usernameParam) {
  const username = users.normalizeUsername(usernameParam);
  if (!username) {
    const admin = await users.getAdmin();
    return { user: admin, profile: admin ? admin.profile : users.DEFAULT_PROFILE, found: true };
  }
  const user = await users.getByUsername(username);
  if (!user || !user.isEnabled) {
    return { user: null, profile: { ...users.DEFAULT_PROFILE }, found: false, requested: username };
  }
  return { user, profile: user.profile, found: true };
}

/** 应用到 /api/data 负载（克隆后返回） */
function applyDataProfile(base, profile, ctx = {}) {
  const payload = clone(base);
  const counts = base.sectorItemCounts || {};
  delete payload.sectorItemCounts;

  const visibleIds = payload.sectors.map((s) => s.id);
  const allowed = users.resolveAllowedSectors(profile, visibleIds);
  const allowedSet = new Set(allowed);
  const byId = new Map(payload.sectors.map((s) => [s.id, s]));
  payload.sectors = allowed.map((id) => byId.get(id)).filter(Boolean);

  if (payload.stats) {
    payload.stats.itemCount = allowed.reduce((sum, id) => sum + (counts[id] || 0), 0);
  }

  if (profile.siteTitle) payload.site.title = profile.siteTitle;
  const hero = payload.modules.find((m) => m.id === "hero");
  if (hero) {
    if (profile.heroTitle) hero.settings.title = profile.heroTitle;
    if (profile.heroDescription) hero.settings.description = profile.heroDescription;
  }

  payload.profileUser = ctx.user ? { username: ctx.user.username, role: ctx.user.role } : null;
  payload.userNotFound = Boolean(ctx.userNotFound);
  payload.requestedUser = ctx.requested || null;
  payload.allowedSectorIds = allowed;
  payload.pinnedTopicIds = profile.pinnedTopicIds || [];
  payload.defaultSector =
    profile.defaultSector && (profile.defaultSector === "all" || allowedSet.has(profile.defaultSector))
      ? profile.defaultSector
      : "all";
  return payload;
}

/** 应用到 /api/insights 负载（置顶按 profile，否则按全局 is_pinned） */
function applyInsightsProfile(base, profile) {
  const payload = clone(base);
  const pins = profile.pinnedTopicIds || [];
  const usePins = pins.length > 0;
  for (const row of payload.rows) {
    if (usePins) row.isPinned = pins.includes(row.id);
  }
  payload.rows.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned && b.isPinned) {
      if (usePins) return pins.indexOf(a.id) - pins.indexOf(b.id);
      return a.sortOrder - b.sortOrder;
    }
    return b.score - a.score || b.count - a.count;
  });
  return payload;
}

module.exports = { resolveProfile, applyDataProfile, applyInsightsProfile };
