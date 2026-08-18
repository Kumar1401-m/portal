/**
 * The automation map's one piece of judgement: is a job still alive?
 *
 * A heartbeat that cries wolf is a heartbeat nobody reads, and one that never
 * does is a job that stays stopped for a fortnight. The margin is the whole
 * feature, so it is the thing tested.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const m = await import(pathToFileURL(`${SRC}/lib/automation-map.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const NIGHTLY = 60 * 24;
const now = Date.parse("2026-08-18T06:00:00Z");
/** A run `hours` before `now`, written the way the app writes times: UTC. */
const ranHoursAgo = (hours, okFlag = 1) => ({
  job: "x",
  ran_at: new Date(now - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
  ok: okFlag,
  summary: null,
});

/* ---------------- late means missed twice, not missed once ---------------- */
{
  assert.equal(m.health(ranHoursAgo(2), NIGHTLY, now), "ok");

  // The one that matters: a nightly job looked at just after midnight has not
  // run for over 24 hours and has not failed at anything.
  assert.equal(m.health(ranHoursAgo(25), NIGHTLY, now), "ok", "25 hours is not a failure");
  assert.equal(m.health(ranHoursAgo(50), NIGHTLY, now), "ok", "nor is one clean miss");
  assert.equal(m.health(ranHoursAgo(80), NIGHTLY, now), "late", "two consecutive misses is");

  // The fast one moves on its own scale — a 15-minute job silent for an hour
  // is late even though a nightly job silent for an hour is fine.
  assert.equal(m.health(ranHoursAgo(1), 15, now), "late");
  ok("a job is overdue at three intervals, so nothing turns red for being early");
}

/* ---------------- never run, and ran but failed, are different ---------------- */
{
  assert.equal(m.health(undefined, NIGHTLY, now), "never", "no row at all");
  assert.equal(m.health({ job: "x", ran_at: "", ok: 1 }, NIGHTLY, now), "never");
  assert.equal(m.health({ job: "x", ran_at: "not a date", ok: 1 }, NIGHTLY, now), "never");

  // Ran on time and came back unhappy. Reporting that as "Running" is how a
  // job that fails every night looks healthy for a month.
  assert.equal(m.health(ranHoursAgo(2, 0), NIGHTLY, now), "failing");

  // Every state has words behind it, so the map never says it in colour alone.
  for (const state of ["ok", "late", "never", "failing"]) {
    assert.ok(m.HEALTH_TEXT[state], `${state} has a label`);
  }
  ok("never run, ran and failed, and running are three different answers");
}

/* ---------------- the map itself is wired up ---------------- */
{
  const keys = new Set(m.NODES.map((n) => n.key));
  for (const e of m.EDGES) {
    assert.ok(keys.has(e.from), `${e.from} is a real stage`);
    assert.ok(keys.has(e.to), `${e.to} is a real stage`);
    assert.ok(e.label, "and every arrow says what does the moving");
  }
  // Two of the eight steps are a person's — the map's whole point is being
  // honest about which.
  assert.ok(m.EDGES.some((e) => !e.automated), "the manual steps are marked manual");
  assert.ok(m.EDGES.some((e) => e.automated), "and the automatic ones automatic");

  // Every job named on an edge is one the panel below actually shows a
  // heartbeat for, or the arrow claims a watchdog that does not exist.
  const jobs = new Set(m.JOBS.map((j) => j.key));
  for (const e of m.EDGES.filter((x) => x.job)) {
    assert.ok(jobs.has(e.job), `${e.job} is a job with a heartbeat`);
  }
  ok("every arrow joins two real stages, and every job it names is watched");
}

await finish(pass);
