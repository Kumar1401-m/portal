/**
 * What time the database thinks it is.
 *
 * `NOW()` and `CURDATE()` are load-bearing right across this portal — due
 * dates, "overdue", the posting windows, the footage slots at 10:00 / 13:30 /
 * 18:00, the 12-hour chase and the 24-hour auto-approve, `month_key`. Every
 * one of them assumes **Indian time**, because the server this grew up on was
 * on Indian time. Nothing converts; it is simply assumed.
 *
 * That assumption was never written down anywhere and never enforced. It held
 * because of where the machine happened to be.
 *
 * ## Why it matters now
 *
 * A managed host answers in UTC. Moving to one — TiDB, PlanetScale, anything
 * — without pinning this shifts all of the above by five and a half hours, and
 * **nothing errors**. Posts go out at the wrong hour. Tasks look due on the
 * wrong day. Footage is chased at half past four in the morning. It is the
 * kind of break a client finds weeks later, not a stack trace.
 *
 * So the clock is set on every connection, and this holds it there.
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
 * It is set, not inherited
 * ------------------------------------------------------------------ */
{
  const src = read("lib/db.ts");
  assert.ok(src.includes(`pool.on("connection"`), "every new connection is told the time");
  assert.ok(src.includes("SET time_zone = "), "explicitly, with a SET");

  /*
   * The callback form, and there is a scar behind that.
   *
   * A promise-wrapped pool still hands the *core* connection to this event.
   * Called as a promise it returns a Query object, which has no `.catch` — so
   * the handler throws, inside an event, and the pool hangs instead of
   * failing. That is exactly what happened.
   */
  assert.ok(
    /query\(`SET time_zone[\s\S]{0,80}\(err\) =>/.test(src),
    "using the callback form, because the promise form hangs the pool"
  );
  assert.ok(/try \{[\s\S]{0,400}SET time_zone/.test(src), "and a throw there cannot take the pool with it");

  const env = read("lib/env.ts");
  assert.ok(env.includes(`process.env.DB_TIME_ZONE || "+05:30"`), "Indian time unless told otherwise");
  ok("the session clock is set on every connection rather than inherited from the host");
}

/* ------------------------------------------------------------------ *
 * And it really is Indian time
 * ------------------------------------------------------------------ */
{
  const row = await db
    .queryOne("SELECT @@session.time_zone AS tz, NOW() AS n, UTC_TIMESTAMP() AS u")
    .catch(() => null);

  if (!row) {
    console.log("  --  no database here; the live check needs one");
  } else {
    assert.equal(String(row.tz), "+05:30", "the session says so");

    /*
     * And the numbers agree with it. Asking the setting is not the same as
     * asking the clock — a host can accept the SET and answer in UTC anyway,
     * which is the failure this is really guarding.
     */
    const at = (v) => new Date(String(v).replace(" ", "T") + "Z").getTime();
    const gapHours = (at(row.n) - at(row.u)) / 3_600_000;
    assert.ok(
      Math.abs(gapHours - 5.5) < 0.02,
      `NOW() is five and a half hours ahead of UTC (got ${gapHours})`
    );
    ok("NOW() is Indian time, whatever the host underneath is set to");
  }
}

/* ------------------------------------------------------------------ *
 * TLS is a setting, not a discovery
 * ------------------------------------------------------------------ */
{
  const env = read("lib/env.ts");
  const src = read("lib/db.ts");
  assert.ok(env.includes("DB_SSL"), "TLS can be turned on for a hosted database");
  assert.ok(src.includes(`ssl: { minVersion: "TLSv1.2" }`), "and it is real TLS when it is");

  /*
   * A managed host accepts the TCP connection and then closes it without TLS,
   * which arrives as the same "connection lost" as every other failure. Left
   * to be discovered, that costs an evening; as a setting it costs a line.
   */
  assert.ok(!/rejectUnauthorized:\s*false/.test(src), "and certificates are not waved through");
  ok("TLS is configured deliberately rather than found out from a log");
}

await finish(pass);
