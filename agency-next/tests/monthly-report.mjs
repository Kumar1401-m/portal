/**
 * The message a client actually receives.
 *
 * This one is generated and sent to a client's WhatsApp group, so the failure
 * that matters is not a crash — it is a confident sentence about a service
 * they never bought. A client with no ad account must not be told they spent
 * ₹0 and got 0 leads; a first month with no earlier month must not claim
 * growth of +0.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const r = await load("lib/monthly-report.ts");
const db = await load("lib/db.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const report = (o = {}) => ({
  clientId: 1,
  client: o.client ?? "ZZ Cafe",
  month: "2026-07",
  monthLabel: "July 2026",
  content: o.content ?? { planned: 12, delivered: 10, approved: 12 },
  posts: o.posts ?? null,
  audience: o.audience ?? [],
  ads: o.ads ?? null,
});

/* ---------------- a section with nothing in it is left out ---------------- */
{
  const bare = r.renderReportText(report());
  assert.match(bare, /ZZ Cafe — July 2026/, "it says who and when");
  assert.match(bare, /10 of 12 planned posts went live/);

  // The three that would otherwise be sent as zeroes.
  assert.ok(!/Performance/.test(bare), "no posts, no performance section");
  assert.ok(!/Ads/.test(bare), "a client who runs no ads is not told they spent nothing");
  assert.ok(!/Audience/.test(bare), "and no follower history is not a flat month");
  assert.ok(!/₹0|NaN|undefined|null/.test(bare), "and nothing empty leaks into the words");
  ok("a month with only content sends only the content");
}

/* ---------------- and a full month says all of it ---------------- */
{
  const full = r.renderReportText(
    report({
      posts: { count: 10, reach: 45200, interactions: 3100, topLink: "https://instagr.am/p/abc" },
      audience: [
        { platform: "instagram", followers: 5240, gained: 180 },
        { platform: "facebook", followers: 1100, gained: -12 },
      ],
      ads: { spend: 20000, currency: "INR", impressions: 300000, leads: 40 },
    })
  );

  assert.match(full, /45,200 accounts reached/, "numbers are grouped the way they are read here");
  assert.match(full, /instagr\.am\/p\/abc/, "the best post is linked, not described");
  assert.match(full, /Instagram: 5,240 followers \(\+180 this month\)/);
  // A month that went down says so. Rounding a loss up to +0 is the sort of
  // small lie that ends a client relationship when they check.
  assert.match(full, /Facebook: 1,100 followers \(-12 this month\)/);
  assert.match(full, /₹20,000 spent/);
  assert.match(full, /40 leads at ₹500 each/, "cost per lead is worked out, not left to them");
  ok("a full month reports content, performance, audience and ads");
}

/* ---------------- the two arithmetic traps in that message ---------------- */
{
  // Spend with no leads must not divide by zero and print ₹Infinity.
  const noLeads = r.renderReportText(
    report({ ads: { spend: 8000, currency: "INR", impressions: 90000, leads: 0 } })
  );
  assert.match(noLeads, /₹8,000 spent, 90,000 impressions\./);
  assert.ok(!/Infinity|NaN|each/.test(noLeads), "no leads means no cost per lead, not a broken one");

  // A platform with no earlier reading is left out of the audience section
  // rather than reported as having stood still.
  const firstMonth = r.renderReportText(
    report({ audience: [{ platform: "instagram", followers: 900, gained: null }] })
  );
  assert.ok(!/Audience/.test(firstMonth), "a first reading has no growth to report");

  assert.equal(r.monthName("2026-07"), "July 2026");
  assert.equal(r.monthName("nonsense"), "nonsense", "an unparseable month shows itself");
  ok("no division by zero, and no growth claimed from a single reading");
}

/* ---------------- and it can only be claimed once a month ---------------- */
{
  /*
   * The job runs on the 1st. Run it twice — a retry, a stuck n8n node, someone
   * pressing the button after it already fired — and every client gets two
   * copies of the same report. The outbox cannot prevent that; the unique key
   * on `scheduled_reports` can, which is why the claim goes through it.
   *
   * Checked against the real database because what is being tested is whether
   * that constraint exists here, not whether the code would use it if it did.
   */
  const clean = async () => {
    await db.execute(
      "DELETE FROM scheduled_reports WHERE client_id IN (SELECT id FROM clients WHERE company_name = 'ZZ report')"
    );
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ report'");
  };
  await clean();

  const clientId = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ report','active')"))
      .insertId
  );

  const claim = () =>
    db.execute(
      `INSERT IGNORE INTO scheduled_reports
         (client_id, period, period_start, period_end, status, summary_json)
       VALUES (?, 'monthly', '2026-07-01', '2026-07-31', 'pending', '{}')`,
      [clientId]
    );

  assert.equal((await claim()).affectedRows, 1, "the first run claims the month");
  assert.equal((await claim()).affectedRows, 0, "and the second run gets nothing to send");

  // A different month is a different claim — the guard must not freeze the job.
  const august = await db.execute(
    `INSERT IGNORE INTO scheduled_reports
       (client_id, period, period_start, period_end, status) VALUES (?, 'monthly', '2026-08-01', '2026-08-31', 'pending')`,
    [clientId]
  );
  assert.equal(august.affectedRows, 1, "next month is still sendable");

  // Sending by hand marks the same row rather than adding a second one, so the
  // batch on the 1st skips a client who has already had their report.
  await r.markReportSent(clientId, "2026-07", "ZZ group");
  const rows = await db.query(
    "SELECT status, sent_to FROM scheduled_reports WHERE client_id = ? AND period_start = '2026-07-01'",
    [clientId]
  );
  assert.equal(rows.length, 1, "still one row for July");
  assert.equal(rows[0].status, "sent");
  assert.equal(rows[0].sent_to, "ZZ group");

  await clean();
  ok("a month can be claimed once, so the job on the 1st cannot double-send");
}

await finish(pass);
