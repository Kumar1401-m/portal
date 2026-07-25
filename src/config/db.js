/**
 * MySQL connection pool + query helpers.
 * All parameterised queries go through here so SQL injection protection is
 * centralised (mysql2 prepared statements / placeholders).
 */
'use strict';

const mysql = require('mysql2/promise');
const env = require('./env');
const logger = require('../utils/logger');

let pool;

/** Lazily create and return the shared pool. */
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.database,
      waitForConnections: true,
      connectionLimit: env.db.connectionLimit,
      queueLimit: 0,
      namedPlaceholders: true,
      dateStrings: true,
      charset: 'utf8mb4_general_ci',
    });
  }
  return pool;
}

/**
 * Run a parameterised query. Accepts array (?) or named (:name) placeholders.
 * @returns rows for SELECT, result meta for INSERT/UPDATE/DELETE.
 */
async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** Convenience: return the first row (or null). */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * Run a set of statements inside a transaction.
 * @param {(conn) => Promise<any>} work callback receiving a connection whose
 *        `.query`/`.execute` participate in the transaction.
 */
async function transaction(work) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Verify DB connectivity at boot. */
async function healthCheck() {
  try {
    await query('SELECT 1');
    return true;
  } catch (err) {
    logger.error('Database health check failed:', err.message);
    return false;
  }
}

module.exports = { getPool, query, queryOne, transaction, healthCheck };
