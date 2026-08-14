/**
 * Asking for the footage more than once.
 *
 * It was asked for on exactly one day — three days before the due date — and
 * never again. A client who did not send it that morning was never chased, and
 * the task waited until somebody noticed by hand.
 *
 * Three asks now, and the thing that must hold: every one of them stops the
 * moment the footage arrives, and none of them can go twice.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const msg = await import(pathToFileURL(`${SRC}/lib/reminder-messages.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

const items = [
  { title: "Diwali reel", due_date: "2026-08-17" },
  { title: "Store walkthrough", due_date: "2026-08-17" },
];

/* ---------------- three asks, spaced around the due date ---------------- */
{
  const rem = readFileSync(`${SRC}/lib/whatsapp-reminders.ts`, "utf8");

  has(rem, "const FOOTAGE_ASKS", "the asks are a list, not a single day");
  has(rem, '{ offset: -3, stage: "early" }', "a few days out");
  has(rem, '{ offset: 0, stage: "due" }', "on the day");
  has(rem, '{ offset: 2, stage: "late" }', "and once it has passed");

  // Three, not a nag without end. Worth asserting so nobody adds a fourth
  // without meaning to.
  const list = rem.slice(rem.indexOf("const FOOTAGE_ASKS"), rem.indexOf("];", rem.indexOf("const FOOTAGE_ASKS")));
  // Entries only — the type annotation above them also says `offset: number`.
  assert.equal((list.match(/offset: -?\d/g) || []).length, 3, "exactly three");

  // The single fixed day is gone.
  assert.ok(!/FOOTAGE_WARNING_DAYS/.test(rem), "the one-shot constant is gone");
  has(rem, "AND d.due_date = DATE_SUB(CURDATE(), INTERVAL ? DAY)", "one query serves all three");
  ok("footage is asked for three times, around the date rather than once before it");
}

/* ---------------- and each one is claimed separately ---------------- */
{
  const rem = readFileSync(`${SRC}/lib/whatsapp-reminders.ts`, "utf8");

  // The stage is in the key, so the three are independent and none repeats.
  // Without it the second and third would find the first's claim and stay
  // silent — which is the bug this replaces, written a different way.
  has(rem, "const key = `c:${r.client_id}:${r.due_date}:${ask.stage}`", "the stage is part of the claim");
  has(rem, "for (const ask of FOOTAGE_ASKS) {", "each ask runs on its own");

  // Stopping when the footage arrives is not a new rule — the query has always
  // only returned tasks with no link. Asserted because all three asks now
  // depend on it.
  has(
    rem,
    "AND (d.raw_drive_link IS NULL OR d.raw_drive_link = '')",
    "nothing with a link is ever chased"
  );
  has(rem, "d.status IN ('pending','waiting_for_raw')", "nor anything past needing it");

  // "What would the next run do" has to count all three, or the console
  // under-reports the moment more than one falls on the same day.
  has(rem, "for (const ask of FOOTAGE_ASKS) {\n      const rows = await findFootageDue(ask.offset);", "the preview counts every ask");
  ok("each of the three is claimed on its own, and all stop when footage lands");
}

/* ---------------- the three say different things ---------------- */
{
  const early = msg.footageText(items, "early");
  const due = msg.footageText(items, "due");
  const late = msg.footageText(items, "late");

  assert.notEqual(early, due, "the second is not the first again");
  assert.notEqual(due, late, "nor the third the second");

  assert.match(early, /due to start editing on \*17 Aug 2026\*/, "the first names the date");
  assert.match(due, /\*today\*/, "the second says today");
  assert.match(late, /coming back to this one/, "and the third acknowledges it is a second ask");

  // The one that would read as blame if it were written carelessly. It offers
  // something instead of pointing out that the client is late.
  assert.match(late, /holding the slot for you/, "the last one offers rather than accuses");
  assert.ok(!/\b(still |again )?(late|overdue|missed|failed)\b/i.test(late), "and never uses the word late at them");

  // Every one keeps the courtesy the whole portal is held to, and keeps the
  // instruction that makes a reply usable.
  for (const [name, text] of [["early", early], ["due", due], ["late", late]]) {
    assert.match(text, /Thank you! 🙏/, `${name} thanks them`);
    assert.match(text, /Please just reply with the link/, `${name} says how to answer`);
    assert.ok(!/^\s*Send (us|me|the)/im.test(text), `${name} asks rather than instructs`);
    assert.ok(!/\bASAP\b|as soon as possible/i.test(text), `${name} does not hurry them`);
  }

  // Default unchanged, so every other caller — the manual "chase them" button
  // on the reminders console — gets exactly what it got before.
  assert.equal(msg.footageText(items), early, "the default is the first stage");
  ok("each ask says something the last did not, and none of them blames anybody");
}

/* ---------------- mixed dates are unchanged ---------------- */
{
  // A manual chase gathers tasks with different dates, and leading with any
  // one of them would be a false deadline. That path ignores the stage.
  const mixed = [
    { title: "A", due_date: "2026-08-17" },
    { title: "B", due_date: "2026-08-24" },
  ];
  const a = msg.footageText(mixed, "early");
  const b = msg.footageText(mixed, "late");
  assert.equal(a, b, "with several dates the wording does not change by stage");
  assert.match(a, /17 Aug 2026/);
  assert.match(a, /24 Aug 2026/);
  assert.ok(!/holding the slot/.test(b), "and it never claims to hold a slot for a set of dates");
  ok("a chase across several dates still leads with none of them");
}

await finish(pass);
