/**
 * Is this database fit to run the portal?
 *
 * Reads credentials from `tools/copy-db.env` and reports the handful of things
 * that decide whether the portal will work against it — the ones that have
 * actually gone wrong here, not a generic health check.
 *
 *     node tools/db-check.mjs           # checks TARGET_* (the new database)
 *     node tools/db-check.mjs source    # checks SOURCE_* (the one in use now)
 *
 * Nothing is written. Safe to run against a live database.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const here = dirname(fileURLToPath(import.meta.url));
const which = (process.argv[2] || "target").toLowerCase() === "source" ? "SOURCE" : "TARGET";

const die = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

function readEnv(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const cfg = readEnv(join(here, "copy-db.env"));
if (!cfg) {
  die(
    "tools/copy-db.env is missing.\n" +
      "  Copy tools/copy-db.env.example to tools/copy-db.env and fill in the\n" +
      `  ${which}_DB_* values from Railway → your MySQL service → Variables.`
  );
}

const db = {
  host: cfg[`${which}_DB_HOST`],
  port: Number(cfg[`${which}_DB_PORT`] || 3306),
  user: cfg[`${which}_DB_USER`],
  password: cfg[`${which}_DB_PASSWORD`] ?? "",
  database: cfg[`${which}_DB_NAME`],
};
for (const k of ["host", "user", "database"]) {
  if (!db[k]) die(`tools/copy-db.env is missing ${which}_DB_${k.toUpperCase()}`);
}

console.log(`\nChecking ${which}: ${db.user}@${db.host}:${db.port}/${db.database}\n`);

/*
 * Tried twice, and which one works is itself the answer.
 *
 * A managed host that requires TLS accepts the TCP connection and then closes
 * it — which arrives as "connection lost", indistinguishable from every other
 * failure. So: with TLS first, then without. Whichever connects tells us what
 * DB_SSL has to be set to on Vercel, which is not something to guess at.
 */
const tls = { minVersion: "TLSv1.2", rejectUnauthorized: false };
const attempt = async (ssl) => {
  try {
    /*
     * `dateStrings` so NOW() comes back the way the app reads it — as text.
     * Without it mysql2 hands back a Date object, and the clock check below
     * compares an object to a string and quietly produces NaN. It did.
     */
    return await mysql.createConnection({ ...db, ssl, dateStrings: true, connectTimeout: 15_000 });
  } catch (e) {
    return e;
  }
};

const withTls = await attempt(tls);
const plain = await attempt(undefined);
const ok = (r) => !(r instanceof Error);

if (!ok(withTls) && !ok(plain)) {
  const e = plain;
  die(
    `Cannot connect either way.\n` +
      `  Last error: ${e.code || ""} ${e.message}\n\n` +
      "  ECONNREFUSED / ETIMEDOUT → wrong host or port, or the database is not\n" +
      "    exposed publicly. On Railway use the PUBLIC host, not the internal one.\n" +
      "  ER_ACCESS_DENIED_ERROR → wrong user or password.\n" +
      "  ER_BAD_DB_ERROR → that database name does not exist yet."
  );
}

const conn = ok(withTls) ? withTls : plain;
if (ok(withTls) && ok(plain)) await plain.end().catch(() => {});
const usedSsl = ok(withTls);
void usedSsl;

const one = async (sql) => (await conn.query(sql))[0][0];
const all = async (sql) => (await conn.query(sql))[0];

/*
 * Both are tried, because "TLS works" and "TLS is required" are different
 * facts and only one of them settles what Vercel must be set to. A host that
 * requires TLS closes a plain connection without a word — and that arrives as
 * the same "the server closed the connection" as everything else, which is
 * exactly the trap this exists to keep somebody out of.
 */
console.log(`TLS      ${ok(withTls) ? "works" : "refused"}`);
console.log(`No TLS   ${ok(plain) ? "works" : "refused"}`);
console.log(
  `  → Vercel: DB_SSL=${
    ok(withTls) && !ok(plain)
      ? "on   (required — a plain connection is closed)"
      : ok(withTls)
        ? "on   (both work; encrypted is the better default)"
        : "off  (this server does not offer TLS)"
  }\n`
);

/* ------------------------------ the essentials ------------------------------ */

const v = await one("SELECT VERSION() AS v");
console.log(`Version            ${v.v}`);

/*
 * The clock. Every due date, posting window and month key in this portal
 * assumes Indian time, and the app now pins the session to +05:30 — so what
 * matters is that the pin works, not what the server's own default is.
 */
await conn.query("SET time_zone = '+05:30'");
const t = await one("SELECT NOW() AS n, UTC_TIMESTAMP() AS u, @@session.time_zone AS tz");
const at = (v) => Date.parse(String(v).replace(" ", "T") + "Z");
const gap = (at(t.n) - at(t.u)) / 3_600_000;
console.log(
  `Session time zone  ${t.tz}  (NOW() is ${
    Number.isFinite(gap) ? `${gap}h` : "?"
  } ahead of UTC — 5.5 is right)`
);
if (!Number.isFinite(gap) || Math.abs(gap - 5.5) > 0.02) {
  console.log("  ⚠ The portal expects Indian time. Posting times will be wrong.");
}

/*
 * The number behind every "the server closed the connection". If this is
 * small, a handful of warm serverless instances can exhaust it on their own.
 */
const maxc = await one("SHOW VARIABLES LIKE 'max_connections'");
const used = await one("SHOW STATUS LIKE 'Threads_connected'");
const peak = await one("SHOW STATUS LIKE 'Max_used_connections'");
console.log(`\nmax_connections    ${maxc.Value}`);
console.log(`  in use now       ${used.Value}`);
console.log(`  highest ever     ${peak.Value}`);
if (Number(maxc.Value) < 40) {
  console.log("  ⚠ Tight for serverless. The portal now opens one connection per");
  console.log("    statement and closes it, which is the right shape for this.");
}

// How long a connection may sit quiet before the server hangs up. Not the
// portal's problem any more — it no longer keeps any — but worth seeing.
const wait = await one("SHOW VARIABLES LIKE 'wait_timeout'");
console.log(`  wait_timeout     ${wait.Value}s`);

/* -------------------------------- contents -------------------------------- */

const tables = await all(
  `SELECT table_name AS t, table_rows AS n
     FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
    ORDER BY table_name`
);
const size = await one(
  `SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS mb
     FROM information_schema.tables WHERE table_schema = DATABASE()`
);

console.log(`\nTables             ${tables.length}`);
console.log(`Size               ${size.mb ?? 0} MB`);

if (tables.length === 0) {
  console.log("\n  Empty — nothing has been copied in yet. Next:");
  console.log("    node tools/copy-db.mjs --dry-run");
} else {
  const rows = tables.reduce((a, r) => a + Number(r.n || 0), 0);
  console.log(`Rows (approx)      ${rows.toLocaleString("en-IN")}`);

  // 44 is what the portal expects. Fewer means a copy stopped part way.
  if (tables.length < 44) {
    console.log(`\n  ⚠ The portal has 44 tables; this has ${tables.length}.`);
    console.log("    A copy that stopped part way looks exactly like this.");
  }
}

await conn.end();
console.log("");
