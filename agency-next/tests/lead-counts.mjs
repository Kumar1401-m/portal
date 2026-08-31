/**
 * The number on the leads board, past three hundred leads.
 *
 * Every figure in that header — the open pipeline, each stage chip, the won
 * value, the overdue count — was built by fetching leads and adding them up in
 * memory. `getLeads` carries a `LIMIT 300`, which is right for a list and
 * catastrophic for a total.
 *
 * The failure mode is the bad kind. It does not error and it does not read as
 * wrong: it quietly plateaus at a plausible number, on the one board whose
 * whole job is to say how much work is coming in. Ads make leads, so this was
 * a bug with a date on it rather than a theoretical one.
 *
 * So the counts are done in SQL, over every row, and this holds them there.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);
const leads = await import(pathToFileURL(`${SRC}/lib/leads.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * The list keeps its limit; the count must not have one
 * ------------------------------------------------------------------ */
{
  const src = read("lib/leads.ts");
  const fn = src.slice(src.indexOf("export async function leadFunnel"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  assert.ok(/COUNT\(\*\)/.test(body), "the funnel counts in the database");
  assert.ok(/GROUP BY l\.stage/.test(body), "grouped by stage, in one query");
  assert.ok(!/LIMIT/i.test(body), "and never limited — a COUNT does not need one");

  // The list is a list. Its limit is fine and stays.
  assert.ok(/LIMIT 300/.test(src.slice(src.indexOf("export async function getLeads"))),
    "the list itself is still capped, which is what a list is for");

  const page = read("app/(app)/leads/page.tsx");
  assert.ok(page.includes("leadFunnel({"), "the board uses the counted funnel");
  assert.ok(
    !/funnel\(all,/.test(page),
    "and no longer adds up a truncated list to make its header"
  );
  ok("the header is counted in SQL; only the list is capped");
}

/* ------------------------------------------------------------------ *
 * One definition of "open"
 * ------------------------------------------------------------------ */
{
  const src = read("lib/leads.ts");
  /*
   * The stage list was written out by hand in `leadSummary` as well as living
   * in `OPEN_STAGES`. Two copies is how a new stage ends up counted on one
   * screen and invisible on another, and the assistant reads `leadSummary`
   * while the board reads the other one — so they would have disagreed out
   * loud, to a person asking.
   */
  assert.ok(src.includes("const OPEN_LIST = OPEN_STAGES.map("), "the IN list is derived");
  assert.ok(
    !/stage IN \('new','contacted','qualified','proposal'\)/.test(src),
    "and no copy of it is written out by hand"
  );
  ok("open stages are defined once and used everywhere");
}

/* ------------------------------------------------------------------ *
 * Past the limit, with real rows
 * ------------------------------------------------------------------ */
if (!(await db.hasTable("leads"))) {
  console.log("  --  no leads table here; the read-back needs it");
} else {
  const clean = () => db.execute("DELETE FROM leads WHERE name LIKE 'ZZlead%'");
  await clean();

  /*
   * 320 — past the 300 the list stops at, and far enough past that a
   * miscount cannot be mistaken for a rounding difference.
   */
  const TOTAL = 320;
  const WON = 40;
  const values = [];
  const rows = [];
  for (let i = 0; i < TOTAL; i++) {
    const stage = i < WON ? "won" : i < WON + 20 ? "lost" : "new";
    rows.push("(?,?,?,?)");
    values.push(`ZZlead ${i}`, stage, 1000, "manual");
  }
  await db.execute(
    `INSERT INTO leads (name, stage, value, source) VALUES ${rows.join(",")}`,
    values
  );

  const f = await leads.leadFunnel();
  const byStage = Object.fromEntries(f.stages.map((s) => [s.key, s.count]));

  /*
   * The old code would have reported 300 here, because that is where its
   * fetch stopped. Every one of these is the number that was wrong.
   */
  const counted = f.stages.reduce((t, s) => t + s.count, 0);
  assert.ok(counted >= TOTAL, `every lead is counted, not the first 300 (got ${counted})`);
  assert.ok(byStage.won >= WON, `won is not truncated (got ${byStage.won})`);
  assert.ok(byStage.new >= TOTAL - WON - 20, "and neither is the open pipeline");

  // Money too — the won value is what somebody reports upwards.
  assert.ok(f.wonValue >= WON * 1000, `won value counts every won lead (got ${f.wonValue})`);

  // Conversion is won over closed, not over everything — a busy pipeline must
  // not drag the rate down for the crime of being busy.
  assert.equal(f.conversion, Math.round((byStage.won / (byStage.won + byStage.lost)) * 100));

  await clean();
  ok("320 leads are counted as 320, and the money with them");
}

await finish(pass);
