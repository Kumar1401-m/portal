/**
 * The Marketing Brain's arithmetic.
 *
 * Everything a client eventually hears starts here, and the model never
 * touches any of it — it is handed these findings as fact and asked only to
 * word them. So the failure that matters is not a crash, it is a confident
 * wrong diagnosis: telling an agency their content got worse when they simply
 * published half as much, or turning three posts into a trend.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const brain = await import(pathToFileURL(`${SRC}/lib/brain.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const slice = (month, o = {}) => ({
  month,
  posts: o.posts ?? 10,
  reach: o.reach ?? 10000,
  interactions: o.interactions ?? 500,
  rate: o.rate ?? 5,
  formats: o.formats ?? [],
  followers: o.followers ?? null,
  followerGain: o.followerGain ?? null,
  planned: o.planned ?? 10,
  delivered: o.delivered ?? 10,
  adSpend: o.adSpend ?? 0,
  adLeads: o.adLeads ?? 0,
  currency: "INR",
});

const evidence = (o = {}) => ({
  clientId: 1,
  client: "ZZ Client",
  now: o.now ?? slice("2026-08"),
  before: o.before ?? slice("2026-07"),
  stalledApprovals: o.stalledApprovals ?? [],
  overduePayments: o.overduePayments ?? [],
});

const find = (list, kind) => list.find((f) => f.kind === kind);

/* ---------------- fewer posts is not "the content got worse" ---------------- */
{
  // Reach halved. So did the number of posts — reach per post is unchanged.
  // The wrong answer here is a creative diagnosis; the right one is production.
  const list = brain.findings(
    evidence({
      now: slice("2026-08", { posts: 5, reach: 5000 }),
      before: slice("2026-07", { posts: 10, reach: 10000 }),
    })
  );
  const reach = find(list, "reach_change");
  assert.ok(reach, "a 50% drop is reported");
  assert.equal(reach.severity, "critical");
  assert.match(reach.reason, /production shortfall/i, "blamed on output, not on the content");
  assert.match(reach.recommendation, /output/i);
  assert.ok(
    reach.evidence.some((e) => /average reach per post/i.test(e)),
    "and per-post reach is shown, which is what rules the other explanation out"
  );

  // Same drop, output held. Now it really is the content.
  const held = brain.findings(
    evidence({
      now: slice("2026-08", { posts: 10, reach: 5000 }),
      before: slice("2026-07", { posts: 10, reach: 10000 }),
    })
  );
  assert.match(find(held, "reach_change").reason, /content itself/i, "output held, so it is the content");
  ok("a drop caused by posting less is not diagnosed as a content problem");
}

/* ---------------- three posts is not a trend ---------------- */
{
  // A 60% swing on two posts against one. True, and meaningless.
  const list = brain.findings(
    evidence({
      now: slice("2026-08", { posts: 2, reach: 400, planned: 2, delivered: 2 }),
      before: slice("2026-07", { posts: 1, reach: 1000, planned: 1, delivered: 1 }),
    })
  );
  assert.equal(find(list, "reach_change"), undefined, "no trend is claimed from almost no history");

  // A small move on plenty of history is also left alone — the threshold is
  // there so the board carries things worth acting on, not everything true.
  const quiet = brain.findings(
    evidence({
      now: slice("2026-08", { posts: 12, reach: 10400 }),
      before: slice("2026-07", { posts: 12, reach: 10000 }),
    })
  );
  assert.equal(find(quiet, "reach_change"), undefined, "a 4% move is not news");
  ok("a swing needs both enough history and enough size before it is reported");
}

/* ---------------- confidence tracks evidence, and gates the finding ---------------- */
{
  const thin = brain.findings(
    evidence({
      now: slice("2026-08", { posts: 3, reach: 3000 }),
      before: slice("2026-07", { posts: 3, reach: 6000 }),
    })
  );
  const thick = brain.findings(
    evidence({
      now: slice("2026-08", { posts: 30, reach: 30000 }),
      before: slice("2026-07", { posts: 30, reach: 60000 }),
    })
  );
  const a = find(thin, "reach_change");
  const b = find(thick, "reach_change");
  assert.ok(a && b);
  assert.ok(b.confidence > a.confidence, "more posts behind the same drop means more confidence");
  assert.ok(b.confidence <= 95, "and it never claims certainty");

  for (const f of [...thin, ...thick]) {
    assert.ok(f.confidence >= 50, "nothing below 50% reaches the board at all");
    assert.ok(f.evidence.length > 0, `${f.kind} shows the figures it rests on`);
    assert.ok(f.recommendation, `${f.kind} says what to do`);
  }

  // Confidence is computed here, never asked of a model — a model's stated
  // confidence is a sentence, not a measurement.
  const src = readFileSync(`${SRC}/lib/brain.ts`, "utf8");
  const fn = src.slice(src.indexOf("function confidenceFrom"), src.indexOf("export function findings"));
  assert.ok(!/callJSON|fetch|await/.test(fn), "confidenceFrom asks nobody");
  const findingsFn = src.slice(src.indexOf("export function findings"), src.indexOf("/* ------------------------------ Answering"));
  assert.ok(!/callJSON|fetch/.test(findingsFn), "and no finding is generated by a model");
  ok("confidence comes from the evidence, and no model is anywhere near the numbers");
}

/* ---------------- ordering: most serious first ---------------- */
{
  const list = brain.findings(
    evidence({
      now: slice("2026-08", { posts: 10, reach: 12000, planned: 10, delivered: 10 }),
      before: slice("2026-07", { posts: 10, reach: 10000, planned: 10, delivered: 10 }),
      stalledApprovals: [{ title: "ZZ reel", days: 9 }],
      overduePayments: [{ amount: 25000, days: 45 }],
    })
  );
  const kinds = list.map((f) => f.kind);
  assert.ok(kinds.includes("approval_stalled"));
  assert.ok(kinds.includes("payment_overdue"));
  // Reach is up, so it is "good" — and good news must not sit above an unpaid
  // invoice on a list somebody works down.
  assert.equal(list[list.length - 1].severity, "good", "the good news is last");
  assert.equal(list[0].severity, "critical");
  ok("findings are ranked by how much they matter, not by when they were found");
}

/* ---------------- the health score is its own explanation ---------------- */
{
  const clean = brain.health(evidence());
  assert.equal(clean.score, 100, "nothing wrong is a full score");
  assert.equal(clean.band, "healthy");
  assert.deepEqual(clean.reasons, [], "and nothing to explain");

  const rough = brain.health(
    evidence({
      now: slice("2026-08", { planned: 12, delivered: 4, reach: 5000, followerGain: -30 }),
      before: slice("2026-07", { posts: 10, reach: 10000 }),
      stalledApprovals: [{ title: "ZZ", days: 9 }],
      overduePayments: [{ amount: 25000, days: 60 }],
    })
  );
  assert.ok(rough.score < 50, `a client in this state is critical, got ${rough.score}`);
  assert.equal(rough.band, "critical");
  // Every point lost is accounted for. A score with no reasons is a number
  // people argue with rather than act on.
  assert.equal(
    rough.score,
    Math.max(0, 100 + rough.reasons.reduce((t, r) => t + r.delta, 0)),
    "the reasons add up to the score exactly"
  );
  assert.ok(rough.reasons[0].delta <= rough.reasons[rough.reasons.length - 1].delta, "worst first");
  // Never below zero, however bad it gets.
  assert.ok(rough.score >= 0);
  ok("the health score is the sum of its stated reasons, and never a bare number");
}

/* ---------------- the model narrates; it never calculates ---------------- */
{
  const src = readFileSync(`${SRC}/lib/brain.ts`, "utf8");
  assert.match(src, /Never invent, estimate or recompute a number/, "the prompt forbids arithmetic");
  assert.match(src, /function plainAnswer/, "and there is an answer for when no model replies");
  // The fallback is built from the findings, so an absent model costs the
  // wording and never the figures.
  assert.match(src, /plainAnswer\(evidence, list\)/);
  ok("an absent or broken model costs the wording, not the numbers");
}

await finish(pass);
