const mysql = require("mysql2/promise");

let pool = null;

function parseDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    // 库名含连字符，只放在 database 字段，任何 SQL 不拼库名
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
}

function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("缺少 DATABASE_URL 环境变量");
  }
  const config = parseDatabaseUrl(process.env.DATABASE_URL);
  pool = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 15000,
    charset: "utf8mb4",
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    timezone: "Z",
    namedPlaceholders: false,
    supportBigNumbers: true,
  });
  // 腾讯云 TXSQL 设置了 character_set_client_handshake=OFF，会忽略握手字符集强制 latin1，
  // 必须在每个新连接上显式 SET NAMES（命令在连接内部排队，先于后续业务查询执行）。
  // 会话时区固定 UTC：应用侧统一写 UTC 字符串，让 NOW()/CURDATE() 与之同钟，
  // 否则服务器默认 +8 会导致僵尸锁判断、时间窗筛选出现 8 小时偏差。
  pool.on("connection", (conn) => {
    conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
    conn.query("SET time_zone = '+00:00'");
  });
  return pool;
}

const RETRYABLE = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
]);

async function query(sql, params = []) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (error) {
    if (RETRYABLE.has(error.code)) {
      const [rows] = await pool.query(sql, params);
      return rows;
    }
    throw error;
  }
}

/** 事务执行：fn 收到一个绑定单连接的 q(sql, params) */
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const q = async (sql, params = []) => {
      const [rows] = await conn.query(sql, params);
      return rows;
    };
    const result = await fn(q);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch (_) {
      /* 回滚失败忽略 */
    }
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { createPool, query, transaction, parseDatabaseUrl };
