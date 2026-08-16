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

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (needle, why) => assert.ok(rem.includes(needle), why);

const items = [
  { title: "Diwali reel", due_date: "2026-08-17" },
  { title: "Store walkthrough", due_date: "2026-08-17" },
];

/* ---------------- three times a day, at the times asked for ---------------- */
{
  has('{ at: "10:00", key: "morning"', "morning");
  has('{ at: "13:30", key: "midday"', "after lunch");
  has('{ at: "18:00", key: "evening"', "end of day");
  const list = rem.slice(rem.indexOf("const FOOTAGE_SLOTS"), rem.indexOf("];", rem.indexOf("const FOOTAGE_SLOTS")));
  assert.equal((list.match(/at: "/g) || []).length, 3, "exactly three");

  // The n8n schedule has to actually fire at those times, or the code is
  // right and nothing happens — which is what went wrong last time.
  const wf = JSON.parse(readFileSync(`${SRC}/../../n8n/workflows/whatsapp-reminders.json`, "utf8"));
  const crons = (wf.nodes ?? [])
    .filter((n) => /schedule/i.test(n.type ?? ""))
    .flatMap((n) => (n.parameters?.rule?.interval ?? []).map((i) => i.expression));
  assert.deepEqual(crons, ["0 10 * * *", "30 13 * * *", "0 18 * * *"], "the workflow fires three times");
  ok("three asks a day, and the schedule that fires them");
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
  has("async function ONE_GROUP()", "the join is computed, so it can be gated");
  has("AND client_id IN (SELECT id FROM clients WHERE auto_reminders = 1)", "opted-out clients drop out");
  assert.equal(
    (rem.match(/JOIN \$\{await ONE_GROUP\(\)\} g/g) || []).length,
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

await finish(pass);
