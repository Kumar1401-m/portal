/**
 * The night shift.
 *
 * This one writes into people's notification bell without being asked, which
 * makes its failure modes different from everything else here: not a wrong
 * number on a page somebody chose to open, but a message arriving at 6am. So
 * what is checked is mostly restraint — that it sends few, that it does not
 * repeat itself, and that it never says something it cannot show the figures
 * for.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const db = await load("lib/db.ts");
const D = await load("lib/decisions.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  /*
   * Today's decisions, not just this test's fixtures.
   *
   * The cap is a day's worth across the whole install, so a run left over from
   * five minutes ago has already spent it and this file would test nothing.
   * Scoped to the two AI types and to today, so nothing a person was sent
   * about their own work is touched.
   */
  await db.execute(
    "DELETE FROM notifications WHERE type IN ('ai_decision','ai_brief') AND created_at >= CURDATE()"
  );
  await db.execute("DELETE FROM notifications WHERE title LIKE 'ZZ-DEC%' OR title LIKE '%ZZ dec client%'");
  await db.execute(
    "DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_no LIKE 'ZZ-DEC%')"
  );
  await db.execute("DELETE FROM invoices WHERE invoice_no LIKE 'ZZ-DEC%'");
  await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ-DEC %'");
  await db.execute("DELETE FROM clients WHERE company_name = 'ZZ dec client'");
};
await clean();

/* ---------------- it finds the things worth finding ---------------- */
{
  const clientId = Number(
    (await db.execute(
      "INSERT INTO clients (company_name, status, monthly_deliverables) VALUES ('ZZ dec client','active',8)"
    )).insertId
  );

  const before = await D.candidates();
  const mine = (list) => list.filter((d) => /ZZ dec client|ZZ-DEC/.test(d.title));

  // A client on the floor with a monthly commitment and an empty board is the
  // quietest failure the agency has: nobody notices until the month is over.
  const empty = mine(before).find((d) => /Nothing planned/.test(d.title));
  assert.ok(empty, "an empty month is noticed");
  assert.match(empty.body, /8 pieces/, "and says what they are owed");
  assert.match(empty.link, /\/studio\?client=\d+/, "with somewhere to go and fix it");

  // Money that should have arrived.
  const invoiceId = Number(
    (await db.execute(
      `INSERT INTO invoices (invoice_no, client_id, amount, tax, processing_fee, total, status,
                             issue_date, due_date, period_month)
       VALUES ('ZZ-DEC-1', ?, 30000, 0, 0, 30000, 'sent', DATE_SUB(CURDATE(), INTERVAL 40 DAY),
               DATE_SUB(CURDATE(), INTERVAL 25 DAY), DATE_FORMAT(CURDATE(),'%Y-%m'))`,
      [clientId]
    )).insertId
  );
  assert.ok(invoiceId > 0);

  const withMoney = await D.candidates();
  const overdue = mine(withMoney).find((d) => /ZZ-DEC-1/.test(d.title));
  assert.ok(overdue, "an overdue invoice is noticed");
  assert.match(overdue.body, /₹30,000/, "with the amount");
  assert.match(overdue.body, /25 days past due/, "and how late it is");
  assert.equal(overdue.source, "money");

  // Twenty-five days late and thirty thousand rupees outranks a planning gap.
  assert.ok(overdue.urgency > empty.urgency, "money that is late outranks a month not yet planned");

  // The list is ordered, because only the top few are ever sent.
  const urgencies = withMoney.map((d) => d.urgency);
  assert.deepEqual(urgencies, [...urgencies].sort((a, b) => b - a), "most urgent first");
  ok("it reads the boards: money late, work late, a month with nothing in it");
}

/* ---------------- the title carries no figures, so it can be claimed ---------------- */
{
  const all = await D.candidates();
  for (const d of all) {
    /*
     * A decision is claimed by its title for a week. If the title carried the
     * amount or the day count, tomorrow's title would differ from today's by
     * one digit and the same news would arrive every morning — which is how
     * somebody learns to ignore the bell.
     */
    assert.ok(
      !/₹|\d+ days?|\d+ tasks?/.test(d.title),
      `"${d.title}" has a changing figure in it, so it will be sent again tomorrow`
    );
    assert.ok(d.title.length <= 190, "and fits the column it is claimed in");
    assert.ok(d.body && d.link, "every decision says why and where to go");
    assert.ok(d.urgency > 0 && d.urgency <= 100, `urgency ${d.urgency} is out of range`);
  }
  ok("titles are stable and bodies carry the figures, so the same news is said once");
}

/* ---------------- it sends few, and never twice ---------------- */
{
  const src = read("lib/decisions.ts");
  assert.equal(D.MAX_PER_RUN, 3, "three a night, hard");

  const first = await D.runDecisions();
  assert.ok(first.sent.length > 0, "something went out");
  assert.ok(first.sent.length <= D.MAX_PER_RUN, `sent ${first.sent.length}, more than the cap`);

  const rows = await db.query(
    "SELECT title FROM notifications WHERE type = 'ai_decision' AND created_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE)"
  );
  assert.ok(rows.length > 0, "and it reached the notification bell");

  /*
   * The whole point: a second run the same day says nothing. Capping per run
   * instead of per day meant pressing the button three times put nine things
   * in everybody's bell — correct for a nightly job, wrong for a button.
   */
  const second = await D.runDecisions();
  assert.equal(second.sent.length, 0, "a second run the same day sends nothing");
  assert.ok(second.skipped > 0, "and says how much it held back");

  // Which is enforced by the query, not by luck.
  assert.match(src, /type = 'ai_decision' AND title = \?/, "the claim is the title");
  assert.match(src, /INTERVAL \? DAY/, "for a window, not for ever");
  ok("three a night at most, and a second run the same day sends nothing");
}

/* ---------------- the ranking is arithmetic, the model only narrates ---------------- */
{
  const src = read("lib/decisions.ts");

  /*
   * The house rule, and the reason this can be trusted to run unattended: a
   * model asked "what matters most" answers confidently and differently every
   * night, and an agency cannot plan against that.
   */
  assert.match(src, /Do not re-rank them/, "the model is told not to reorder");
  assert.match(src, /do not invent a number/, "nor to add figures");
  // The import is at the top; what matters is that nothing CALLS it before the
  // brief — every candidate and every urgency is computed from rows.
  assert.ok(
    !/callJSON\(/.test(src.slice(0, src.indexOf("export async function brief"))),
    "a candidate is gathered or scored by a model somewhere above the brief"
  );

  // And with no model at all it still runs, because the line has a fallback.
  assert.match(src, /const plain =/, "the summary writes itself when there is no model");

  const api = readFileSync(`${SRC}/app/api/automation/decisions/route.ts`, "utf8");
  assert.match(api, /guard\(request\)/, "the endpoint is behind the automation key");
  assert.match(api, /recordRun\(\s*"ai_decisions"/, "and leaves a heartbeat");

  const actions = read("app/(app)/ai/actions.ts");
  assert.match(actions, /requireUser\(ADMIN_ROLES\)/, "running it by hand is admin only");
  ok("what gets sent is decided by arithmetic; the model only writes the sentence");
}

await clean();
await finish(pass);
