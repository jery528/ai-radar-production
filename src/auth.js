const crypto = require("crypto");
const settings = require("./settings");

// 口令哈希：scrypt，格式 "scrypt:<salt hex>:<hash hex>"
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split(":");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

// 无状态 token："<userId>.<expiresAtMs>.<hmac>"。
// HMAC 密钥 = 全局 tokenSecret + 该用户口令哈希，因此：
//   - 修改某用户密码 → 只失效该用户的旧 token
//   - 轮换 tokenSecret → 失效全部 token
async function globalSecret() {
  return String(await settings.get("admin.tokenSecret", ""));
}

function signature(payload, key) {
  return crypto.createHmac("sha256", key).update(payload).digest("hex");
}

async function issueToken(user) {
  const ttlHours = Number(await settings.get("admin.sessionTtlHours", 72)) || 72;
  const expiresAt = Date.now() + ttlHours * 3600 * 1000;
  const payload = `${user.id}.${expiresAt}`;
  const key = `${await globalSecret()}|${user.passwordHash}`;
  return { token: `${payload}.${signature(payload, key)}`, expiresAt };
}

/** 校验 token，返回对应用户对象（含 profile）或 null */
async function resolveToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [userIdRaw, expiresAtRaw, hmac] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!expiresAt || expiresAt < Date.now()) return null;
  const users = require("./users"); // 延迟 require 避免循环依赖
  const user = await users.getById(Number(userIdRaw));
  if (!user || !user.isEnabled) return null;
  const key = `${await globalSecret()}|${user.passwordHash}`;
  const expected = signature(`${userIdRaw}.${expiresAtRaw}`, key);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch (_) {
    return null;
  }
  return user;
}

// 登录限速：同 IP 10 分钟内最多 5 次失败
const loginFailures = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;

function isLoginBlocked(ip) {
  const now = Date.now();
  const failures = (loginFailures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  loginFailures.set(ip, failures);
  return failures.length >= MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const failures = loginFailures.get(ip) || [];
  failures.push(Date.now());
  loginFailures.set(ip, failures);
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** 中间件：任何已登录用户，挂载 req.user */
async function requireAuth(req, res, next) {
  const user = await resolveToken(bearerToken(req));
  if (!user) return res.status(401).json({ ok: false, error: "未登录或登录已过期" });
  req.user = user;
  next();
}

/** 中间件：要求管理员（须在 requireAuth 之后） */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "需要管理员权限" });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  resolveToken,
  requireAuth,
  requireAdmin,
  isLoginBlocked,
  recordLoginFailure,
  clearLoginFailures,
};
