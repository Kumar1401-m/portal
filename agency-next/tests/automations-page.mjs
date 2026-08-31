/**
 * The page that answers "is it running, and what is the AI doing".
 *
 * Both halves were asked for in the same breath, by the person who runs the
 * agency: the workflow was not understandable, and what the AI did was not
 * understandable. Those are fair things not to know. The model calls are
 * scattered across a dozen modules, and a job that has stopped said "Overdue"
 * and nothing else — which is a symptom, not a thing anybody can act on.
 *
 * ## Only real call sites
 *
 * The AI list is checked against the modules that actually import the model.
 * A list that flattered the portal with work it does not do would cost the
 * credibility of every other line on the page the first time somebody went
 * looking for one of them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const map = await import(pathToFileURL(`${SRC}/lib/automation-map.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * The AI, written down — and only what is true
 * ------------------------------------------------------------------ */
{
  assert.ok(map.AI_STEPS.length >= 5, "every place a model is called is listed");

  for (const s of map.AI_STEPS) {
    assert.ok(s.label && s.does && s.when && s.href, `${s.label} says what, when and where`);
    // Written for a person, not as a feature name. A one-word "Captions" would
    // be exactly the thing that was already on screen and already unhelpful.
    assert.ok(s.does.length > 40, `${s.label} explains itself rather than naming itself`);
  }

  /*
   * The claims that must stay true, because they are the ones a client would
   * be told: the model is never handed the database, and it does not invent a
   * business detail nobody gave it.
   */
  const assistant = map.AI_STEPS.find((s) => /Answers you/i.test(s.label));
  assert.ok(assistant, "the portal assistant is listed");
  assert.match(assistant.does, /never the database/i, "and its isolation is stated");
  assert.match(
    read("lib/assistant.ts"),
    /never touches the database/i,
    "which is what the module itself promises"
  );

  const caption = map.AI_STEPS.find((s) => /caption/i.test(s.label));
  assert.match(caption.does, /never invents/i, "the caption writer's one hard rule is stated");
  assert.match(
    read("lib/ai.ts"),
    /NEVER invent an owner, business name, location or contact detail/,
    "and the prompt actually says it"
  );

  // WhatsApp replies are gated on the group, which is a promise made on the
  // client's own page — the two must not drift apart.
  const wa = map.AI_STEPS.find((s) => /WhatsApp/i.test(s.label));
  assert.match(wa.does, /ticked/i, "the reply gate is named");
  assert.match(
    read("app/api/whatsapp/message/route.ts"),
    /groupAllows\(input\.groupId, "chat"\)/,
    "and the route enforces it"
  );
  ok("what the AI does is written down, and every claim on the page is true");
}

/* ------------------------------------------------------------------ *
 * A stopped job says what to do about it
 * ------------------------------------------------------------------ */
{
  assert.equal(map.whyLate("publishing", "ok"), null, "a healthy job says nothing");

  const never = map.whyLate("publishing", "never");
  assert.match(never, /never run at all/i, "a job that never ran says so");
  assert.match(never, /Apps Script/, "and points at the clock that would run it");

  /*
   * The cause has never yet been in this codebase. Vercel's free plan fires
   * two cron jobs, once a day each, and this map expects publishing every
   * fifteen minutes — so a job can be perfectly written, perfectly deployed,
   * and still only run at breakfast. That is not a thing anybody guesses from
   * the word "Overdue".
   */
  const late = map.whyLate("publishing", "late");
  assert.match(late, /only once a day/i, "the real cause is named");
  assert.match(late, /15 minutes/, "along with the frequency it needs");

  assert.match(
    map.whyLate("ads_sync", "failing"),
    /ran and could not finish/i,
    "a failure is not confused with a missing schedule"
  );

  const page = read("app/(app)/automations/page.tsx");
  assert.ok(page.includes("whyLate(j.key, j.health)"), "the page shows it");
  assert.ok(page.includes("AI_STEPS.map("), "and the AI list too");
  ok("a stopped job carries its fix, not just a red badge");
}

/* ------------------------------------------------------------------ *
 * And the dashboard says it, on the page people actually open
 * ------------------------------------------------------------------ */
{
  /*
   * The Automations page is where the answer lives; the dashboard is where
   * somebody looks in the morning. A portal could sit for weeks publishing
   * nothing while every screen looked merely quiet — "Not posted" says a slot
   * came and went, and cannot say that nothing has been calling the publisher
   * at all, which has been the cause every time so far.
   */
  const dash = read("app/(app)/dashboard/page.tsx");
  assert.ok(dash.includes("jobStatuses()"), "the dashboard asks whether the machine is running");
  assert.ok(dash.includes("CRITICAL_JOBS.includes(j.key)"), "about the jobs whose silence costs");
  assert.ok(dash.includes('href="/automations"'), "and links to what to do about it");

  /*
   * Not every job is worth interrupting a morning for. A late ad sync means a
   * stale number and the ads board says so itself; a banner for that is how a
   * banner stops being read.
   */
  assert.deepEqual(
    map.CRITICAL_JOBS,
    ["publishing", "whatsapp_outbox", "whatsapp_reminders"],
    "publishing and the two that reach clients — not every job"
  );

  /*
   * Admins only. A crm can see the symptom on their own clients but cannot
   * change a schedule, and a warning nobody can act on is noise.
   */
  assert.ok(
    dash.includes("const stopped = isCrm\n    ? []"),
    "a crm is not shown a warning they cannot act on"
  );
  ok("a dead schedule shows up on the morning screen, not only where it is explained");
}

await finish(pass);
