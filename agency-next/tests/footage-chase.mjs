/**
 * Asking for the footage until it turns up.
 *
 * Two wrong versions before this one. The first asked once, on exactly one day
 * — miss that morning and the client was never chased. The second asked three
 * times but spread them across a week, which is once a week for three weeks,
 * not three chances in a day.
 *
 * Three slots a day now, every day the footage is missing. The rules that
 * matter: nothing is sent twice, and every one of them stops the moment the
 * link arrives.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const msg = await import(pathToFileURL(`${SRC}/lib/reminder-messages.ts`).href);
const rem = readFileSync(`${SRC}/lib/whatsapp-reminders.ts`, "utf8");
const raw = await import(pathToFileURL(`${SRC}/lib/raw-footage.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (needle, why) => assert.ok(rem.includes(needle), why);

const items = [
  { title: "Diwali reel", due_date: "2026-08-17" },
  { title: "Store walkthrough", due_date: "2026-08-17" },
];

/* ---------------- once a day now, and why ---------------- */
{
  /*
   * Three a day was the third wrong version, and the client is the one who
   * said so: asked three times a day for something they already know they owe
   * you, it stops reading as a reminder and starts reading as pestering — and
   * then the group gets muted. A muted group is worse than a missed reminder,
   * because approvals, the finished video and the invoice all go there too.
   *
   * Half past one: the middle of a working day, when somebody is at a desk and
   * can actually go and find the file. Morning is too early to have looked;
   * the end of the day is too late to act on it.
   */
  has('{ at: "13:30", key: "midday"', "the middle of the working day");
  const list = rem.slice(rem.indexOf("const FOOTAGE_SLOTS"), rem.indexOf("];", rem.indexOf("const FOOTAGE_SLOTS")));
  assert.equal((list.match(/at: "/g) || []).length, 1, "exactly one");

  /*
   * The schedule is deliberately not asserted any more.
   *
   * It used to be, because the code was right and nothing fired. That is no
   * longer the failure mode: the runner is called every fifteen minutes by the
   * portal's own clock, and this file decides which slot has passed. Extra
   * runs are harmless by construction — the slot is claimed per client, per
   * day, so the ninety-sixth call of the day sends nothing the first one
   * already did.
   */
  has("const passed = FOOTAGE_SLOTS.filter((s) => now.hm >= s.at);", "the slot is the latest one passed");
  ok("one ask a day, at a time somebody can do something about it");
}

/* ---------------- the clock is the database's ---------------- */
{
  // The times are the client's working day. The database keeps IST; a server
  // an hour either side would put the "10:00" message out at nine or eleven.
  has("SELECT DATE_FORMAT(NOW(), '%H:%i') AS hm, CURDATE() AS today", "the time comes from SQL");
  has("const passed = FOOTAGE_SLOTS.filter((s) => now.hm >= s.at);", "the slot is the latest one passed");
  has("return slot ? {", "and nothing is sent before the first");

  // A slot stays claimable until the next one, so a late run still sends the
  // slot it is in rather than skipping it or firing all three at once.
  has("if (!slot) return { sent: 0, failed: 0 };", "a run before 10:00 sends nothing");
  ok("the slot is decided by the database clock, not this server's");
}

/* ---------------- and nothing repeats, or nags a finished task ---------- */
{
  // The date is in the key because the chase repeats daily — without it the
  // first day's claim would silence every day after it.
  has("const key = `c:${r.client_id}:${slot.today}:${slot.key}`;", "claimed per client, per day, per slot");

  // The stopping condition. All three slots depend on it.
  has("AND (d.raw_drive_link IS NULL OR d.raw_drive_link = '')", "nothing with a link is chased");
  has("d.status IN ('pending','waiting_for_raw')", "nor anything past needing it");
  has("AND d.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)", "from the lead time onward, including overdue");
  ok("a claim is per slot per day, and the chase ends when the footage lands");
}

/* ---------------- a client can be left out of all of it ---------------- */
{
  // Some clients would rather hear from a person. Every reminder reaches them
  // through one join, so the opt-out lives there — not repeated as a condition
  // in five queries, one of which somebody would forget.
  has("async function ONE_GROUP(purpose: Purpose)", "the join is computed, so it can be gated");
  has("AND client_id IN (SELECT id FROM clients WHERE auto_reminders = 1)", "opted-out clients drop out");
  /*
   * The join now also decides *which* of a client's groups a kind of message
   * goes to, so it takes a purpose. It is still the one join every reminder
   * passes through, which is what makes a single opt-out enough — a rule that
   * picked its own group would also have to remember to check `auto_reminders`.
   */
  assert.equal(
    (rem.match(/JOIN \$\{await ONE_GROUP\([^)]*\)\} g/g) || []).length,
    5,
    "and every reminder kind goes through it"
  );
  // A database without the column keeps chasing everybody, as it did before.
  has('hasColumn("clients", "auto_reminders")', "gated for an un-migrated database");

  const form = readFileSync(`${SRC}/app/(app)/clients/client-form.tsx`, "utf8");
  assert.ok(form.includes('name="auto_reminders"'), "there is a switch for it");
  assert.ok(form.includes("defaultChecked={d.auto_reminders !== false}"), "on unless turned off");
  ok("a client who does not want chasing can be excluded, in one place");
}

/* ---------------- the three messages differ ---------------- */
{
  const early = msg.footageText(items, "early");
  const due = msg.footageText(items, "due");
  const late = msg.footageText(items, "late");
  assert.notEqual(early, due);
  assert.notEqual(due, late);

  // The last of the day is the one that would read as blame if written
  // carelessly. It offers something instead.
  assert.match(late, /holding the slot for you/);
  assert.ok(!/\b(late|overdue|missed|failed)\b/i.test(late), "and never calls them late");

  for (const [name, t] of [["early", early], ["due", due], ["late", late]]) {
    assert.match(t, /Thank you! 🙏/, `${name} thanks them`);
    assert.match(t, /Please just reply with the link/, `${name} says how to answer`);
    assert.ok(!/\bASAP\b|as soon as possible/i.test(t), `${name} does not hurry them`);
  }
  ok("three different messages, none of which blames anybody");
}

/* ---------------- a poster is never chased for footage ---------------- */
{
  // Posters and videos share one `status` column, so a poster handed to its
  // designer sits at `waiting_for_raw` — and every footage query read that as
  // "blocked on the client". The chase went out asking for rushes that were
  // never going to exist, about a piece already sitting with our own designer.
  assert.ok(raw.needsRawFootage("video_editing"), "a reel is shot by the client");
  for (const s of ["poster_designing", "meta_ads", "content_writing"]) {
    assert.ok(!raw.needsRawFootage(s), s + " has no footage to send");
  }
  // Rows older than the service column fall back the way the migration does.
  assert.ok(!raw.needsRawFootage(null, "Poster"), "an untagged poster is still a poster");
  assert.ok(!raw.needsRawFootage("", "poster"), "whatever the casing");
  assert.ok(raw.needsRawFootage(null, null), "and an untagged row is a video, as it always was");
  ok("only video editing waits on the client for anything");
}

/* ---------------- and every query that asks knows it ---------------- */
{
  // The rule is worth nothing in one query. It was eight, each with its own
  // copy of "status IN (pending, waiting_for_raw) AND no link" — the chase,
  // the manual reminder, the client portal, the group reply, the map, the
  // monthly summary and both assistants. Any new one must carry it too.
  const ASKS = [
    "lib/whatsapp-reminders.ts",
    "lib/reminder-messages.ts",
    "lib/portal.ts",
    "lib/whatsapp-ai.ts",
    "lib/assistant.ts",
    "lib/automation-map.ts",
    "app/api/whatsapp/footage/route.ts",
    "app/api/whatsapp/summary/route.ts",
  ];
  /*
   * Either name counts, because there is still only one rule.
   *
   * `footageChaseSql` is this rule with a second question after it — does this
   * client send us footage at all — and the four callers that write into a
   * client's group use it. The other four ask the task question bare, on
   * purpose: accepting a link, and showing the agency what is outstanding,
   * must not change because we stopped chasing somebody. `no-second-ask.mjs`
   * holds that split; this holds the part both halves share.
   */
  for (const p of ASKS) {
    const src = readFileSync(`${SRC}/${p}`, "utf8");
    assert.ok(
      src.includes("needsRawFootageSql(") || src.includes("footageChaseSql("),
      `${p} decides who to chase and must read the one rule`
    );
  }
  ok("all eight places that ask for footage read the same rule");
}

await finish(pass);
