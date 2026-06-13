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

// 无状态 token："<expiresAtMs>.<hmac>"，HMAC 密钥 = tokenSecret + passwordHash，
// 因此修改密码后所有旧 token 自动失效。
async function tokenKey() {
  const secret = await settings.get("admin.tokenSecret", "");
  const passwordHash = await settings.get("admin.passwordHash", "");
  return `${secret}|${passwordHash}`;
}

async function issueToken() {
  const ttlHours = Number(await settings.get("admin.sessionTtlHours", 72)) || 72;
  const expiresAt = Date.now() + ttlHours * 3600 * 1000;
  const hmac = crypto.createHmac("sha256", await tokenKey()).update(String(expiresAt)).digest("hex");
  return { token: `${expiresAt}.${hmac}`, expiresAt };
}

async function verifyToken(token) {
  const [expiresAtRaw, hmac] = String(token || "").split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!expiresAt || !hmac || expiresAt < Date.now()) return false;
  const expected = crypto.createHmac("sha256", await tokenKey()).update(String(expiresAt)).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"));
  } catch (_) {
    return false;
  }
}

// 登录限速：同 IP 10 分钟内最多 5 次失败
const loginFailures = new Map(); // ip -> [timestamps]
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

/** Express 中间件：校验 Authorization: Bearer <token> */
async function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (await verifyToken(token)) return next();
  res.status(401).json({ ok: false, error: "未登录或登录已过期" });
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  requireAdmin,
  isLoginBlocked,
  recordLoginFailure,
  clearLoginFailures,
};
