/**
 * The lead pipeline.
 *
 * Two things here are easy to get wrong and impossible to notice: what counts
 * as overdue, and what the conversion rate is divided by. The first decides
 * which rows turn red, and this database's clock runs on Indian time while the
 * app writes UTC — so a date compared against `new Date()` inside the function
 * would flip five and a half hours early. The second decides a number the
 * agency judges itself on.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const l = await import(pathToFileURL(`${SRC}/lib/leads.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const lead = (o = {}) => ({
  id: o.id ?? 1,
  name: o.name ?? "ZZ Test",
  company: null,
  phone: "0000",
  email: null,
  source: o.source ?? "manual",
  stage: o.stage ?? "new",
  value: o.value ?? 0,
  owner_user_id: null,
  owner_name: null,
  next_follow_up: o.next_follow_up ?? null,
  note: null,
  lost_reason: null,
  client_id: null,
  created_at: "",
  updated_at: "",
});

/* ---------------- overdue is judged against a day handed in ---------------- */
{
  const today = "2026-08-18";
  assert.equal(l.isOverdue("2026-08-17", today), true, "yesterday is overdue");
  assert.equal(l.isOverdue("2026-08-18", today), false, "today is not overdue");
  assert.equal(l.isOverdue("2026-08-19", today), false, "tomorrow is not overdue");
  assert.equal(l.isOverdue(null, today), false, "and no date is not overdue, it is unplanned");

  // A DATETIME from the driver still compares as the day it is on.
  assert.equal(l.isOverdue("2026-08-17 00:00:00", today), true, "a datetime is cut to its date");
  assert.equal(l.isDueToday("2026-08-18 23:59:59", today), true);

  // The date must come from the caller. Reading the clock in here is what puts
  // the app and the database five and a half hours apart.
  const src = readFileSync(`${SRC}/lib/leads.ts`, "utf8");
  const fn = src.slice(src.indexOf("export function isOverdue"), src.indexOf("export type Funnel"));
  assert.ok(!/new Date\(\)|Date\.now/.test(fn), "isOverdue reads no clock of its own");
  ok("overdue is decided by the day passed in, not by whichever clock is nearest");
}

/* ---------------- the funnel, and what conversion divides by ---------------- */
{
  const today = "2026-08-18";
  const f = l.funnel(
    [
      lead({ id: 1, stage: "new", value: 10000, next_follow_up: "2026-08-01" }),   // overdue
      lead({ id: 2, stage: "proposal", value: 25000, next_follow_up: today }),     // due today
      lead({ id: 3, stage: "qualified", value: 5000 }),                            // no date
      lead({ id: 4, stage: "won", value: 30000 }),
      lead({ id: 5, stage: "won", value: 20000 }),
      lead({ id: 6, stage: "lost", value: 99000, next_follow_up: "2026-01-01" }),
    ],
    today
  );

  assert.equal(f.overdue, 1, "one open lead is past its date");
  assert.equal(f.dueToday, 1);
  // The lost one's date passed months ago and it is nobody's task — counting it
  // would put permanent red on a board people are meant to clear.
  assert.equal(f.openValue, 40000, "open value excludes won and lost");
  assert.equal(f.wonValue, 50000);

  // Two won of three closed. Against every lead ever it would read 33%, which
  // punishes an agency for having a full pipeline.
  assert.equal(Math.round(f.conversion), 67, "conversion is of what has closed");
  assert.equal(l.funnel([lead({ stage: "new" })], today).conversion, null, "nothing closed, no rate");

  assert.equal(f.stages.find((s) => s.key === "won").count, 2);
  assert.equal(f.stages.length, l.LEAD_STAGES.length, "every stage has a bucket, even empty ones");
  ok("the funnel counts what is open, what closed, and divides conversion by the closed");
}

/* ---------------- only stages and sources that exist ---------------- */
{
  assert.equal(l.isStage("proposal"), true);
  assert.equal(l.isStage("Proposal"), false, "case matters — this is a column value");
  assert.equal(l.isStage("nurturing"), false, "and an invented stage is refused, not stored");
  assert.equal(l.isSource("instagram"), true);
  assert.equal(l.isSource("carrier pigeon"), false);

  assert.equal(l.sourceLabel("walk-in"), "Walk-in");
  assert.equal(l.sourceLabel("whatsapp"), "Whatsapp");
  assert.equal(l.stageLabel("proposal"), "Proposal sent");
  // An unknown value shows itself rather than an empty cell — the row is still
  // readable when something has gone in by hand.
  assert.equal(l.stageLabel("mystery"), "mystery");

  // Won and lost are not open, or the board's "needs chasing" would never empty.
  assert.deepEqual(l.OPEN_STAGES, ["new", "contacted", "qualified", "proposal"]);
  ok("stages and sources are closed sets, and an unknown value still reads");
}

await finish(pass);
