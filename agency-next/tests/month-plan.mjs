/**
 * A month agreed on its own, and billed exactly once.
 *
 * The client record holds `monthly_deliverables`, `monthly_posters` and
 * `package_amount` — one set of numbers standing for every month there will
 * ever be. "Next month they want twelve videos instead of eight and two extra
 * posters" could only be recorded by editing that, which then reported twelve
 * for the month just closed as well, and for every month before it.
 *
 * ## The half worth testing hardest
 *
 * Saving a month raises its invoice and sends it, with no draft step. So the
 * guard matters more than the sending: a save pressed twice, a double-click,
 * or a retry after a timeout must not put two invoices in front of a client.
 * `claimMonthInvoice` is a conditional UPDATE on `invoice_id IS NULL`, and
 * this is what proves only one caller can ever win it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const mp = await import(pathToFileURL(`${SRC}/lib/month-plans.ts`).href);
const tp = await import(pathToFileURL(`${SRC}/lib/task-plan.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute(
    "DELETE FROM client_month_plans WHERE client_id IN (SELECT id FROM clients WHERE company_name LIKE 'ZZ plan%')"
  );
  await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ plan%'");
  await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ plan%'");
};

/** A client on the usual eight videos and no posters. */
async function client() {
  return Number(
    (
      await db.execute(
        `INSERT INTO clients (company_name, status, monthly_deliverables, monthly_posters, package_amount)
         VALUES ('ZZ plan client', 'active', 8, 0, 12000)`
      )
    ).insertId
  );
}

/* ------------------------------------------------------------------ *
 * A month with no plan is the contract, exactly as before
 * ------------------------------------------------------------------ */
{
  await clean();
  const cid = await client();
  try {
    assert.equal(await mp.monthPlanFor(cid, "2030-09"), null, "no plan means no plan");

    const plan = await tp.monthPlan(cid, "2030-09");
    assert.equal(plan.videoTarget, 8, "the month owes what the contract says");
    assert.equal(plan.posterTarget, 0);
    assert.equal(plan.agreed, null, "and says it is following the contract");
    ok("a client who never uses this sees exactly what they saw before");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * A month agreed ahead is that month, and only that month
 * ------------------------------------------------------------------ */
{
  await clean();
  const cid = await client();
  try {
    await mp.saveMonthPlan({
      clientId: cid,
      month: "2030-09",
      videos: 12,
      posters: 2,
      amount: 19200,
      note: "Festive push",
    });

    const sept = await tp.monthPlan(cid, "2030-09");
    assert.equal(sept.videoTarget, 12, "September owes twelve");
    assert.equal(sept.posterTarget, 2, "and two posters");
    assert.equal(sept.agreed.amount, 19200, "at the amount agreed for it");
    assert.equal(sept.agreed.note, "Festive push");

    /*
     * The whole reason this is a table and not three more columns on the
     * client: August must not have changed. Editing the contract to get
     * September right is what used to rewrite every month, including closed
     * ones the scorecard had already reported on.
     */
    const aug = await tp.monthPlan(cid, "2030-08");
    assert.equal(aug.videoTarget, 8, "August is untouched");
    assert.equal(aug.agreed, null, "and still follows the contract");
    ok("agreeing September changes September and nothing else");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * Saving twice is one plan, not two
 * ------------------------------------------------------------------ */
{
  await clean();
  const cid = await client();
  try {
    await mp.saveMonthPlan({ clientId: cid, month: "2030-09", videos: 12, posters: 2, amount: 19200 });
    await mp.saveMonthPlan({ clientId: cid, month: "2030-09", videos: 10, posters: 1, amount: 15000 });

    const rows = await db.query(
      "SELECT videos, posters, amount FROM client_month_plans WHERE client_id = ? AND month_key = '2030-09'",
      [cid]
    );
    assert.equal(rows.length, 1, "one row for one month");
    assert.equal(Number(rows[0].videos), 10, "holding the correction, not the first attempt");
    assert.equal(Number(rows[0].amount), 15000);
    ok("a month is a decision, so saving it again corrects it rather than adding another");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * The invoice can be claimed once, and only once
 * ------------------------------------------------------------------ */
{
  await clean();
  const cid = await client();
  try {
    await mp.saveMonthPlan({ clientId: cid, month: "2030-09", videos: 12, posters: 2, amount: 19200 });

    /*
     * Two callers reaching the biller at once — a double-clicked Save, or a
     * retry after a timeout on a request that actually succeeded. Both are
     * ordinary; only one may send an invoice to a client.
     */
    const [first, second] = await Promise.all([
      mp.claimMonthInvoice(cid, "2030-09", 4242),
      mp.claimMonthInvoice(cid, "2030-09", 4343),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1, "exactly one call wins the claim");

    const row = await db.queryOne(
      "SELECT invoice_id FROM client_month_plans WHERE client_id = ? AND month_key = '2030-09'",
      [cid]
    );
    assert.ok([4242, 4343].includes(Number(row.invoice_id)), "and the winner's invoice is the one kept");

    // A later save corrects the numbers and must not forget it was billed.
    await mp.saveMonthPlan({ clientId: cid, month: "2030-09", videos: 11, posters: 2, amount: 18000 });
    const after = await db.queryOne(
      "SELECT invoice_id, videos FROM client_month_plans WHERE client_id = ? AND month_key = '2030-09'",
      [cid]
    );
    assert.equal(Number(after.videos), 11, "the correction lands");
    assert.ok(after.invoice_id, "and the month is still marked as billed");
    assert.equal(
      await mp.claimMonthInvoice(cid, "2030-09", 9999),
      false,
      "so nothing can bill it a second time"
    );
    ok("one invoice per month, whatever happens to the save button");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * Clearing it hands the month back to the contract
 * ------------------------------------------------------------------ */
{
  await clean();
  const cid = await client();
  try {
    await mp.saveMonthPlan({ clientId: cid, month: "2030-09", videos: 12, posters: 2, amount: 19200 });
    await mp.clearMonthPlan(cid, "2030-09");
    const plan = await tp.monthPlan(cid, "2030-09");
    assert.equal(plan.videoTarget, 8, "the contract answers again");
    assert.equal(plan.agreed, null);
    ok("a month can be handed back to the contract");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * Bad input never reaches the table
 * ------------------------------------------------------------------ */
{
  await clean();
  const cid = await client();
  try {
    assert.equal(await mp.saveMonthPlan({ clientId: cid, month: "2030-13", videos: 1, posters: 0, amount: 1 }), false, "month 13 is not a month");
    assert.equal(await mp.saveMonthPlan({ clientId: cid, month: "sept", videos: 1, posters: 0, amount: 1 }), false, "nor is a word");
    assert.equal(await mp.monthPlanFor(cid, "2030-00"), null, "and reading one is refused too");

    // Negative counts and amounts are floored rather than stored, because a
    // month owing -3 videos would read as a surplus on the progress bar.
    await mp.saveMonthPlan({ clientId: cid, month: "2030-09", videos: -5, posters: -1, amount: -100 });
    const row = await mp.monthPlanFor(cid, "2030-09");
    assert.equal(row.videos, 0);
    assert.equal(row.posters, 0);
    assert.equal(row.amount, 0);
    ok("a month key is validated and a negative count never becomes a target");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * There is one implementation of raising an invoice
 * ------------------------------------------------------------------ */
{
  const payments = read("app/(app)/payments/actions.ts");
  const plan = read("app/(app)/clients/[id]/plan-actions.ts");

  assert.ok(payments.includes("raiseInvoice({"), "the Payments form raises invoices through it");
  assert.ok(plan.includes("raiseInvoice({"), "and so does the month plan");

  /*
   * The numbering is the reason this had to be shared. `invoice_no` is derived
   * from a count of existing invoices, so a second copy of that logic mints
   * `INV-2026-0007` twice on the same day.
   */
  assert.ok(
    !payments.includes("SELECT COUNT(*) AS n FROM invoices WHERE invoice_no LIKE ?"),
    "the form no longer carries its own copy of the numbering"
  );
  const invoicing = read("lib/invoicing.ts");
  assert.ok(
    invoicing.includes("SELECT COUNT(*) AS n FROM invoices WHERE invoice_no LIKE ?"),
    "which lives in one place"
  );
  assert.ok(
    invoicing.includes("await transaction(async (conn)"),
    "inside the transaction that writes the row it numbers"
  );

  /*
   * And the invoice is raised before the claim is taken. A crash between the
   * two leaves an invoice that exists and a month that will try again — a
   * duplicate somebody can void, rather than a client billed for a month the
   * portal believes it never billed.
   */
  const raiseAt = plan.indexOf("const raised = await raiseInvoice({");
  const claimAt = plan.indexOf("await claimMonthInvoice(");
  assert.ok(raiseAt > 0 && claimAt > raiseAt, "raise first, claim second");
  ok("one way to raise an invoice, and the failure between the steps is the safe one");
}

await finish(pass);
