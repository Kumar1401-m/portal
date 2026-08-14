/**
 * How a client's month is laid out.
 *
 * A fixed two-day gap ignored the one number that matters. Ten videos in a
 * thirty-day month came out on the 1st to the 19th and stopped; the posters,
 * added as a second run afterwards, took the 21st to the 27th. So the month
 * was front-loaded with video, tailed with poster, and empty at the end — and
 * a client on four videos had their whole month done inside a week.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;
const src = readFileSync(`${SRC}/lib/task-plan.ts`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (needle, why) => assert.ok(src.includes(needle), why);

/*
 * The two decisions, lifted out of the module so they can be run.
 *
 * They live inside `generateMonthTasks`, which needs a database and a client;
 * these are the same expressions, and the assertions below check the module
 * still contains them so the copies cannot drift silently.
 */
const DAY_MS = 86_400_000;
const asDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const day = (s) => Date.parse(`${s}T00:00:00Z`);

const slotDate = (i, total, startMs, lastMs) => {
  if (total <= 1) return asDate(Math.min(startMs, lastMs));
  const span = Math.max(0, lastMs - startMs);
  return asDate(Math.min(startMs + Math.round((i * span) / (total - 1)), lastMs));
};

const interleave = (videos, posters) => {
  const out = [];
  let v = 0;
  let p = 0;
  while (v < videos || p < posters) {
    const takeVideo = p >= posters || (v < videos && (v + 0.5) / videos <= (p + 0.5) / posters);
    if (takeVideo) { out.push("V"); v++; } else { out.push("P"); p++; }
  }
  return out;
};

const startFor = (baseMs, lastMs, afterMs, total) => {
  const tailMs = afterMs !== null ? Math.max(baseMs, afterMs + DAY_MS) : baseMs;
  const roomFor = (fromMs) => lastMs - fromMs >= Math.max(0, total - 1) * DAY_MS;
  if (total <= 1) return Math.min(tailMs, lastMs);
  return tailMs <= lastMs && roomFor(tailMs) ? tailMs : baseMs;
};

const plan = (from, to, videos, posters, after = null) => {
  const seq = interleave(videos, posters);
  const baseMs = day(from);
  const lastMs = day(to);
  const startMs = startFor(baseMs, lastMs, after ? day(after) : null, seq.length);
  return seq.map((k, i) => ({ kind: k, date: slotDate(i, seq.length, startMs, lastMs) }));
};

/* ---------------- the month is divided by what goes in it ---------------- */
{
  const ten = plan("2026-08-01", "2026-08-31", 10, 4);
  assert.equal(ten.length, 14, "everything asked for is created");
  assert.equal(ten[0].date, "2026-08-01", "the first is at the start of the window");
  assert.equal(ten.at(-1).date, "2026-08-31", "and the last on the final day");

  // Nothing bunched: the biggest gap should be near the average, not five
  // times it. Fourteen tasks over thirty days is a little over two days each.
  const gaps = ten.slice(1).map((t, i) => (day(t.date) - day(ten[i].date)) / DAY_MS);
  assert.ok(Math.max(...gaps) <= 3, `evenly spread — biggest gap ${Math.max(...gaps)} days`);
  assert.ok(Math.min(...gaps) >= 2, `and none piled up — smallest gap ${Math.min(...gaps)} days`);

  // A lighter client gets the same month, spread wider, rather than a week of
  // work and three weeks of nothing.
  const four = plan("2026-08-01", "2026-08-31", 4, 2);
  assert.equal(four.at(-1).date, "2026-08-31", "four videos still fill the month");
  const fourGaps = four.slice(1).map((t, i) => (day(t.date) - day(four[i].date)) / DAY_MS);
  assert.ok(Math.min(...fourGaps) >= 5, "spaced by count, not by a fixed two days");
  ok("the window is divided by how much goes in it");
}

/* ---------------- and posters fall between the videos ---------------- */
{
  const seq = interleave(10, 4).join("");
  assert.equal((seq.match(/V/g) || []).length, 10);
  assert.equal((seq.match(/P/g) || []).length, 4);

  // The failure being fixed: every video, then every poster.
  assert.notEqual(seq, "V".repeat(10) + "P".repeat(4), "not one kind after the other");
  assert.ok(!/PP/.test(seq), "no two posters back to back out of four in fourteen");
  // Each poster has video on both sides — which is what "in between" means.
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] !== "P") continue;
    assert.ok(i > 0 && i < seq.length - 1, `poster at ${i} is not on either end`);
  }

  // Degenerate cases must not spin or drop anything.
  assert.equal(interleave(0, 0).length, 0);
  assert.equal(interleave(5, 0).join(""), "VVVVV", "videos only");
  assert.equal(interleave(0, 3).join(""), "PPP", "posters only");
  ok("posters sit between the videos rather than after all of them");
}

/* ---------------- topping up uses what is left, not the whole month -------- */
{
  // Adding to a month already half full continues from where it stopped —
  // five more piled on the 1st would be the alternative.
  const rest = plan("2026-08-20", "2026-08-31", 4, 1);
  assert.equal(rest[0].date, "2026-08-20", "starting after what is already there");
  assert.equal(rest.at(-1).date, "2026-08-31", "and still finishing the month");
  ok("a top-up spreads across the remainder");
}

/* ---------------- and more tasks than days is answered honestly ----------- */
{
  // Forty videos in February. Two on some days is the truthful answer; the
  // old code answered it by piling twenty on the 28th.
  const feb = plan("2026-02-01", "2026-02-28", 40, 0);
  assert.equal(feb.length, 40);
  const onLastDay = feb.filter((t) => t.date === "2026-02-28").length;
  assert.ok(onLastDay <= 2, `no pile-up on the last day — ${onLastDay} there`);
  assert.equal(new Set(feb.map((t) => t.date)).size, 28, "every day of the month is used");
  ok("a month with more tasks than days spreads them, rather than stacking the end");
}

/* ---------------- and a month with no room left does not stack ---------------- */
{
  // The regression, and it appeared on the second press of the button. The old
  // two-day spacing clamped overflow onto the month’s last day, so a great
  // many months already hold a task dated the 31st — and a month generated in
  // full has one by design. Continuing after that leaves a window of nothing,
  // every new task rounds to the same date, and ten videos land on one day.
  for (const after of ["2026-08-31", "2026-08-30", "2026-08-28"]) {
    const p = plan("2026-08-01", "2026-08-31", 10, 0, after);
    const days = new Set(p.map((t) => t.date));
    assert.equal(days.size, 10, `ten tasks on ten days, not one (already ends ${after})`);
  }

  // Where there is room, the top-up still continues the month rather than
  // restarting it — which is the behaviour the fallback must not swallow.
  const roomy = plan("2026-08-01", "2026-08-31", 5, 0, "2026-08-10");
  assert.equal(roomy[0].date, "2026-08-11", "a top-up with room starts after what is there");
  assert.equal(roomy.at(-1).date, "2026-08-31");

  // One extra piece belongs at the end of the month, not back at a first that
  // has usually already passed.
  const one = plan("2026-08-01", "2026-08-31", 1, 0, "2026-08-31");
  assert.equal(one[0].date, "2026-08-31", "a single top-up lands on the last day");
  ok("a second press spreads across the month instead of piling onto one day");
}

/* ---------------- the module still contains what was tested --------------- */
{
  has("const slotDate = (i: number, total: number): string => {", "the spread is where it was");
  has("Math.round((i * span) / (total - 1))", "and computed the same way");
  has("const interleave = (videos: number, posters: number): ServiceKey[] =>", "so is the ordering");
  has("(v + 0.5) / videos <= (p + 0.5) / posters", "by whichever is furthest behind its share");
  has("const sequence = interleave(wantVideos, wantPosters);", "and one pass writes the rows");
  has("const roomFor = (fromMs: number) =>", "the fallback is where it was");
  has("tailMs <= lastMs && roomFor(tailMs)", "and chosen the same way");
  has("Math.min(tailMs, lastMs)", "with a single top-up landing at the end of the month");
  // The two-runs-sharing-a-cursor shape is what put all the videos first.
  assert.ok(
    !/await add\("video_editing"/.test(src),
    "the pass-per-kind that caused this is gone"
  );
  ok("the running code is the code these assertions describe");
}

await finish(pass);
