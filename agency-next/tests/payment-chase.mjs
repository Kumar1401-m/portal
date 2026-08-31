/**
 * Chasing an unpaid invoice on WhatsApp, once its due date has passed.
 *
 * Three things have to hold, and only one of them is about the message.
 *
 * It fires on the due date, weekly rather than daily. It carries a link the
 * client can tap rather than a portal they must log into. And it goes only to
 * clients somebody chose — automatically chasing a whole book for money is not
 * a default anyone should inherit.
 *
 * Nothing here sends anything. `composeReminder` builds exactly the text the
 * nightly rule sends, so the words and the link can be checked without a real
 * group being messaged.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const db = await load("lib/db.ts");
const rm = await load("lib/reminder-messages.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const TAG = "ZZ chase client";
const MONTH = new Date().toISOString().slice(0, 7);
const clean = async () => {
  await db.execute("DELETE FROM invoices WHERE invoice_no LIKE 'ZZ-CHASE-%'");
  await db.execute("DELETE FROM clients WHERE company_name = ?", [TAG]);
};
await clean();

const clientId = Number(
  (await db.execute(
    "INSERT INTO clients (company_name, status, auto_payment_reminders) VALUES (?, 'active', 1)",
    [TAG]
  )).insertId
);

const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
await db.execute(
  `INSERT INTO invoices (invoice_no, client_id, amount, total, status, issue_date, due_date, period_month, created_by)
   VALUES ('ZZ-CHASE-1', ?, 25000, 25000, 'sent', CURDATE(), ?, ?, 1)`,
  [clientId, yesterday, MONTH]
);

/* ---------------- the message carries a way to pay ---------------- */
{
  const composed = await rm.composeReminder("invoice_due", clientId);
  assert.ok(composed.text, `there is a message to send: ${composed.nothing ?? ""}`);
  assert.match(composed.text, /ZZ-CHASE-1/, "it names the invoice");
  assert.match(composed.text, /25,000/, "and the amount");
  assert.match(composed.text, /https?:\/\//, "and carries a link, not just an instruction");

  // Courteous, like every other client message — this one especially.
  assert.match(composed.text, /gentle reminder/i);
  assert.match(composed.text, /Thank you/i);
  ok("an overdue invoice becomes a message with the amount and a link");

  // Whatever Razorpay does, a link is produced: a real payment link when it
  // can be made, the portal page when it cannot. Chasing must not depend on
  // a third party being up.
  const row = await db.queryOne(
    "SELECT payment_link FROM invoices WHERE invoice_no = 'ZZ-CHASE-1'"
  );
  const payable = /rzp\.io|razorpay/.test(composed.text);
  if (payable) {
    assert.ok(row.payment_link, "a real link is cached on the invoice for next week");
    ok("a Razorpay link was created and remembered, so next week's chase reuses it");
  } else {
    assert.match(composed.text, /portal/i, "the fallback points at the portal");
    ok("without Razorpay it still sends, pointing at the portal instead");
  }
}

/* ---------------- one link, not one per reminder ---------------- */
{
  // Razorpay keeps every link ever made, and any of them can be paid. Twelve
  // live links against one invoice means working out which one was used.
  const first = await rm.composeReminder("invoice_due", clientId);
  const second = await rm.composeReminder("invoice_due", clientId);
  const url = (t) => (t.match(/https?:\/\/\S+/) || [])[0];
  assert.equal(url(first.text), url(second.text), "the same link comes back a second time");
  ok("the link is made once and reused, not minted per reminder");
}

/* ---------------- only clients who were chosen ---------------- */
{
  const src = readFileSync(`${SRC}/lib/whatsapp-reminders.ts`, "utf8");
  assert.match(
    src,
    /hasColumn\("clients", "auto_payment_reminders"\)[\s\S]{0,120}auto_payment_reminders = 1/,
    "the nightly rule only picks clients who were ticked"
  );
  assert.match(src, /i\.due_date IS NOT NULL AND i\.due_date <= CURDATE\(\)/,
    "and only once the due date has passed");
  assert.match(src, /DATE_FORMAT\(CURDATE\(\), '%x-W%v'\) AS week/,
    "weekly, not daily — the scope key carries the ISO week");

  /*
   * And it is the *only* switch that decides it.
   *
   * The invoice query joins the same one-group-per-client derived table every
   * other reminder uses, and that table carried the general `auto_reminders`
   * opt-out — so a client with this box deliberately ticked and "Chase this
   * client on WhatsApp" unticked was chased for nothing, with neither switch
   * on screen saying why. The general switch's own label lists footage,
   * approvals and updates; it never claimed invoices. Two switches where one
   * silently beats the other is worse than either of them.
   */
  assert.ok(
    src.includes(`purpose !== "payments" && (await hasColumn("clients", "auto_reminders"))`),
    "the general chase opt-out does not reach into money"
  );
  ok("chasing money is decided by its own switch, and nothing else overrides it");

  // Off unless chosen. A flag that defaults on is not a choice.
  const schema = readFileSync(`${SRC}/lib/schema-sync.ts`, "utf8");
  assert.match(
    schema,
    /auto_payment_reminders TINYINT\(1\) NOT NULL DEFAULT 0/,
    "and it is off for every client until somebody ticks it"
  );
  ok("only chosen clients are chased, once the due date passes, once a week");

  // Sending by hand is a person's decision and needs no flag — composeReminder
  // above worked without consulting it.
  const console_ = readFileSync(`${SRC}/lib/reminder-messages.ts`, "utf8");
  assert.ok(
    !/auto_payment_reminders/.test(console_),
    "sending one by hand from the console is not gated"
  );
  ok("a person can still chase any client by hand from Settings → Reminders");
}

/* ---------------- money does not go by email at all ---------------- */
{
  /*
   * Asked for directly: no mail for payments.
   *
   * There were two — the invoice when it was raised, and a receipt when it was
   * paid, each with a copy to the agency's own inbox. Both are gone, and it is
   * worth being clear about what replaces them, because "we removed the
   * invoice email" is only a good change if the client still finds out.
   *
   * They do, twice over: the portal notification below, which was always the
   * client's record and was never opt-out, and WhatsApp — the weekly chase
   * with a payable link in it, and the invoice itself as a PDF into the
   * payments group. Two channels that get read beat three where one doesn't.
   */
  const email = readFileSync(`${SRC}/lib/email.ts`, "utf8");
  assert.ok(!/sendInvoiceEmail|sendPaidInvoiceEmail/.test(email), "neither money email exists");
  assert.ok(
    /sendApprovalRequestEmail|sendOnboardingEmail/.test(email),
    "and the rest of the mail system is untouched"
  );

  for (const f of ["app/(app)/payments/actions.ts", "app/portal/actions.ts", "lib/invoicing.ts"]) {
    const s = readFileSync(`${SRC}/${f}`, "utf8");
    assert.ok(!/from "@?[./@a-z]*\/?email"/.test(s), `${f} sends no mail`);
  }
  // And the forms no longer offer to, which is the half a person sees.
  for (const f of ["app/(app)/payments/new/invoice-form.tsx", "app/(app)/payments/page.tsx"]) {
    assert.ok(
      !/send_email/.test(readFileSync(`${SRC}/${f}`, "utf8")),
      `${f} has no email tickbox left over`
    );
  }

  /*
   * Raising an invoice moved out of the Payments form and into `invoicing.ts`
   * when a month's plan started raising them too — the invoice numbering reads
   * a count of existing invoices, and a second copy of that mints the same
   * number twice on one day.
   */
  const invoicing = readFileSync(`${SRC}/lib/invoicing.ts`, "utf8");
  assert.match(invoicing, /notifyClientById\(/, "the client is still told, in their portal");
  assert.match(
    readFileSync(`${SRC}/app/(app)/payments/actions.ts`, "utf8"),
    /raiseInvoice\(\{/,
    "and the form raises invoices through that one place"
  );

  // The payable link survives where it is actually read: the WhatsApp chase.
  assert.match(
    readFileSync(`${SRC}/lib/whatsapp-reminders.ts`, "utf8"),
    /paymentLinkForInvoice\(/,
    "the chase can still be paid from"
  );
  ok("payments reach the client by portal and WhatsApp, and by no email");
}

await clean();
await finish(pass);
