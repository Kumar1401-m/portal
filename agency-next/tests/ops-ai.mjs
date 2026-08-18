/**
 * Lead scoring, assignment and deadline risk.
 *
 * All three are numbers about people's work that other people will argue with,
 * so all three are computed rather than generated — and what is tested is that
 * every one of them can be taken apart: the score equals the sum of its stated
 * reasons, the assignment names its workings, and the risk says what it is
 * made of. A number nobody can interrogate is a number nobody uses twice.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const score = await load("lib/lead-score.ts");
const team = await load("lib/team-ai.ts");
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const TODAY = "2026-08-18";
const lead = (o = {}) => ({
  id: o.id ?? 1,
  name: "ZZ Lead",
  company: null,
  phone: o.phone ?? "0000",
  email: o.email ?? null,
  source: o.source ?? "manual",
  stage: o.stage ?? "new",
  value: o.value ?? 0,
  owner_user_id: null,
  owner_name: null,
  next_follow_up: o.next_follow_up ?? null,
  note: o.note ?? null,
  lost_reason: o.lost_reason ?? null,
  client_id: null,
  created_at: o.created_at ?? TODAY,
  updated_at: o.updated_at ?? TODAY,
});

/* ---------------- the score is the sum of its reasons ---------------- */
{
  const s = score.scoreLead(
    lead({ stage: "proposal", source: "referral", email: "a@b.c", value: 25000, next_follow_up: "2026-08-20" }),
    TODAY
  );
  assert.equal(
    s.score,
    score.BASE + s.reasons.reduce((t, r) => t + r.delta, 0),
    "every point is accounted for by a listed reason"
  );
  assert.equal(s.band, "hot");
  assert.ok(s.reasons.some((r) => /proposal/i.test(r.label)));
  assert.ok(s.reasons.some((r) => /referral/i.test(r.label)));
  assert.ok(s.summary, "and it says the headline in one line");

  // Worst possible open lead: new, from ads, silent for two months, no date.
  const cold = score.scoreLead(
    lead({ stage: "new", source: "ads", updated_at: "2026-06-01", created_at: "2026-06-01" }),
    TODAY
  );
  assert.equal(cold.band, "cold");
  assert.ok(cold.score < s.score, "and it ranks below the warm one");
  assert.ok(cold.score >= 0, "never below zero");
  ok("the score equals its stated reasons, and the bands come out the right way round");
}

/* ---------------- closed leads are decided, not scored ---------------- */
{
  // A "72% hot" badge on a signed client is noise; on a lost one it is an
  // invitation to keep working something that is over.
  const won = score.scoreLead(lead({ stage: "won" }), TODAY);
  assert.equal(won.score, 100);
  assert.deepEqual(won.reasons, [], "nothing to explain about a signature");
  assert.equal(won.summary, "Signed.");

  const lost = score.scoreLead(lead({ stage: "lost", lost_reason: "went with a cheaper agency" }), TODAY);
  assert.equal(lost.score, 0);
  assert.match(lost.summary, /cheaper agency/, "the reason it was lost is the summary");
  ok("won and lost are answers, not scores");
}

/* ---------------- the clock is handed in, never read ---------------- */
{
  // Same lead, two different "todays". If this function read a clock of its
  // own, the app and this Indian-time database would disagree by 5h30m.
  const l = lead({ updated_at: "2026-08-01", created_at: "2026-08-01" });
  const early = score.scoreLead(l, "2026-08-10");
  const late = score.scoreLead(l, "2026-09-10");
  assert.ok(late.score < early.score, "a lead goes cold as the day passed in moves");

  const src = read("lib/lead-score.ts");
  assert.ok(!/new Date\(\)|Date\.now/.test(src), "lead-score reads no clock of its own");
  assert.ok(!/callJSON|fetch\(/.test(src), "and asks no model");
  ok("going cold is measured against the day handed in, by rules only");
}

/* ---------------- assignment ranks on load, then on pace ---------------- */
{
  const member = (o) => ({
    id: o.id,
    name: o.name,
    role: "video_editor",
    capacityPerDay: o.capacityPerDay ?? 2,
    open: o.open ?? 0,
    overdue: o.overdue ?? 0,
    daysOfWork: o.daysOfWork ?? null,
    typicalDays: o.typicalDays ?? null,
    sample: o.sample ?? 0,
  });

  const free = member({ id: 1, name: "Free", open: 1, daysOfWork: 0.5, typicalDays: 3, sample: 8 });
  const fastButBuried = member({ id: 2, name: "Buried", open: 20, daysOfWork: 10, typicalDays: 1, sample: 9 });
  const ranked = team.rankAssignees([free, fastButBuried], "video_editor");

  // The faster person is the wrong answer when they cannot start for ten days.
  assert.equal(ranked[0].member.name, "Free", "headroom outranks raw speed");
  assert.ok(ranked[0].reasons.length >= 2, "and it shows its workings");
  assert.ok(ranked[0].reasons.some((r) => /open|Nothing open/i.test(r)));

  // Somebody already missing dates is pushed down whatever their average says.
  const slipping = member({ id: 3, name: "Slipping", open: 1, daysOfWork: 0.5, typicalDays: 1, sample: 9, overdue: 4 });
  const withSlipping = team.rankAssignees([free, slipping], "video_editor");
  assert.equal(withSlipping[0].member.name, "Free", "overdue work outweighs a good average");
  assert.ok(withSlipping[1].reasons.some((r) => /overdue/i.test(r)));

  // Nobody is penalised for a capacity an admin never set.
  const unrated = member({ id: 4, name: "Unrated", open: 2, daysOfWork: null, typicalDays: null });
  const mixed = team.rankAssignees([unrated], "video_editor");
  assert.ok(mixed[0].reasons.some((r) => /no daily target/i.test(r)), "said plainly, not scored as zero");

  // Only the right trade is offered.
  assert.equal(team.rankAssignees([free], "poster_designer").length, 0);
  ok("the freest suitable person wins, and every ranking shows why");
}

/* ---------------- deadline risk, and what it refuses to guess ---------------- */
{
  const m = {
    id: 1, name: "Editor", role: "video_editor", capacityPerDay: 2,
    open: 4, overdue: 0, daysOfWork: 2, typicalDays: 2, sample: 10,
  };

  const past = team.deadlineRisk({ dueDate: "2026-08-15", today: TODAY, assignee: m, aheadInQueue: 0 });
  assert.equal(past.risk, 100);
  assert.equal(past.band, "overdue");
  assert.match(past.reasons[0], /3 days ago/, "it says how late, not that it might be late");

  const roomy = team.deadlineRisk({ dueDate: "2026-09-30", today: TODAY, assignee: m, aheadInQueue: 0 });
  assert.equal(roomy.band, "safe");

  const crowded = team.deadlineRisk({ dueDate: "2026-08-19", today: TODAY, assignee: m, aheadInQueue: 8 });
  assert.ok(crowded.risk > roomy.risk, "a queue in front of it raises the risk");
  assert.ok(crowded.reasons.some((r) => /ahead of it/i.test(r)), "and says how much is in front");
  assert.ok(crowded.recommendation.length > 10, "with something to do about it");

  // No date is not a prediction, it is a missing decision.
  const undated = team.deadlineRisk({ dueDate: null, today: TODAY, assignee: m, aheadInQueue: 0 });
  assert.equal(undated.risk, 0);
  assert.match(undated.recommendation, /Give it a date/i);

  // Nobody assigned is a real risk, and the fix is not "work faster".
  const unassigned = team.deadlineRisk({ dueDate: "2026-08-20", today: TODAY, assignee: null, aheadInQueue: 0 });
  assert.equal(unassigned.band, "likely_late");
  assert.match(unassigned.recommendation, /Assign it/i);

  assert.ok(past.risk <= 100 && crowded.risk <= 95, "risk never claims certainty about the future");
  ok("deadline risk is days against queue and pace, and says what it is made of");
}

/* ---------------- none of it learns anything about people ---------------- */
{
  // An assignment engine that reads anything but the work learns the team's
  // existing biases and then enforces them at speed.
  const src = read("lib/team-ai.ts");
  // Whole words — "age" as a substring lives inside "average" and "manage",
  // and a test that fails on those is a test somebody deletes.
  for (const forbidden of ["gender", "age", "religion", "caste", "nationality", "photo", "avatar"]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}s?\\b`, "i").test(src),
      `nothing about ${forbidden} enters the ranking`
    );
  }
  assert.ok(!/callJSON|generateContent/.test(src), "and no model ranks a colleague");
  // The columns it does read, named so a reviewer can check the claim.
  assert.match(src, /daily_target/);
  assert.match(src, /assigned_to/);
  ok("only workload, capacity and past turnaround decide an assignment");
}

/* ---------------- the revision splitter only ever splits ---------------- */
{
  const src = read("lib/revision-tasks.ts");
  assert.match(src, /Never add a job they did not ask for/i, "the prompt forbids invention");
  assert.match(src, /use the client's own words/i);
  // Applied by a person, never automatically — this is the one place a model
  // interprets rather than counts.
  const actions = read("app/(app)/deliverables/[id]/revision-actions.ts");
  assert.match(actions, /Proposed, never applied/i);
  assert.ok(!/saveItems\(/.test(actions.split("splitFeedbackAction")[1].split("export")[0] ?? ""),
    "splitting does not write anything");
  // A role the portal does not have must not reach the database.
  assert.match(src, /ASSIGNABLE_ROLES\.includes/, "only real roles survive");
  assert.match(src, /return items\.length \? items : null/, "and nothing usable means nothing");
  ok("feedback is split, never invented, and never applied without a person");
}

await finish(pass);
