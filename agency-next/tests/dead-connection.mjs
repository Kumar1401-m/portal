/**
 * "This page couldn't load. A server error occurred."
 *
 * From the production log, on sign-in:
 *
 *     POST /login
 *     Error: Connection lost: The server closed the connection.
 *     code: 'PROTOCOL_CONNECTION_LOST', fatal: true
 *
 * A serverless function is frozen between requests, so a pooled connection
 * sits idle for minutes. MySQL closes it at `wait_timeout`; the pool never
 * notices, and hands the dead socket to the next query. Nothing about the
 * query is wrong — it simply never reaches a server.
 *
 * It takes out whole pages at random, sign-in included, which is the worst
 * place for it: somebody who cannot get in cannot report anything either.
 *
 * ## The part that needs care
 *
 * Retrying is only safe if the statement might not have run. That is a
 * different answer for reads and for writes, and getting it wrong the
 * generous way means a second invoice.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * The connection is kept alive, and retired before MySQL kills it
 * ------------------------------------------------------------------ */
{
  const src = read("lib/db.ts");

  /*
   * The connection is destroyed after every statement. That is the fix, and
   * it took four wrong ones to get here.
   *
   * `maxIdle: 0` was supposed to do it and cannot: mysql2 enforces `maxIdle`
   * from a `setTimeout` sweeper, and a frozen serverless function runs no
   * timers — the same reason keep-alive and `idleTimeout` were no help. The
   * connection goes back on the free list, the sweep is scheduled, the
   * function freezes, the timer never fires, and the next request is handed a
   * corpse. Read out of `node_modules/mysql2/lib/base/pool.js` after the
   * fourth attempt failed in production.
   *
   * `destroy()` removes it there and then, with no timer in the path.
   */
  assert.ok(src.includes("conn.destroy();"), "the connection is destroyed, not returned to a pool");
  assert.ok(
    !/conn\.release\(\)/.test(src),
    "release() is never used — that hands it to a sweeper that will not run"
  );
  assert.ok(
    /async function once<T>/.test(src),
    "and every statement goes through the one helper that does it"
  );

  /*
   * Kept, but the source has to say they are not the fix — otherwise the next
   * person reads `enableKeepAlive` and `maxIdle: 0` and concludes the problem
   * is handled. It was written that way twice, and was wrong twice.
   */
  assert.ok(src.includes("enableKeepAlive: true"), "a busy request keeps its socket warm");
  assert.ok(
    /frozen serverless function runs no timers/.test(src),
    "and the source says plainly that timers cannot help across a freeze"
  );
  assert.ok(
    /mysql2 enforces `maxIdle` from a `setTimeout`/.test(src),
    "including why maxIdle alone was never going to work"
  );
  ok("connections are destroyed rather than pooled, and the timers are not mistaken for the fix");
}

/* ------------------------------------------------------------------ *
 * A read may be retried; a write, only when nothing was sent
 * ------------------------------------------------------------------ */
{
  const src = read("lib/db.ts");

  /*
   * `PROTOCOL_CONNECTION_LOST` is the one certainty in the list: the server
   * closed an *idle* connection and the pool handed it over afterwards, so
   * the statement was never sent. Safe for anything.
   *
   * A reset, a broken pipe or a timeout can land mid-statement, so an INSERT
   * may already have committed. Reads retry on those; writes do not. A second
   * SELECT costs milliseconds. A second INSERT on an invoice is a second
   * invoice.
   */
  assert.ok(
    src.includes(`return isWrite ? code === "PROTOCOL_CONNECTION_LOST" : true;`),
    "a write is only retried when nothing can have reached the server"
  );
  assert.ok(src.includes("withRetry(false, () =>"), "reads go through the retry");
  assert.ok(src.includes("withRetry(true, () =>"), "and so do writes, under the stricter rule");

  // And nothing else is retried. A syntax error, a missing column or a
  // duplicate key is not a connection problem, and repeating it just fails
  // twice as slowly.
  assert.ok(
    src.includes("if (!DEAD_CONNECTION.has(code)) return false;"),
    "only connection-level failures qualify"
  );
  for (const notConnection of ["ER_PARSE_ERROR", "ER_BAD_FIELD_ERROR", "ER_DUP_ENTRY"]) {
    assert.ok(!src.includes(notConnection), `${notConnection} is not treated as retriable`);
  }
  ok("only a dead socket is retried, and a write only when it cannot have run");
}

/* ------------------------------------------------------------------ *
 * Once, not for ever
 * ------------------------------------------------------------------ */
{
  const src = read("lib/db.ts");
  const fn = src.slice(src.indexOf("async function withRetry"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  /*
   * One retry, no backoff, no loop. The failure this exists for is a stale
   * socket, which is fixed by getting a different one rather than by waiting —
   * and if the second attempt fails too, the database really is unreachable
   * and the caller should hear about it rather than watch a page hang.
   */
  /*
   * Enough attempts to drain the pool, and no more.
   *
   * One retry was not enough and the production log proved it: a freeze kills
   * every idle connection at once, so the second attempt collected the second
   * corpse and sign-in failed anyway. mysql2 evicts a connection that fails
   * fatally, so each attempt draws a different one — which makes the number of
   * attempts needed the size of the pool, and that is why the limit is capped.
   */
  const attempts = Number((src.match(/MAX_ATTEMPTS\s*=\s*(\d+)/) || [])[1] || 0);
  const limitCap = Number((read("lib/env.ts").match(/Math\.min\((\d+),/) || [])[1] || 0);
  assert.ok(attempts >= 2, `more than one attempt (${attempts})`);
  assert.ok(
    attempts >= limitCap,
    `enough attempts to outlast a full pool (${attempts} attempts, limit capped at ${limitCap})`
  );

  /*
   * And the pool is NOT rebuilt on every stale connection. That was the second
   * wrong turn: under load it churned pool after pool against a database with
   * a connection limit of its own — and being over that limit arrives as the
   * very same error, so the fix fed the failure.
   */
  assert.ok(!src.includes("discardPool"), "the pool is drained, not churned");

  assert.ok(!/setTimeout|sleep|delay/i.test(body), "no backoff to hang a page with");
  assert.ok(body.includes("throw last"), "and the real error survives to the caller");
  assert.ok(body.includes("console.warn"), "with each attempt said out loud rather than hidden");
  ok("a few attempts, no backoff — a dead socket is fixed by a different one, not by waiting");
}

/* ------------------------------------------------------------------ *
 * And it still runs queries
 * ------------------------------------------------------------------ */
{
  /*
   * A transaction's checkout is retried too — getting a connection out of the
   * pool happens before anything is sent, so a second attempt is safe. The
   * work inside is not: re-running a body that half-committed is how one
   * invoice becomes two.
   */
  const src2 = read("lib/db.ts");
  assert.ok(
    src2.includes("await withRetry(false, () => clockedPool().getConnection())"),
    "a transaction's checkout survives a stale pool"
  );
  assert.ok(!/withRetry\([^)]*work\(/.test(src2), "but the transaction body is never re-run");

  const row = await db.queryOne("SELECT 1 AS n").catch(() => null);
  if (row) {
    assert.equal(Number(row.n), 1, "a plain read works");

    // A real error still surfaces rather than being retried into silence.
    let threw = null;
    await db.query("SELECT * FROM zz_no_such_table_here").catch((e) => { threw = e; });
    assert.ok(threw, "a broken query still throws");
    assert.ok(!/PROTOCOL_CONNECTION_LOST/.test(String(threw?.code)), "and not as a connection error");
    ok("reads still work, and a genuine error is still an error");
  } else {
    console.log("  --  no database here; the live checks need one");
  }
}

await finish(pass);
