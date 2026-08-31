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
export type SqlParam = string | number | boolean | Date | null;

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
      /*
       * TLS, for a database that is not on this machine. A managed host will
       * accept the TCP connection and then close it without one, which is
       * indistinguishable from every other connection failure — so it is a
       * setting rather than something to discover from a log at midnight.
       */
      ...(env.db.ssl ? { ssl: { minVersion: "TLSv1.2" } } : {}),
      /*
       * These two matter only while the function is awake.
       *
       * A frozen serverless function runs no timers and sends no keep-alives.
       * They keep a busy request healthy and can do nothing across a freeze —
       * which is why the connection itself is destroyed after every statement
       * (see `once` below) rather than left for a sweeper that never runs.
       */
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      idleTimeout: 1_000,
      /*
       * Kept for the local case and for honesty, but do not rely on it:
       * mysql2 enforces `maxIdle` from a `setTimeout`, and a frozen function
       * has no thread to fire it. Four production attempts at this failed
       * before that was read out of the library source.
       */
      maxIdle: 0,
    });
  }
  return globalForDb._erpPool;
}

/**
 * Every connection is told what time it is.
 *
 * `NOW()` and `CURDATE()` are load-bearing across this portal — due dates,
 * "overdue", posting windows, footage slots, month keys — and every one of
 * them assumes Indian time, because the server it grew up on was on Indian
 * time. Nothing converts.
 *
 * A managed host answers in UTC. Moving to one without this would shift all of
 * it by five and a half hours, and *nothing would error*: posts would simply
 * go out at the wrong hour and tasks would look due on the wrong day. The kind
 * of break that is found weeks later by a client.
 *
 * Set per connection rather than per query, and set on the pool's own
 * `connection` event so it is queued on that connection before any query can
 * use it. On a server already running Indian time this changes nothing at all,
 * which is the point: the same behaviour wherever the database lives.
 */
function clockedPool(): Pool {
  const pool = getPool();
  if (!(pool as Pool & { _clocked?: boolean })._clocked) {
    (pool as Pool & { _clocked?: boolean })._clocked = true;
    pool.on("connection", (conn) => {
      /*
       * The callback form, deliberately.
       *
       * A promise-wrapped pool still hands the *core* connection to this
       * event, and calling it as a promise returns a Query object with no
       * `.catch` on it — which throws inside an event handler and hangs the
       * pool rather than failing. Found by hanging the pool.
       *
       * Queued on the connection before it is handed out, so no query can run
       * ahead of the clock being set.
       */
      try {
        (conn as unknown as {
          query(sql: string, cb: (err: unknown) => void): unknown;
        }).query(`SET time_zone = '${env.db.timeZone}'`, (err) => {
          if (err) console.warn("[db] could not set the session time zone:", err);
        });
      } catch (err) {
        console.warn("[db] could not set the session time zone:", err);
      }
    });
  }
  return pool;
}

/**
 * Connection-level failures, as opposed to anything the query did wrong.
 *
 * These mean the socket was already dead when the pool handed it over. A
 * syntax error, a missing column or a duplicate key is none of these and must
 * never be retried — repeating it just fails twice as slowly.
 */
const DEAD_CONNECTION = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
]);

/**
 * Whether the statement can safely be sent a second time.
 *
 * The whole question is whether it might already have run.
 *
 * `PROTOCOL_CONNECTION_LOST` is the one certainty: it means the server closed
 * an *idle* connection and the pool then handed it over, so nothing was ever
 * sent. Safe for anything, writes included.
 *
 * The rest — a reset, a broken pipe, a timeout — can happen mid-statement, so
 * an INSERT may well have committed before the wire went. Those are retried
 * for reads only. A second SELECT costs a few milliseconds; a second INSERT on
 * an invoice is a second invoice.
 */
function retriable(err: unknown, isWrite: boolean): boolean {
  const code = (err as { code?: string })?.code ?? "";
  if (!DEAD_CONNECTION.has(code)) return false;
  return isWrite ? code === "PROTOCOL_CONNECTION_LOST" : true;
}

/**
 * How many times to ask for a different connection.
 *
 * A freeze kills every idle connection at once, so one retry is not enough:
 * it simply collects the next corpse. mysql2 evicts a connection that fails
 * fatally, so each attempt draws a different one — which means the number of
 * attempts needed is the number of connections the pool may be holding, and
 * that is why `connectionLimit` is capped at four rather than ten.
 *
 * ponytail: attempts, not backoff. Waiting does not revive a closed socket,
 * and a page that hangs through a retry schedule is worse than one that says
 * it failed.
 */
const MAX_ATTEMPTS = 4;

/**
 * Try again on a dead socket, a few times, without waiting between.
 *
 * An earlier version rebuilt the whole pool on every stale connection. That
 * looked right and was worse: under load it churned pool after pool against a
 * database that has a connection limit of its own, and being over that limit
 * arrives as exactly the same error — so the "fix" fed the failure it was
 * trying to cure. Draining the bad connections out of one small pool is both
 * simpler and the thing that actually works.
 */
async function withRetry<T>(isWrite: boolean, run: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!retriable(err, isWrite)) throw err;
      last = err;
      console.warn(
        `[db] ${(err as { code?: string }).code} on attempt ${attempt}/${MAX_ATTEMPTS} — ` +
          "the pooled connection was dead; taking another."
      );
    }
  }
  /*
   * Every connection in the pool was dead, or the server is refusing new ones
   * — a connection limit reached, or the database down. Retrying past this
   * would only make a bad moment longer.
   */
  throw last;
}

/**
 * One statement, on a connection that is thrown away afterwards.
 *
 * `maxIdle: 0` was supposed to do this and cannot. mysql2 enforces it with a
 * `setTimeout` sweeper (`_removeIdleTimeoutConnections` in its pool) — and a
 * frozen serverless function runs no timers, which is the same reason
 * keep-alive and `idleTimeout` were no help. The connection goes back on the
 * free list, the sweep is scheduled, the function freezes, the timer never
 * fires, and the next request is handed a corpse. Read out of the library's
 * source after a fourth attempt at this failed in production.
 *
 * `destroy()` rather than `release()` removes the connection from the pool
 * there and then, with no timer involved. So a frozen instance really does
 * hold nothing, and a small database's connection allowance is only ever
 * spent by requests that are actually running.
 *
 * The cost is a handshake per statement — tens of milliseconds against a
 * database in the same region. Queries inside one `Promise.all` still run
 * concurrently on separate connections; what is gone is reuse *between*
 * requests, which is exactly the thing that was breaking.
 */
async function once<T>(run: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await clockedPool().getConnection();
  try {
    return await run(conn);
  } finally {
    // Never release() — that puts it back on the free list for a sweeper that
    // will not run.
    conn.destroy();
  }
}

/** Run a parameterised SELECT and return typed rows. */
export async function query<T = RowDataPacket>(
  sql: string,
  params: SqlParam[] = []
): Promise<T[]> {
  return withRetry(false, () =>
    once(async (conn) => {
      const [rows] = await conn.execute(sql, params);
      return rows as T[];
    })
  );
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
  // A write, so only the one error that proves nothing was sent is retried.
  return withRetry(true, () =>
    once(async (conn) => {
      const [result] = await conn.execute(sql, params);
      return result as ResultSetHeader;
    })
  );
}

/**
 * Run a DDL statement (ALTER TABLE, CREATE TABLE …).
 *
 * Separate from `execute` because that prepares its statement, and MySQL
 * cannot prepare DDL — an `ALTER TABLE` sent through it just fails. Takes no
 * parameters on purpose: there is nothing to bind in DDL, so the caller must
 * pass a literal from the source, never anything derived from a request.
 */
export async function executeDdl(sql: string): Promise<void> {
  await once(async (conn) => conn.query(sql));
}

/** Run work inside a transaction; commits on success, rolls back on throw. */
export async function transaction<T>(
  work: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  /*
   * Only the checkout is retried, never the work.
   *
   * Getting a dead connection out of the pool happens before anything is sent,
   * so a second attempt is safe. Once `work` has started it may have written,
   * and re-running a transaction body that half-committed is how one invoice
   * becomes two — so a failure in there is reported, not repeated.
   */
  const conn = await withRetry(false, () => clockedPool().getConnection());
  // Destroyed rather than released at the end, for the same reason as `once`.
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.destroy();
  }
}

export { getPool };
export type { ResultSetHeader };

/**
 * Does a column exist? Cached for the life of the process.
 *
 * The app and the database migrate independently — a deploy can land before
 * `database/migrate.js` has been run against that environment. Rather than
 * every query 500ing on an unknown column, features that depend on a newer
 * column check first and degrade to their pre-migration behaviour.
 */
const columnCache = new Map<string, boolean>();

export async function hasColumn(table: string, column: string): Promise<boolean> {
  const cacheKey = `${table}.${column}`;
  const cached = columnCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    );
    const exists = Number(row?.n ?? 0) > 0;
    columnCache.set(cacheKey, exists);
    return exists;
  } catch {
    return false; // Assume missing; the caller falls back safely.
  }
}

/**
 * Drop one entry from the cache. Needed after adding a column at runtime —
 * without it this process keeps reporting the column missing until it restarts.
 */
export function forgetColumn(table: string, column: string): void {
  columnCache.delete(`${table}.${column}`);
}

/**
 * Does a table exist? Same contract as `hasColumn`, and cached the same way.
 *
 * A whole feature can arrive with its own table rather than a column, and it
 * needs the same answer to the same question: the deploy is out, the migration
 * may not be, and the page should say so instead of 500ing on an unknown
 * table.
 */
const tableCache = new Map<string, boolean>();

export async function hasTable(table: string): Promise<boolean> {
  const cached = tableCache.get(table);
  if (cached !== undefined) return cached;

  try {
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?`,
      [table]
    );
    const exists = Number(row?.n ?? 0) > 0;
    tableCache.set(table, exists);
    return exists;
  } catch {
    return false; // Assume missing; the caller falls back safely.
  }
}

/** Forget one table, after creating it at runtime. */
export function forgetTable(table: string): void {
  tableCache.delete(table);
}
