/**
 * Move the database to another MySQL host, and prove it arrived.
 *
 * Same MySQL, somewhere more reliable. Not a rewrite: every query, every
 * table, every date function stays exactly as it is — the only thing that
 * changes afterwards is five environment variables in Vercel.
 *
 * Reads `tools/copy-db.env` (git-ignored, never leaves this machine):
 *
 *     SOURCE_DB_HOST= …   the database you have now
 *     TARGET_DB_HOST= …   the new one
 *
 * Then:
 *
 *     node tools/copy-db.mjs --dry-run   # read the source, count it, stop
 *     node tools/copy-db.mjs             # copy, then verify
 *
 * ## What it will not do
 *
 * It will not run if the target already has tables, unless `--replace` is
 * given. Copying over a database that somebody has already started using is
 * how a day's work disappears, and the mistake looks like nothing at all until
 * somebody goes looking for a row.
 *
 * ## What "verify" means
 *
 * Every table's row count on both sides, compared. A dump that half-failed
 * still ends cleanly and still says "done" — the counts are what actually
 * tell you the data is there.
 */
import { existsSync, readFileSync, createWriteStream, createReadStream, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const here = dirname(fileURLToPath(import.meta.url));
const DUMP = join(here, "copy-db-dump.sql");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const replace = args.has("--replace");
const skipPrompt = args.has("--yes") || args.has("-y");

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
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
      "  Copy tools/copy-db.env.example to tools/copy-db.env and fill it in."
  );
}

const side = (prefix) => ({
  host: cfg[`${prefix}_DB_HOST`],
  port: cfg[`${prefix}_DB_PORT`] || "3306",
  user: cfg[`${prefix}_DB_USER`],
  password: cfg[`${prefix}_DB_PASSWORD`] ?? "",
  name: cfg[`${prefix}_DB_NAME`],
});

const src = side("SOURCE");
const dst = side("TARGET");

for (const [label, s] of [["SOURCE", src], ["TARGET", dst]]) {
  for (const k of ["host", "user", "name"]) {
    if (!s[k]) die(`tools/copy-db.env is missing ${label}_DB_${k.toUpperCase()}`);
  }
}

/*
 * The guard. Same server and same database means this would dump a database
 * and restore it over itself — losing anything written in between, for no
 * reason at all.
 */
if (
  String(src.host).toLowerCase() === String(dst.host).toLowerCase() &&
  String(src.port) === String(dst.port) &&
  src.name === dst.name
) {
  die("Source and target are the same database. Nothing to do, and a real risk of losing rows.");
}

const conn = (s) =>
  mysql.createConnection({
    host: s.host,
    port: Number(s.port),
    user: s.user,
    password: s.password,
    database: s.name,
    // Managed hosts almost always want TLS and will simply close the
    // connection without it — which arrives as an unhelpful "connection lost".
    ssl: cfg.SSL === "off" ? undefined : { rejectUnauthorized: false },
  });

/** Every table and how many rows are in it. The only honest "did it work". */
async function census(s) {
  const c = await conn(s).catch((e) => die(`Cannot reach ${s.host}/${s.name}: ${e.message}`));
  const [tables] = await c.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name",
    [s.name]
  );
  const counts = {};
  for (const { t } of tables) {
    const [[row]] = await c.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    counts[t] = Number(row.n);
  }
  await c.end();
  return counts;
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], ...opts });
    if (opts.toFile) p.stdout.pipe(opts.toFile);
    else if (p.stdout) p.stdout.pipe(process.stdout);
    p.on("error", (e) =>
      reject(
        e.code === "ENOENT"
          ? new Error(`${cmd} is not on PATH. It ships with MySQL Server — add its bin folder.`)
          : e
      )
    );
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited with ${c}`))));
  });
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);

console.log(`\nFrom : ${src.user}@${src.host}:${src.port}/${src.name}`);
console.log(`To   : ${dst.user}@${dst.host}:${dst.port}/${dst.name}\n`);

/* --------------------------- 1. read the source --------------------------- */
console.log("→ Counting what is there now…");
const before = await census(src);
const tableCount = Object.keys(before).length;
if (!tableCount) die("The source database has no tables. Check SOURCE_DB_NAME.");
console.log(`  ${tableCount} tables, ${total(before).toLocaleString("en-IN")} rows\n`);

/* ------------------------ 2. is the target empty? ------------------------ */
const targetBefore = await census(dst);
const targetRows = total(targetBefore);
if (targetRows > 0 && !replace) {
  die(
    `The target already holds ${targetRows.toLocaleString("en-IN")} rows in ` +
      `${Object.keys(targetBefore).length} tables.\n` +
      "  Copying over it would destroy them. If that is really what you want,\n" +
      "  run again with --replace."
  );
}

if (dryRun) {
  console.log("--dry-run: both sides reachable, source counted, nothing written.");
  process.exit(0);
}

/* ------------------------------ 3. confirm ------------------------------ */
if (!skipPrompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(
    targetRows > 0
      ? `REPLACING ${targetRows.toLocaleString("en-IN")} rows on the target. Type yes: `
      : `Copy ${total(before).toLocaleString("en-IN")} rows to the new host? Type yes: `
  );
  rl.close();
  if (a.trim().toLowerCase() !== "yes") {
    console.log("\nStopped. Nothing was written.");
    process.exit(0);
  }
}

/* -------------------------------- 4. dump -------------------------------- */
console.log("\n→ Reading the source…");
const file = createWriteStream(DUMP);
const dumpArgs = [
  `--host=${src.host}`,
  `--port=${src.port}`,
  `--user=${src.user}`,
  "--single-transaction",
  "--quick",
  "--routines",
  "--add-drop-table",
  ...(cfg.SSL === "off" ? [] : ["--ssl-mode=REQUIRED"]),
  src.name,
];
await run("mysqldump", dumpArgs, {
  toFile: file,
  env: { ...process.env, MYSQL_PWD: src.password },
}).catch(async (err) => {
  console.warn(`  (${err.message}) — retrying without the optional flags…`);
  const retry = createWriteStream(DUMP);
  await run(
    "mysqldump",
    [
      `--host=${src.host}`,
      `--port=${src.port}`,
      `--user=${src.user}`,
      "--single-transaction",
      "--quick",
      "--add-drop-table",
      src.name,
    ],
    { toFile: retry, env: { ...process.env, MYSQL_PWD: src.password } }
  );
});
await new Promise((r) => file.end(r));

const size = statSync(DUMP).size;
if (size < 1024) die(`The dump is only ${size} bytes — nothing came back.`);
console.log(`✓ ${mb(size)}`);

/*
 * The one thing TiDB will not take.
 *
 * TiDB is MySQL on the wire and accepts essentially all of this schema. The
 * exception is FULLTEXT, which it has none of — and there is exactly one, on
 * `captions(body, hashtags, cta)`. Nothing in the portal queries it: there is
 * no `MATCH … AGAINST` anywhere in the source. So it is dropped rather than
 * left to fail the whole table.
 *
 * Named in the output rather than done quietly. An index that disappears in a
 * migration and is never mentioned is one somebody rebuilds by accident a year
 * later — or one somebody actually needed.
 */
if (cfg.STRIP_FULLTEXT !== "off") {
  const text = readFileSync(DUMP, "utf8");
  const found = (text.match(/^\s*FULLTEXT KEY /gm) || []).length;
  if (found) {
    /*
     * Two shapes, and the order matters.
     *
     * Usually the FULLTEXT line carries its own trailing comma and is followed
     * by more entries — then the whole line goes and the line before it keeps
     * its comma. Occasionally it is the last entry with no comma of its own —
     * then the *previous* line's comma has to go with it.
     *
     * Getting this wrong leaves `KEY (…)` and `CONSTRAINT …` on consecutive
     * lines with no comma between them, and MySQL reports a syntax error
     * pointing at the constraint, which is not where the problem is. Found
     * exactly that way.
     */
    const cleaned = text
      .replace(/^[ \t]*FULLTEXT KEY [^\r\n]*,[ \t]*\r?\n/gm, "")
      .replace(/,[ \t]*(\r?\n)[ \t]*FULLTEXT KEY [^\r\n]*(?=\r?\n)/g, "$1");
    writeFileSync(DUMP, cleaned);
    console.log(`  dropped ${found} FULLTEXT index${found === 1 ? "" : "es"} — TiDB has none,`);
    console.log("  and nothing in the portal queries them.");
  }
}
console.log("");

/* ------------------------------- 5. restore ------------------------------- */
console.log("→ Loading it into the new host…");
await new Promise((resolve, reject) => {
  const p = spawn(
    "mysql",
    [
      `--host=${dst.host}`,
      `--port=${dst.port}`,
      `--user=${dst.user}`,
      ...(cfg.SSL === "off" ? [] : ["--ssl-mode=REQUIRED"]),
      dst.name,
    ],
    { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, MYSQL_PWD: dst.password } }
  );
  p.on("error", reject);
  p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`mysql exited with ${c}`))));
  createReadStream(DUMP).pipe(p.stdin);
});

/* ------------------------------- 6. verify ------------------------------- */
console.log("\n→ Counting what arrived…\n");
const after = await census(dst);

const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
let bad = 0;
for (const t of names) {
  const a = before[t];
  const b = after[t];
  const same = a === b;
  if (!same) bad++;
  console.log(
    `  ${same ? "✓" : "✗"} ${t.padEnd(28)} ${String(a ?? "—").padStart(8)} → ${String(b ?? "—").padStart(8)}`
  );
}

console.log("");
if (bad) {
  die(`${bad} table${bad === 1 ? "" : "s"} did not arrive intact. Do NOT switch Vercel over yet.`);
}

console.log(`✓ All ${names.length} tables match — ${total(after).toLocaleString("en-IN")} rows.\n`);
console.log("Next, and only now:");
console.log("  1. Vercel → Settings → Environment Variables → set DB_HOST, DB_PORT,");
console.log("     DB_USER, DB_PASSWORD, DB_NAME to the new host (Production).");
console.log("  2. Redeploy — environment changes only reach a new deployment.");
console.log("  3. Keep the old database for a week before deleting anything.\n");
console.log(`The dump is at tools/copy-db-dump.sql — it holds every client and`);
console.log("invoice in plain text. Delete it when you are done.\n");
