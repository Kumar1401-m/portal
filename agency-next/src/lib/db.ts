/**
 * MySQL connection pool + query helpers (server-only).
 * Points at the existing agency_erp database. A single pool is cached on the
 * Node global so Next.js HMR / route reloads don't leak connections in dev.
 */
import "server-only";
import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
  type ResultSetHeader,
} from "mysql2/promise";
import { env } from "./env";

/** Values mysql2 accepts as bound parameters. */
type SqlParam = string | number | boolean | Date | null;

const globalForDb = globalThis as unknown as { _erpPool?: Pool };

function getPool(): Pool {
  if (!globalForDb._erpPool) {
    globalForDb._erpPool = mysql.createPool({
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
      charset: "utf8mb4_general_ci",
    });
  }
  return globalForDb._erpPool;
}

/** Run a parameterised SELECT and return typed rows. */
export async function query<T = RowDataPacket>(
  sql: string,
  params: SqlParam[] = []
): Promise<T[]> {
  const [rows] = await getPool().execute(sql, params);
  return rows as T[];
}

/** Return the first row, or null. */
export async function queryOne<T = RowDataPacket>(
  sql: string,
  params: SqlParam[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Run an INSERT/UPDATE/DELETE and return the result header. */
export async function execute(
  sql: string,
  params: SqlParam[] = []
): Promise<ResultSetHeader> {
  const [result] = await getPool().execute(sql, params);
  return result as ResultSetHeader;
}

/** Run work inside a transaction; commits on success, rolls back on throw. */
export async function transaction<T>(
  work: (conn: PoolConnection) => Promise<T>
): Promise<T> {
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

export { getPool };
export type { ResultSetHeader };
