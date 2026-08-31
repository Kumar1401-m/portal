/**
 * The shape of the spend.
 *
 * The day-by-day table has every number in it, and is the right thing to read
 * a figure off. It is the wrong thing for the question people bring to the
 * page — "is this working, and since when" — because a run of numbers has no
 * shape until it is drawn.
 *
 * What is worth testing here is not that a chart appears. It is the handful of
 * decisions that are wrong in ways nobody notices: two scales on one frame,
 * a gap wider than the mark it separates, a null drawn as a zero, and a rate
 * added up as though it were a total.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const palette = await import(pathToFileURL(`${SRC}/lib/chart-palette.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * Three measures, three frames
 * ------------------------------------------------------------------ */
{
  const src = read("app/(app)/ads/ad-charts.tsx");

  /*
   * Spend, leads and cost per lead share nothing but their x axis. On one
   * frame they would need two or three y-scales, and two y-scales is the
   * mistake that makes series appear to cross when they never met — a chart
   * that is read confidently and read wrongly.
   */
  for (const t of ["Spend, day by day", "Leads, day by day", "Cost per lead"]) {
    assert.ok(src.includes(`title="${t}"`), `${t} gets its own chart`);
  }
  assert.equal(
    (src.match(/<Columns/g) || []).length,
    3,
    "three small multiples, not one frame carrying all of it"
  );

  /*
   * Columns, not a line. These are discrete daily totals — there is no "half
   * past Tuesday" figure for a day's spend, and a line between them would
   * draw readings nobody took.
   */
  assert.ok(!/<polyline|<path d=/.test(src), "no line is drawn between discrete days");
  assert.ok(src.includes("<rect"), "the marks are columns");
  ok("one measure per frame, and columns for days that were counted whole");
}

/* ------------------------------------------------------------------ *
 * A gap is not a zero, and a rate is not a total
 * ------------------------------------------------------------------ */
{
  const src = read("app/(app)/ads/ad-charts.tsx");

  /*
   * Cost per lead is null on a day with no leads, and that is not the same
   * fact as "a lead cost nothing". A zero-height bar on the baseline reads as
   * "it happened and came to nought"; nothing at all reads as what it is, and
   * matches the dash the table already shows.
   */
  assert.ok(
    src.includes("const h = v === null || v === 0 ? 0 : Math.max(3"),
    "a day the measure does not exist for draws nothing"
  );
  assert.ok(src.includes('"no leads"'), "and the tooltip says which it was");

  /*
   * ₹40 a lead on Monday plus ₹60 on Tuesday is not ₹100 a lead. A rate is
   * averaged over the days that had one; a count or an amount is summed.
   */
  assert.ok(src.includes("const rate = title.startsWith(\"Cost\")"), "a rate is recognised");
  assert.ok(
    src.includes("? present.reduce((a, b) => a + b, 0) / present.length"),
    "and averaged rather than added up"
  );
  assert.ok(src.includes("day${present.length === 1 ? \"\" : \"s\"} with leads"),
    "saying what it was averaged over");
  ok("nulls are absences and rates are averages, both said out loud");
}

/* ------------------------------------------------------------------ *
 * The marks dominate the space between them, at any range
 * ------------------------------------------------------------------ */
{
  /*
   * The growth board uses a flat gap of 2 because it always draws twelve
   * months — 8.3 units a column, so 2 is a hairline. A range here can be four
   * weeks: 3.6 units a column, where a flat 2 leaves a 1.6-unit bar inside a
   * 2-unit space and the chart reads as stripes of background.
   *
   * The formula below mirrors the component. It is repeated rather than
   * imported because the component is `.tsx` and the harness runs plain node,
   * which strips types but does not compile JSX.
   */
  const geometry = (n) => {
    const w = 100 / n;
    const gap = Math.min(2, w * 0.3);
    return { w, gap, bar: Math.max(0.5, w - gap) };
  };

  for (const n of [2, 7, 14, 28, 31]) {
    const g = geometry(n);
    assert.ok(g.bar > g.gap, `${n} days: the bar (${g.bar.toFixed(2)}) beats the gap (${g.gap.toFixed(2)})`);
    assert.ok(g.bar + g.gap <= g.w + 0.001, `${n} days: a column stays inside its slot`);
  }

  const src = read("app/(app)/ads/ad-charts.tsx");
  assert.ok(src.includes("const gap = Math.min(2, w * 0.3);"), "which is what the component does");
  ok("a four-week range draws bars, not stripes of background");
}

/* ------------------------------------------------------------------ *
 * One day is not a shape
 * ------------------------------------------------------------------ */
{
  const src = read("app/(app)/ads/ad-charts.tsx");
  /*
   * A single column invites a reading — a trend, a direction — that one
   * measurement cannot support, and the stat cards above already say what
   * that day was.
   */
  assert.ok(src.includes("if (days.length < 2) return null;"), "fewer than two days draws nothing");
  // Oldest first: the table is newest-first because it is a log, and a chart
  // read right to left is a chart read wrongly.
  assert.ok(src.includes("a.date.localeCompare(b.date)"), "and time runs left to right");
  ok("no chart is drawn from a single day, and time runs the way it is read");
}

/* ------------------------------------------------------------------ *
 * The colours were computed, and the warning they carry is discharged
 * ------------------------------------------------------------------ */
{
  const { ADS } = palette;
  for (const k of ["spend", "leads", "costPerLead"]) {
    assert.ok(ADS[k]?.light && ADS[k]?.dark, `${k} has a step for each surface`);
  }

  /*
   * Dark mode is chosen, never an automatic flip of the light steps — its own
   * values, validated against the dark surface.
   */
  const lights = Object.values(ADS).map((h) => h.light);
  const darks = Object.values(ADS).map((h) => h.dark);
  assert.equal(new Set(lights).size, 3, "the three are told apart on a light surface");
  assert.equal(new Set(darks).size, 3, "and on a dark one");
  assert.equal(
    lights.filter((c) => darks.includes(c)).length,
    0,
    "and the dark steps are chosen rather than reused"
  );

  const src = read("app/(app)/ads/ad-charts.tsx");
  /*
   * The green fails contrast against the light surface at 2.74:1. The rule is
   * that this obligates relief — visible labels or a table view — rather than
   * being dismissable. Both are present: every chart writes its headline value
   * out, and the whole day-by-day table is on the page under them.
   */
  assert.ok(src.includes("format(headline)"), "every chart writes its value out in text");
  assert.ok(src.includes('role="img"') && src.includes("aria-label={`${title}:"),
    "and the whole series is readable without seeing it");
  assert.ok(
    read("app/(app)/ads/[id]/page.tsx").includes("<AdCharts days={days}"),
    "the charts sit on the page"
  );
  assert.ok(
    read("app/(app)/ads/[id]/page.tsx").includes(">Day by day<"),
    "above the table that carries every figure"
  );
  ok("hues that passed the validator, with the one warning they carry answered");
}

await finish(pass);
