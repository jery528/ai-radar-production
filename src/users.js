const { query } = require("./db");
const { parseJsonColumn } = require("./util");
const auth = require("./auth");

// 多用户：全局唯一 admin（其配置驱动首页），普通用户各自一份 profile（个人展示页配置）。

// 个人 profile 只控制"展示"，不影响全局抓取/来源/条目（那些由 admin 全局管理）。
const DEFAULT_PROFILE = {
  siteTitle: "", // 页面标题（留空用全局）
  heroTitle: "", // 首屏大标题（留空用全局）
  heroDescription: "", // 首屏描述（留空用全局）
  sectorIds: [], // 展示的赛道及顺序（空=全部可见赛道）
  pinnedTopicIds: [], // 置顶的洞察话题（空=用全局 is_pinned）
  defaultSector: "all", // 情报流默认选中的赛道
};

// 这些路径段是保留字，不能作为用户名（避免与页面/接口路由冲突）
const RESERVED_USERNAMES = new Set([
  "admin", "api", "u", "login", "logout", "leaderboard", "insights", "report",
  "sources", "method", "assets", "styles.css", "app.js", "data.json",
  "favicon.ico", "robots.txt", "index.html",
]);

function normalizeUsername(raw) {
  return String(raw || "").trim().toLowerCase();
}

function validateUsername(raw) {
  const username = normalizeUsername(raw);
  if (!/^[a-z0-9_-]{2,32}$/.test(username)) {
    return { ok: false, error: "用户名只能用 2-32 位小写字母、数字、下划线或连字符" };
  }
  if (RESERVED_USERNAMES.has(username)) {
    return { ok: false, error: `用户名 ${username} 为系统保留字` };
  }
  return { ok: true, username };
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    passwordHash: row.password_hash,
    profile: { ...DEFAULT_PROFILE, ...parseJsonColumn(row.profile, {}) },
    isEnabled: Boolean(row.is_enabled),
    createdAt: row.created_at,
  };
}

async function getById(id) {
  const rows = await query("SELECT * FROM users WHERE id = ?", [id]);
  return rowToUser(rows[0]);
}

async function getByUsername(username) {
  const rows = await query("SELECT * FROM users WHERE username = ?", [normalizeUsername(username)]);
  return rowToUser(rows[0]);
}

async function getAdmin() {
  const rows = await query("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  return rowToUser(rows[0]);
}

async function list() {
  const rows = await query(
    `SELECT id, username, role, is_enabled, created_at,
            (SELECT COUNT(*) FROM users) AS total
     FROM users ORDER BY role = 'admin' DESC, id`
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    isEnabled: Boolean(r.is_enabled),
    createdAt: r.created_at,
  }));
}

async function create({ username, password, role = "user", profile = {} }) {
  const check = validateUsername(username);
  if (!check.ok) return check;
  if (!password || String(password).length < 6) {
    return { ok: false, error: "密码至少 6 位" };
  }
  const existing = await getByUsername(check.username);
  if (existing) return { ok: false, error: `用户名 ${check.username} 已存在` };
  if (role === "admin") {
    const admin = await getAdmin();
    if (admin) return { ok: false, error: "系统已有管理员，只能存在一个" };
  }
  const result = await query(
    "INSERT INTO users (username, password_hash, role, profile, is_enabled) VALUES (?, ?, ?, ?, 1)",
    [check.username, auth.hashPassword(String(password)), role === "admin" ? "admin" : "user", JSON.stringify(profile)]
  );
  return { ok: true, id: result.insertId, username: check.username };
}

async function updatePassword(id, newPassword) {
  if (!newPassword || String(newPassword).length < 6) return { ok: false, error: "密码至少 6 位" };
  await query("UPDATE users SET password_hash = ? WHERE id = ?", [auth.hashPassword(String(newPassword)), id]);
  return { ok: true };
}

async function rename(id, newUsername) {
  const check = validateUsername(newUsername);
  if (!check.ok) return check;
  const existing = await getByUsername(check.username);
  if (existing && existing.id !== id) return { ok: false, error: `用户名 ${check.username} 已存在` };
  await query("UPDATE users SET username = ? WHERE id = ?", [check.username, id]);
  return { ok: true, username: check.username };
}

async function setProfile(id, profile) {
  const clean = { ...DEFAULT_PROFILE, ...(profile || {}) };
  // 只保留已知键，避免任意注入
  const stored = {};
  for (const key of Object.keys(DEFAULT_PROFILE)) stored[key] = clean[key];
  await query("UPDATE users SET profile = ? WHERE id = ?", [JSON.stringify(stored), id]);
  return { ok: true, profile: stored };
}

async function setEnabled(id, enabled) {
  await query("UPDATE users SET is_enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  return { ok: true };
}

async function remove(id) {
  const user = await getById(id);
  if (!user) return { ok: false, error: "用户不存在" };
  if (user.role === "admin") return { ok: false, error: "不能删除管理员" };
  await query("DELETE FROM users WHERE id = ?", [id]);
  return { ok: true };
}

/**
 * 把 profile 解析为可直接用于过滤的允许赛道 id 顺序列表。
 * profile.sectorIds 为空 → 返回全部传入的可见赛道顺序。
 */
function resolveAllowedSectors(profile, visibleSectorIds) {
  const visibleSet = new Set(visibleSectorIds);
  const picked = (profile.sectorIds || []).filter((id) => visibleSet.has(id));
  return picked.length ? picked : [...visibleSectorIds];
}

module.exports = {
  DEFAULT_PROFILE,
  RESERVED_USERNAMES,
  normalizeUsername,
  validateUsername,
  getById,
  getByUsername,
  getAdmin,
  list,
  create,
  updatePassword,
  rename,
  setProfile,
  setEnabled,
  remove,
  resolveAllowedSectors,
};
