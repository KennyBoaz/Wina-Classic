/**
 * db.js  (CommonJS build)
 *
 * One shared MySQL/MariaDB connection pool for the whole app, plus tiny
 * helpers so the rest of the code stays readable:
 *
 *   all(sql, params)   -> array of rows            (SELECT)
 *   one(sql, params)   -> first row or null        (SELECT ... LIMIT 1)
 *   run(sql, params)   -> { affectedRows, insertId } (INSERT / UPDATE / DELETE)
 *   transaction(fn)    -> runs fn(conn) inside BEGIN/COMMIT (ROLLBACK on error)
 *   ping()             -> true, or throws if the database is unreachable
 *
 * Always pass user-supplied values through the `?` placeholders in `params`
 * (never build SQL by gluing strings together) - that is what prevents SQL
 * injection.
 *
 * .env variables (cPanel prefixes database and user names with your cPanel
 * username, e.g. "myacct_wina"):
 *   DB_HOST       default "localhost"
 *   DB_PORT       default 3306
 *   DB_USER       required
 *   DB_PASSWORD   required (wrap it in double quotes in .env if it contains # or spaces)
 *   DB_NAME       required
 *   DB_POOL_SIZE  default 5 (shared hosting limits connections per account)
 */

const mysql = require("mysql2/promise");

let pool = null;

function getPool() {
  if (pool) return pool;

  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_USER || !DB_NAME) {
    throw new Error("Missing DB_USER or DB_NAME in your .env file.");
  }

  pool = mysql.createPool({
    host: DB_HOST || "localhost",
    port: Number(DB_PORT) || 3306,
    user: DB_USER,
    password: DB_PASSWORD || "",
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE) || 5,
    queueLimit: 0,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    // utf8mb4 so emoji in WhatsApp messages are stored correctly.
    charset: "utf8mb4_unicode_ci",
    // Dates are exchanged as UTC. (The schema stores UTC; the dashboard
    // converts to Africa/Kampala for display.)
    timezone: "Z",
    supportBigNumbers: true,
  });

  return pool;
}

async function all(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  const [result] = await getPool().query(sql, params);
  return result;
}

async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // ignore rollback errors, the original error matters more
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function ping() {
  await all("SELECT 1 AS ok");
  return true;
}

module.exports = { getPool, all, one, run, transaction, ping };
