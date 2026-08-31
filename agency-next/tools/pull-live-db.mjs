/**
 * Copy the live database down to this laptop, one way only.
 *
 * Reads from live, writes to local, and there is no switch to make it go the
 * other way. That is the whole design: the local database holds five demo
 * clients and no work at all, and pushing that at production would take the
 * agency's clients, tasks, invoices, ads and WhatsApp history with it. A
 * script that *could* do that is a script somebody eventually runs at 1am.
 *
 * Credentials come from `tools/live.env`, which is git-ignored and never
 * leaves this machine. Copy `tools/live.env.example` over it and fill in the
 * five values from Vercel → Settings → Environment Variables → Production.
 *
 *     node tools/pull-live-db.mjs            # ask before replacing local
 *     node tools/pull-live-db.mjs --yes      # don't ask
 *     node tools/pull-live-db.mjs --dump-only
 *
 * Needs `mysqldump` and `mysql` on PATH — they ship with MySQL Server, which
 * is already installed here.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DUMP = join(here, "live-dump.sql");

const args = new Set(process.argv.slice(2));
const skipPrompt = args.has("--yes") || args.has("-y");
const dumpOnly = args.has("--dump-only");

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

/** A .env file, parsed just enough. Values may be quoted. */
function readEnv(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const live = readEnv(join(here, "live.env"));
if (!live) {
  die(
    "tools/live.env is missing.\n" +
      "  Copy tools/live.env.example to tools/live.env and fill in the five\n" +
      "  values from Vercel → Settings → Environment Variables → Production."
  );
}

const need = ["LIVE_DB_HOST", "LIVE_DB_USER", "LIVE_DB_PASSWORD", "LIVE_DB_NAME"];
const missing = need.filter((k) => !live[k]);
if (missing.length) die(`tools/live.env is missing: ${missing.join(", ")}`);

const local = readEnv(join(root, ".env.local")) ?? {};
const localDb = {
  host: local.DB_HOST || "localhost",
  port: local.DB_PORT || "3306",
  user: local.DB_USER || "root",
  password: local.DB_PASSWORD || "",
  name: local.DB_NAME || "agency_erp",
};

/*
 * The guard that matters.
 *
 * If the local settings and the live ones point at the same server and
 * database, then "restore into local" is "restore into live" — the same
 * dump, read back over the top of the rows it came from, with whatever
 * happened in between thrown away. Refuse rather than explain.
 */
const sameHost = String(localDb.host).toLowerCase() === String(live.LIVE_DB_HOST).toLowerCase();
if (sameHost && localDb.name === live.LIVE_DB_NAME) {
  die(
    "Local and live point at the same database.\n" +
      "  This would restore the live database over itself. Check DB_HOST and\n" +
      "  DB_NAME in .env.local — they should be your laptop's, not Vercel's."
  );
}

/** Run a command, inheriting stdio, and resolve only on a clean exit. */
function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], ...opts });
    if (opts.toFile) p.stdout.pipe(opts.toFile);
    else p.stdout.pipe(process.stdout);
    p.on("error", (e) =>
      reject(
        e.code === "ENOENT"
          ? new Error(`${cmd} is not on PATH. It ships with MySQL Server — add its bin folder.`)
          : e
      )
    );
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))
    );
  });
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

console.log(`\nLive : ${live.LIVE_DB_USER}@${live.LIVE_DB_HOST}/${live.LIVE_DB_NAME}`);
console.log(`Local: ${localDb.user}@${localDb.host}/${localDb.name}\n`);

/* ------------------------------ 1. dump ------------------------------ */
console.log("→ Reading the live database…");
mkdirSync(here, { recursive: true });
const { createWriteStream } = await import("node:fs");
const file = createWriteStream(DUMP);

await run(
  "mysqldump",
  [
    `--host=${live.LIVE_DB_HOST}`,
    `--port=${live.LIVE_DB_PORT || "3306"}`,
    `--user=${live.LIVE_DB_USER}`,
    // Passed through the environment, so it never appears in the process list
    // where any other user on this machine could read it.
    "--single-transaction",
    "--quick",
    "--routines",
    "--events",
    "--set-gtid-purged=OFF",
    "--column-statistics=0",
    "--add-drop-table",
    live.LIVE_DB_NAME,
  ],
  { toFile: file, env: { ...process.env, MYSQL_PWD: live.LIVE_DB_PASSWORD } }
).catch(async (err) => {
  // `--column-statistics` and `--set-gtid-purged` are MySQL-8-isms that some
  // servers reject outright. Worth one plain retry before giving up.
  console.warn(`  (${err.message}) — retrying without the optional flags…`);
  const retry = createWriteStream(DUMP);
  await run(
    "mysqldump",
    [
      `--host=${live.LIVE_DB_HOST}`,
      `--port=${live.LIVE_DB_PORT || "3306"}`,
      `--user=${live.LIVE_DB_USER}`,
      "--single-transaction",
      "--quick",
      "--add-drop-table",
      live.LIVE_DB_NAME,
    ],
    { toFile: retry, env: { ...process.env, MYSQL_PWD: live.LIVE_DB_PASSWORD } }
  );
});

await new Promise((r) => file.end(r));
const size = statSync(DUMP).size;
if (size < 1024) die(`The dump is only ${size} bytes — nothing came back. Check the credentials.`);
console.log(`✓ ${mb(size)} written to tools/live-dump.sql\n`);

if (dumpOnly) {
  console.log("--dump-only: stopping here. Nothing local has changed.");
  process.exit(0);
}

/* ---------------------------- 2. confirm ---------------------------- */
if (!skipPrompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This replaces everything in your LOCAL "${localDb.name}". Type yes to go on: `
  );
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("\nStopped. The dump is kept at tools/live-dump.sql.");
    process.exit(0);
  }
}

/* ---------------------------- 3. restore ---------------------------- */
console.log("\n→ Loading it into the local database…");

// `mysql` takes the script on stdin, so the dump is piped in rather than
// passed as an argument — a 200MB command line is not a thing.
const { createReadStream } = await import("node:fs");
await new Promise((resolve, reject) => {
  const p = spawn(
    "mysql",
    [
      `--host=${localDb.host}`,
      `--port=${localDb.port}`,
      `--user=${localDb.user}`,
      localDb.name,
    ],
    { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, MYSQL_PWD: localDb.password } }
  );
  p.on("error", (e) =>
    reject(
      e.code === "ENOENT"
        ? new Error("mysql is not on PATH. It ships with MySQL Server — add its bin folder.")
        : e
    )
  );
  p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`mysql exited with ${c}`))));
  createReadStream(DUMP).pipe(p.stdin);
});

console.log("\n✓ Local now matches live.");
console.log("  The dump is still at tools/live-dump.sql — delete it when you are done;");
console.log("  it holds every client, invoice and message in plain text.\n");
