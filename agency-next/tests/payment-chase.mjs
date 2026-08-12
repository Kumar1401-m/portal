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

/* ---------------- the invoice email carries it too ---------------- */
{
  const email = readFileSync(`${SRC}/lib/email.ts`, "utf8");
  assert.match(email, /payable \? "Pay now" : "View & pay"/, "the email offers to pay, not to log in");
  assert.match(email, /no login needed/, "and says so");

  const actions = readFileSync(`${SRC}/app/(app)/payments/actions.ts`, "utf8");
  assert.match(
    actions,
    /paymentLinkForInvoice\(newInvoiceId\)/,
    "the link is made when the invoice is raised, not only when it is chased"
  );
  ok("the first message about an invoice can be paid from, not just the fourth");
}

await clean();
await finish(pass);
