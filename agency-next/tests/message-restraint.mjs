/**
 * How much this portal is allowed to say to a client in a day.
 *
 * Two complaints, one cause. The client was getting too much email, and too
 * much WhatsApp — and every individual rule that produced it was reasonable.
 * Chase an approval. Ask for the footage. Mention the unpaid invoice. Each one
 * defensible; all of them landing on the same group on the same morning is a
 * phone that will not stop buzzing, and then the group gets muted.
 *
 * A muted group is worse than a missed reminder, because *everything* goes
 * there — approvals, the finished video, the invoice. Losing the channel costs
 * more than any single message in it was worth.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * A client is emailed once, when they are onboarded
 * ------------------------------------------------------------------ */
{
  /*
   * Onboarding survives because it carries something nothing else can: the
   * portal address and their sign-in. Everything after it is a duplicate of
   * something already in the portal and already in their WhatsApp group.
   */
  const notify = read("lib/notify.ts");
  assert.ok(
    /notifyClientById[\s\S]{0,600}mail = false/.test(notify),
    "a portal notification no longer becomes an email by default"
  );

  // The two that were client-facing are gone from every caller.
  for (const gone of ["sendApprovalRequestEmail", "sendPostPublishedEmail"]) {
    const callers = ["app/(app)/deliverables/actions.ts", "app/(app)/assistant-actions.ts", "app/api/automation/notify/route.ts"]
      .filter((f) => strip(read(f)).includes(gone));
    assert.deepEqual(callers, [], `${gone} is not called from anywhere`);
  }

  // Onboarding and the staff password email stay. One is the exception that
  // was asked for; the other never went to a client at all.
  assert.ok(
    strip(read("app/(app)/clients/actions.ts")).includes("sendOnboardingEmail"),
    "onboarding still emails, which is the one that was asked for"
  );
  assert.ok(
    strip(read("app/(app)/settings/actions.ts")).includes("sendStaffWelcomeEmail"),
    "and a new staff member still gets their password"
  );
  ok("clients are emailed at onboarding and never again");
}

/* ------------------------------------------------------------------ *
 * The publish notifier says so rather than pretending
 * ------------------------------------------------------------------ */
{
  /*
   * The route still accepts `email` as a channel and answers honestly that it
   * did nothing. Dropping it silently would leave whoever wired the caller
   * believing mail went out; removing the channel would break every caller
   * that still names it.
   */
  const route = strip(read("app/api/automation/notify/route.ts"));
  assert.ok(route.includes(`requested.includes("email")`), "the channel is still accepted");
  assert.ok(route.includes("skipped:"), "and reports that it was skipped, with a reason");
  assert.ok(route.includes("sendPostPublishedWhatsApp"), "WhatsApp still goes — that one is read");
  ok("a caller asking for email is told it was skipped, not left to assume");
}

/* ------------------------------------------------------------------ *
 * Footage: once a day, not three times
 * ------------------------------------------------------------------ */
{
  const src = read("lib/whatsapp-reminders.ts");
  const slots = src.slice(src.indexOf("const FOOTAGE_SLOTS"), src.indexOf("const FOOTAGE_LEAD_DAYS"));
  const times = (slots.match(/at: "/g) || []).length;

  /*
   * This was the loudest thing the portal did: three asks a day, every day,
   * for something the client already knows they owe. Asked that often it stops
   * reading as a reminder and starts reading as pestering.
   */
  assert.equal(times, 1, `one ask a day, not three (found ${times})`);
  assert.ok(slots.includes(`at: "13:30"`), "in the middle of a working day, when somebody can act on it");
  ok("footage is asked for once a day, at a time somebody can do something about it");
}

/* ------------------------------------------------------------------ *
 * A ceiling on everything else, held back rather than dropped
 * ------------------------------------------------------------------ */
{
  const src = read("lib/whatsapp-reminders.ts");
  const cap = Number((src.match(/MAX_AUTOMATIC_PER_DAY\s*=\s*(\d+)/) || [])[1] || 0);
  assert.ok(cap > 0 && cap <= 6, `there is a daily ceiling, and it is small (${cap})`);

  /*
   * Counted per client, not per kind. A client does not experience "kinds" —
   * they experience a phone buzzing, and four rules each politely sending one
   * message is still four messages.
   */
  assert.ok(
    /WHERE client_id = \? AND DATE\(sent_at\) = CURDATE\(\)/.test(src),
    "counted per client, per day"
  );

  /*
   * Checked when the right to send is taken, not when the message goes.
   *
   * Refusing a claim leaves the message unclaimed, so tomorrow picks it up —
   * deferred, not lost. Checking at the send would burn the claim on a message
   * nobody received, and that client would never hear about that video at all.
   */
  const claimBody = src.slice(src.indexOf("async function claim("), src.indexOf("async function unclaim("));
  assert.ok(claimBody.includes("sentTodayTo(meta.clientId)"), "the ceiling is checked at claim time");
  assert.ok(claimBody.includes("return false;"), "and simply declines, leaving it for tomorrow");

  const deliverBody = src.slice(src.indexOf("async function deliver("), src.indexOf("/* ---"));
  assert.ok(
    !deliverBody.includes("MAX_AUTOMATIC_PER_DAY"),
    "and never at the send, where declining would lose the message"
  );

  /*
   * Auto-approve is exempt, and that is not a loophole. It is not a message —
   * it is the portal deciding on the client's behalf, and the message only
   * reports it. Holding it back would leave a video unapproved and unpublished
   * for a day, which is a much worse outcome than one more line in a chat.
   */
  assert.ok(
    /NO_CEILING[^=]*=\s*\[[^\]]*"auto_approve"/.test(src),
    "auto-approve is never held back — it is a decision, not a nudge"
  );
  for (const internal of ["team_digest", "expense_due"]) {
    assert.ok(new RegExp(`NO_CEILING[^=]*=\\s*\\[[^\\]]*"${internal}"`).test(src),
      `${internal} is exempt — it never reaches a client`);
  }

  // And the approval chase and the money chase are NOT exempt.
  for (const capped of ["approval_chase", "footage_due", "invoice_due", "monthly_plan"]) {
    assert.ok(
      !new RegExp(`NO_CEILING[^=]*=\\s*\\[[^\\]]*"${capped}"`).test(src),
      `${capped} is subject to the ceiling`
    );
  }
  ok("four automatic messages a day, counted per client, deferred rather than dropped");
}

/* ------------------------------------------------------------------ *
 * Six switches, named the way somebody would say them
 * ------------------------------------------------------------------ */
{
  const src = read("lib/client-messages.ts");
  for (const k of ["approvals", "footage", "payments", "reports", "posted", "ai_replies"]) {
    assert.ok(src.includes(`key: "${k}"`), `there is a switch for ${k}`);
  }

  /*
   * Three of them already existed and are reused rather than duplicated. A
   * second column meaning the same thing as auto_reminders is how a client
   * ends up chased on a screen that says they are not.
   */
  for (const col of ["auto_reminders", "provides_footage", "auto_payment_reminders"]) {
    assert.ok(src.includes(`column: "${col}"`), `${col} is reused, not duplicated`);
  }

  /*
   * Payments defaults off and the others on — which is the behaviour that
   * already existed. A migration that silently changed what a client receives
   * would be the worst possible way to ship this.
   */
  const pay = src.slice(src.indexOf(`key: "payments"`), src.indexOf(`key: "reports"`));
  assert.ok(/fallback: false/.test(pay), "chasing money stays off unless chosen");
  ok("six switches, three of them the ones that already existed");
}

/* ------------------------------------------------------------------ *
 * Off actually stops the message
 * ------------------------------------------------------------------ */
{
  // The three that had no switch at all until now.
  assert.ok(
    strip(read("lib/instagram-publish.ts")).includes(`clientWants(item.client_id, "posted")`),
    "the post-is-live message is gated"
  );
  assert.ok(
    strip(read("lib/monthly-report.ts")).includes(`clientWants(c.id, "reports")`),
    "the monthly report is gated"
  );
  assert.ok(
    strip(read("app/api/whatsapp/message/route.ts")).includes(`clientWants(clientId, "ai_replies")`),
    "the assistant is gated per client as well as per group"
  );

  /*
   * The report is checked before the claim, and that ordering matters: claimed
   * first, a client who does not want reports would be marked as having had
   * one, and turning the switch back on next month would find the month
   * already done.
   */
  const rep = read("lib/monthly-report.ts");
  /*
   * Against the *call*, not the definition — `claimPeriod` is declared near
   * the top of the file, so matching the bare name compares the gate to a
   * function declaration and always fails. It did.
   */
  assert.ok(
    rep.indexOf(`clientWants(c.id, "reports")`) < rep.indexOf("await claimPeriod("),
    "and checked before the month is claimed, so switching it back on works"
  );
  ok("unticking a box stops the message, and never marks it as sent");
}

/* ------------------------------------------------------------------ *
 * The super admin can see who was messaged
 * ------------------------------------------------------------------ */
{
  const src = read("lib/whatsapp-reminders.ts");
  assert.ok(src.includes("export async function sentByClient"), "there is a per-client record");
  assert.ok(/GROUP BY r.client_id/.test(src), "grouped by client, not only by kind");
  assert.ok(src.includes("SUM(DATE(r.sent_at) = CURDATE())"), "with today counted separately");

  /*
   * Counts by kind answer "is the machine running". They cannot answer "did we
   * pester that client", which is what somebody asks after a client says so —
   * and that claim needs checking rather than arguing about.
   */
  const page = read("app/(app)/settings/reminders/page.tsx");
  assert.ok(page.includes("sentByClient(7)"), "and the console shows it");
  assert.ok(page.includes("Who we messaged"), "under a heading that says what it is");
  ok("who was messaged, about what, and how much of it was today");
}

/* ------------------------------------------------------------------ *
 * A checkbox that cannot be saved is not offered as one
 * ------------------------------------------------------------------ */
{
  /*
   * Reported as "untick, save, and it comes back ticked".
   *
   * It was not a broken save. Three of the six columns had not been applied on
   * that database, and a missing column reads as *on* — deliberately, so a
   * half-migrated portal keeps behaving as it did. The save wrote the columns
   * it had, dropped the rest without a word, and the next render put the ticks
   * back. Every part of that was working as designed and the whole was
   * indistinguishable from a bug.
   *
   * A control that cannot do anything must not look like one that can.
   */
  for (const [lib, fn] of [["lib/client-messages.ts", "storableKinds"], ["lib/whatsapp-groups.ts", "storablePurposes"]]) {
    assert.ok(read(lib).includes(`export async function ${fn}`), `${lib} can say what it can store`);
  }

  for (const card of ["app/(app)/clients/[id]/message-prefs.tsx", "app/(app)/clients/[id]/group-purposes.tsx"]) {
    const s = read(card);
    assert.ok(s.includes("storable"), `${card} is told which switches are real`);
    assert.ok(/disabled={!storable.includes/.test(s), `${card} disables the ones that are not`);
    assert.ok(s.includes("cannot be saved yet"), `${card} says so in words, not only by greying out`);
    assert.ok(s.includes("Settings → Database → Apply"), `${card} names the fix`);
  }

  /*
   * And a partial save reports itself. Saying "Saved" while quietly dropping
   * half of it is how this was found in the first place.
   */
  const action = read("app/(app)/clients/[id]/message-actions.ts");
  assert.ok(action.includes("missing.push(k.label)"), "the action tracks what it could not write");
  assert.ok(action.includes("Saved what it could"), "and says so rather than claiming success");
  ok("a switch with no column behind it is disabled, labelled, and never claims to have saved");
}

/* ------------------------------------------------------------------ *
 * A card with nothing to decide is not shown
 * ------------------------------------------------------------------ */
{
  /*
   * The group card answers "which of their groups gets what". Most clients
   * have one group, and with one group that question has exactly one answer —
   * the purposes *order* groups rather than filter them, so every tick on it
   * changes nothing.
   *
   * Six controls that do nothing, sitting above a card that does, teaches
   * somebody that neither of them works. It comes back the moment a second
   * group is linked, which is the case it was built for.
   */
  const card = read("app/(app)/clients/[id]/group-purposes.tsx");
  assert.ok(card.includes("if (groups.length === 1) return null;"), "one group, no card");

  // Zero is not the same as one. Nothing can reach that client at all, and
  // that is worth saying rather than hiding.
  assert.ok(card.includes("No group linked yet"), "no groups still says so");
  ok("the routing card appears only for clients who actually have a choice");
}

await finish(pass);
