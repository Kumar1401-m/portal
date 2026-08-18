/**
 * The ad board's numbers.
 *
 * "Accurate" is the requirement, so these are the ways a spend board lies:
 * counting one lead three times, dividing by zero and calling it cheap,
 * adding rupees to dollars, showing an unconnected client as ₹0, and freezing
 * a figure Meta later restated. One test each.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const db = await load("lib/db.ts");
const ads = await load("lib/ads.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const TAGS = ["ZZ ads one", "ZZ ads two", "ZZ ads quiet", "ZZ ads unconnected"];
const clean = async () => {
  await db.execute(
    "DELETE FROM ad_insights WHERE client_id IN (SELECT id FROM clients WHERE company_name LIKE 'ZZ ads %')"
  );
  await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ ads %'");
};
await clean();

const mkClient = async (name, account) =>
  Number(
    (await db.execute(
      "INSERT INTO clients (company_name, status, meta_ad_account_id) VALUES (?, 'active', ?)",
      [name, account]
    )).insertId
  );
const one = await mkClient(TAGS[0], "act_1111111111");
const two = await mkClient(TAGS[1], "act_2222222222");
await mkClient(TAGS[2], "act_3333333333"); // connected, no spend
await mkClient(TAGS[3], null); // no account at all

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const insert = (clientId, date, spend, currency, impressions, clicks, leads) =>
  db.execute(
    `INSERT INTO ad_insights (client_id, date, spend, currency, impressions, reach, clicks, leads)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE spend = VALUES(spend), impressions = VALUES(impressions),
       clicks = VALUES(clicks), leads = VALUES(leads)`,
    [clientId, date, spend, currency, impressions, Math.round(impressions * 0.7), clicks, leads]
  );

/* ---------------- one lead is one lead ---------------- */
{
  // Meta reports the same form fill under several action types at once.
  // Adding them turns 12 leads into 36 and a ₹100 lead into ₹33.
  const overlapping = [
    { action_type: "post_engagement", value: "400" },
    { action_type: "lead", value: "12" },
    { action_type: "offsite_conversion.fb_pixel_lead", value: "12" },
    { action_type: "onsite_conversion.lead_grouped", value: "12" },
  ];
  assert.equal(ads.leadsFromActions(overlapping), 12, "overlapping action types are not summed");

  assert.equal(
    ads.leadsFromActions([{ action_type: "lead", value: "5" }]),
    5,
    "the plain type is used when it is the only one"
  );
  assert.equal(ads.leadsFromActions([{ action_type: "link_click", value: "99" }]), 0,
    "a click is not a lead");
  assert.equal(ads.leadsFromActions(undefined), 0, "no actions at all is zero, not a crash");
  assert.equal(ads.leadsFromActions([{ action_type: "lead", value: "-3" }]), 0, "never negative");
  ok("one form fill counts once, however many ways Meta reports it");
}

/* ---------------- the account id is accepted however it is pasted ---------------- */
{
  assert.equal(ads.normaliseAccountId("act_1234567890"), "act_1234567890");
  assert.equal(ads.normaliseAccountId("1234567890"), "act_1234567890", "the prefix is added");
  assert.equal(ads.normaliseAccountId(" act_ 1234567890 "), "act_1234567890", "spaces go");
  assert.equal(ads.normaliseAccountId("ACT_1234567890"), "act_1234567890");
  assert.equal(ads.normaliseAccountId("not an id"), null, "and nonsense is refused, not stored");
  assert.equal(ads.normaliseAccountId(""), null);
  assert.equal(ads.normaliseAccountId(null), null);
  ok("an ad account id is normalised however it was copied out of Ads Manager");
}

/* ---------------- the totals, and what they refuse to do ---------------- */
{
  await insert(one, day(2), 1000, "INR", 50000, 500, 10);
  await insert(one, day(1), 500, "INR", 25000, 250, 0);
  await insert(two, day(1), 2000, "INR", 80000, 900, 40);

  const s = await ads.adSummary(day(7), day(0));
  const rowOne = s.rows.find((r) => r.company === TAGS[0]);
  const rowTwo = s.rows.find((r) => r.company === TAGS[1]);

  assert.equal(rowOne.spend, 1500, "a client's days are summed");
  assert.equal(rowOne.impressions, 75000);
  assert.equal(rowOne.leads, 10);
  assert.equal(rowOne.costPerLead, 150, "₹1500 over 10 leads is ₹150 each");
  assert.equal(rowTwo.costPerLead, 50);

  // Biggest spender first — the money is what the board is opened for.
  assert.equal(s.rows[0].company, TAGS[1], "sorted by spend");

  assert.equal(s.totals.leads, 50);
  assert.equal(s.totals.impressions, 155000);
  assert.equal(s.totals.costPerLead, 70, "₹3500 over 50 leads — not the average of 150 and 50");
  ok("cost per lead is spend over leads, never an average of averages");
}

/* ---------------- no leads is not a cheap lead ---------------- */
{
  const s = await ads.adSummary(day(1), day(1));
  const rowOne = s.rows.find((r) => r.company === TAGS[0]);
  assert.equal(rowOne.leads, 0);
  assert.equal(rowOne.spend, 500);
  assert.equal(rowOne.costPerLead, null, "₹500 and no leads is not ₹0 a lead");
  ok("cost per lead with no leads is null, not zero");
}

/* ---------------- rupees are never added to dollars ---------------- */
{
  await insert(two, day(3), 40, "USD", 5000, 60, 4);
  const s = await ads.adSummary(day(7), day(0));

  assert.equal(s.totals.spendByCurrency.length, 2, "both currencies are reported");
  const inr = s.totals.spendByCurrency.find((c) => c.currency === "INR");
  const usd = s.totals.spendByCurrency.find((c) => c.currency === "USD");
  assert.ok(inr && usd, "each on its own");
  assert.equal(
    s.totals.costPerLead,
    null,
    "and there is no single cost per lead when there is no single currency"
  );
  assert.equal(s.totals.currency, null);
  await db.execute("DELETE FROM ad_insights WHERE client_id = ? AND currency = 'USD'", [two]);
  ok("two currencies are never added into one total");
}

/* ---------------- missing is not zero ---------------- */
{
  const s = await ads.adSummary(day(7), day(0));
  const shown = s.rows.map((r) => r.company);
  assert.ok(!shown.includes(TAGS[2]), "a connected client with no spend is not a ₹0 row");
  assert.ok(s.connectedButQuiet.includes(TAGS[2]), "it is listed as quiet instead");
  assert.ok(!shown.includes(TAGS[3]), "and neither is one with no ad account");
  assert.ok(s.notConnected.includes(TAGS[3]), "which is listed as not connected");
  ok("absence is explained rather than rendered as zero spend");
}

/* ---------------- a restated day corrects itself ---------------- */
{
  // Meta revises conversions for up to 28 days. The upsert key is what lets
  // the second pull replace the first instead of doubling it.
  await insert(one, day(2), 1000, "INR", 50000, 500, 10);
  await insert(one, day(2), 1000, "INR", 50000, 500, 14); // Meta now says 14
  const s = await ads.adSummary(day(2), day(2));
  const rowOne = s.rows.find((r) => r.company === TAGS[0]);
  assert.equal(rowOne.leads, 14, "the later figure wins");
  assert.equal(rowOne.spend, 1000, "and the day is not counted twice");

  const [count] = await db.query(
    "SELECT COUNT(*) AS n FROM ad_insights WHERE client_id = ? AND date = ?",
    [one, day(2)]
  );
  assert.equal(Number(count.n), 1, "one row per client per day");
  assert.equal(ads.RESTATEMENT_DAYS, 28, "and the sync window reaches back far enough to catch it");
  ok("a figure Meta restates is corrected, not duplicated");
}

/* ---------------- the range is what it says ---------------- */
{
  const { resolveRange } = await load("lib/date-range.ts");
  const today = new Date().toISOString().slice(0, 10);

  const month = resolveRange("this_month");
  assert.match(month.from, /^\d{4}-\d{2}-01$/, "this month starts on the 1st");
  assert.equal(month.to, today);

  const seven = resolveRange("last_7");
  assert.equal(seven.to, today);
  assert.equal(seven.from, day(6), "last 7 days includes today, so it reaches back 6");

  const last = resolveRange("last_month");
  assert.ok(last.to < month.from, "last month ends before this month begins — no overlap");
  assert.match(last.from, /^\d{4}-\d{2}-01$/);

  // A hand-typed range is honoured, and backwards dates are swapped rather
  // than returning nothing.
  const custom = resolveRange(undefined, "2026-03-31", "2026-03-01");
  assert.deepEqual([custom.from, custom.to], ["2026-03-01", "2026-03-31"]);
  assert.equal(resolveRange("nonsense").key, "this_month", "an unknown range falls back");
  ok("every range resolves to the dates its label claims");
}

/* ---------------- one client, with the details to ring them about ---------------- */
{
  const d = await ads.clientAdDetail(one, day(7), day(0));
  assert.ok(d, "the client is found");
  assert.equal(d.client.company, TAGS[0]);
  assert.equal(d.client.accountId, "act_1111111111", "their ad account comes with the numbers");
  assert.ok("contactPerson" in d.client && "phone" in d.client && "email" in d.client,
    "and so does who to ring — the reason this page exists rather than a filter");

  assert.equal(d.days.length, 2, "a row per day that has data");
  assert.equal(d.days[0].date, day(1), "newest first");
  assert.equal(d.totals.spend, 1500);
  assert.equal(d.totals.leads, 14, "the restated figure, not the original 10");
  assert.equal(d.totals.costPerLead, 1500 / 14);
  assert.equal(d.totals.activeDays, 2);

  // A day that spent money for no leads has no cost per lead to rank, and
  // must never be ranked as the cheapest.
  const zeroLeadDay = d.days.find((x) => x.leads === 0);
  assert.ok(zeroLeadDay, "there is such a day in the fixture");
  assert.equal(zeroLeadDay.costPerLead, null);
  if (d.best) {
    assert.notEqual(d.best.date, zeroLeadDay.date, "and it is not the cheapest lead");
    assert.ok(d.best.costPerLead > 0);
  }
  ok("a client's own page carries their days, their totals and who to call");

  const missing = await ads.clientAdDetail(999999999, day(7), day(0));
  assert.equal(missing, null, "an unknown client is null rather than an empty-looking page");

  // Connected but silent, and not connected at all, are different pages.
  const quiet = await ads.clientAdDetail(
    Number((await db.queryOne("SELECT id FROM clients WHERE company_name = ?", [TAGS[2]])).id),
    day(7),
    day(0)
  );
  assert.equal(quiet.totals, null, "no data means no totals, not zeroes");
  assert.ok(quiet.client.accountId, "though the account is still connected");

  const unconnected = await ads.clientAdDetail(
    Number((await db.queryOne("SELECT id FROM clients WHERE company_name = ?", [TAGS[3]])).id),
    day(7),
    day(0)
  );
  assert.equal(unconnected.client.accountId, null, "and one with no account says so");
  ok("no data and no account are told apart, so the page can say which");
}

/* ---------------- a crm cannot open a client they were not given ---------------- */
{
  const page = readFileSync(`${SRC}/app/(app)/ads/[id]/page.tsx`, "utf8");
  assert.match(
    page,
    /if \(!\(await canAccessClient\(user, clientId\)\)\) notFound\(\)/,
    "the per-client page applies the same crm gate as the rest of the portal"
  );
  assert.match(page, /requireUser\(ADMIN_OR_CRM_ROLES\)/);
  ok("the client ad page is behind the same access check as every other client screen");
}

/* ---------------- a Page token is never used to read ads ---------------- */
{
  /*
   * The bug behind "(#200) Ad account owner has NOT grant ads_read".
   *
   * The sync fell back to `ig_access_token`, which is a Page token. A Page
   * token cannot read an ad account whatever permissions are granted to it,
   * so the request was certain to fail — and Meta's message points at the ad
   * account, sending everyone to ask the client for a permission that was
   * never the problem.
   */
  // Code, not prose: the comment above the fix names the old column on
  // purpose, and a blanket search would forbid explaining the bug.
  const lib = readFileSync(`${SRC}/lib/ads.ts`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.ok(
    !/ig_access_token/.test(lib),
    "the ad sync must not read the Page token — it can never read spend"
  );
  assert.match(lib, /ads_access_token/, "it uses the client's own ads token");
  assert.match(lib, /env\.meta\.adsAccessToken/, "or the agency's, which is a separate setting");

  const envSrc = readFileSync(`${SRC}/lib/env.ts`, "utf8");
  assert.match(envSrc, /META_ADS_ACCESS_TOKEN/, "and that setting exists");
  ok("reading spend uses an ads token, never the Page token that cannot do it");

  // With no ads token at all, the failure says what kind of token is needed
  // rather than blaming the ad account.
  const r = await ads.syncClientAds(one, 7);
  assert.equal(r.ok, false);
  if (/No ads token/.test(r.error || "")) {
    assert.match(r.hint || "", /ads_read/, "and it names the permission");
    assert.match(r.hint || "", /Page token cannot/i, "and rules out the wrong one");
    ok("a missing ads token says which kind of token is missing");
  } else {
    ok(`an ads token is configured locally, so the call reached Meta (${r.error})`);
  }
}

/* ---------------- every Meta refusal comes with its fix ---------------- */
{
  // The exact error from the screenshot.
  const real =
    "(#200) Ad account owner has NOT grant ads_management or ads_read permission, refer to " +
    "https://developers.facebook.com/docs/marketing-api/get-started/authorization/";
  const fix = ads.fixFor(200, real);
  assert.ok(fix, "#200 has a fix");
  assert.match(fix, /System User/, "which is where the right token comes from");
  assert.match(fix, /ads_read/);
  assert.match(fix, /Page or Instagram token will never work/i, "and rules out the wrong one");

  assert.match(ads.fixFor(190, "Error validating access token") || "", /expired|revoked/i);
  assert.match(
    ads.fixFor(100, "Unsupported get request. Object with ID act_1 does not exist") || "",
    /not the Page id/i,
    "a wrong id is told apart from a wrong token"
  );
  assert.match(ads.fixFor(17, "User request limit reached") || "", /rate limit/i);
  assert.match(ads.fixFor(4, "Application request limit reached") || "", /Nothing to fix/i,
    "and a rate limit is explicitly not something to go and fix");
  assert.equal(ads.fixFor(999, "Something new"), undefined, "an unknown code invents nothing");

  // Matched on the message too, since Meta reuses codes across products.
  assert.ok(ads.fixFor(undefined, "requires ads_read permission"), "the wording alone is enough");
  ok("each Meta refusal is paired with what to actually do about it");

  /*
   * "#200 Missing Permissions" is two different problems wearing one message:
   * the token lacks the ads_read scope, or it has it and its owner was never
   * given the ad account. The fixes are unrelated, so the portal asks the
   * token which one it is rather than guessing.
   */
  const lib2 = readFileSync(`${SRC}/lib/ads.ts`, "utf8");
  assert.match(lib2, /debug_token/, "it asks Meta what the token can do");
  assert.match(
    lib2,
    /if \(code === 200 \|\| code === 10 \|\| code === 272\) \{[\s\S]{0,200}tokenScopes\(token\)/,
    "but only after a permission error — never on the happy path"
  );
  assert.match(lib2, /This token has no ads_read permission — its scopes are/,
    "a missing scope names the scopes it does have");
  // The step before that, and the one that actually stops people: the token
  // generator only offers scopes for products the app has, so with no
  // Marketing API there is nothing to tick and no explanation on the screen.
  assert.match(lib2, /has not got the Marketing API product yet/,
    "and it says why ads_read might not be offered at all");
  assert.match(lib2, /so the scope is not the problem/,
    "and a token that has the scope is told the assignment is what is missing");
  ok("a permission error is diagnosed against the real token, not guessed at");

  const button = readFileSync(`${SRC}/app/(app)/ads/sync-button.tsx`, "utf8");
  assert.match(button, /f\.hint/, "and the dialog shows it beside Meta's own words");
  assert.match(button, /ack: true/, "and holds the screen, because it is a to-do");
  ok("the fix appears in the failure dialog, not only in a log");
}

/* ---------------- nothing on the board was typed by anyone ---------------- */
{
  const lib = readFileSync(`${SRC}/lib/ads.ts`, "utf8");
  assert.match(lib, /time_increment=1/, "Meta is asked for a row per day, not one total");
  assert.match(lib, /ON DUPLICATE KEY UPDATE/, "and each day is upserted");
  assert.match(lib, /account_currency/, "the currency is read from the account, not assumed");

  // The board has no way to write a number, and that is the point.
  const page = readFileSync(`${SRC}/app/(app)/ads/page.tsx`, "utf8");
  assert.ok(!/<Input|<input/.test(page), "the board has no field to type a figure into");
  assert.match(page, /straight from Meta/, "and it says where the numbers came from");
  assert.match(page, /last refreshed/, "and when they were last checked");

  const wf = JSON.parse(readFileSync(`${SRC}/../../n8n/workflows/ads-sync.json`, "utf8"));
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, spec] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), `${from} exists`);
    for (const b of spec.main) for (const c of b) assert.ok(names.has(c.node), `${c.node} exists`);
  }
  assert.ok(
    wf.nodes.some((n) => String(n.parameters?.url || "").includes("/ads/sync")),
    "the nightly workflow calls the sync endpoint"
  );
  ok("every figure comes from Meta, is dated, and refreshes itself nightly");
}

/* ---------------- the audience beside the spend ---------------- */
{
  const aud = await load("lib/audience.ts");
  const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

  const NAME = "ZZ ads audience";
  await db.execute("DELETE FROM clients WHERE company_name = ?", [NAME]);
  const id = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES (?, 'active')", [NAME]))
      .insertId
  );

  /*
   * The case that must not print a zero.
   *
   * A client with no Instagram account and no Page has an unknown audience,
   * not an audience of none — and "0 followers" next to their ad spend is a
   * number somebody would repeat to them.
   */
  assert.equal(await aud.getAudience(id), null, "nothing configured means nothing to show");

  // A Page id with no token cannot be asked, and must fail the same quiet way
  // rather than throwing into a page whose real job is the ad figures.
  await db.execute("UPDATE clients SET fb_page_id = '973697795837500' WHERE id = ?", [id]);
  assert.equal(await aud.getAudience(id), null, "and an unaskable account does too");

  await db.execute("DELETE FROM clients WHERE id = ?", [id]);

  const lib = read("lib/audience.ts");
  // One call for both numbers where the client has a Page: the linked
  // Instagram account comes back nested rather than costing a second request.
  assert.match(
    lib,
    /instagram_business_account\{username,followers_count\}/,
    "a Page and its Instagram account are read together"
  );
  // But Instagram alone still works — a client can have an IG account here
  // without their Page id ever being filled in.
  assert.match(lib, /if \(!ig && c\.ig_user_id\)/, "and Instagram alone is still asked");
  // followers_count superseded fan_count (page likes); both are requested so
  // an older API version still yields something.
  assert.match(lib, /page\.followers_count \?\? page\.fan_count/, "followers wins, likes are the fallback");
  assert.match(lib, /AbortSignal\.timeout\(6_000\)/, "and it cannot hold the page up");

  const page = read("app/(app)/ads/[id]/page.tsx");
  assert.match(page, /audience \? \(/, "the block renders only when there is something to say");
  assert.match(page, /getAudience\(clientId\),/, "fetched alongside the ad figures, not after them");
  ok("followers show per client, and their absence shows nothing rather than nought");
}

/* ---------------- and the board can be pointed at one client ---------------- */
{
  const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
  const picker = read("app/(app)/ads/client-picker.tsx");

  /*
   * "By client" already linked to each client's page, but only for a client
   * who spent something in the range on screen. A client who paused their ads
   * last month was reachable from no range that showed them — which is
   * exactly the moment somebody goes looking for them.
   */
  assert.match(picker, /<option value="">All clients<\/option>/, "and there is a way back out");
  assert.match(picker, /\/ads\/\$\{v\}\?range=\$\{range\}/, "the range travels with the client");
  assert.match(picker, /`\/ads\?range=\$\{range\}`/, "in both directions");

  for (const f of ["app/(app)/ads/page.tsx", "app/(app)/ads/[id]/page.tsx"]) {
    const src = read(f);
    assert.match(src, /<ClientPicker/, `${f} offers it`);
    // Every client, not only the ones with spend in this range.
    assert.match(src, /getClientsMini\(await crmClientIds\(user\)\)/, `${f}: scoped to what the viewer may see`);
  }
  ok("the ads board can be narrowed to one client, and back again");
}

/* ---------------- and the period is a month, by name ---------------- */
{
  const r = await load("lib/date-range.ts");
  const today = new Date().toISOString().slice(0, 10);

  /*
   * A month is how a client asks: what did July cost. The rolling ranges
   * answer "lately", which is a different question and a much harder one to
   * put beside an invoice.
   */
  const july = r.resolveRange("2026-07");
  assert.equal(july.from, "2026-07-01", "a named month starts on the 1st");
  assert.equal(july.to, "2026-07-31", "and ends on its own last day");
  assert.equal(july.key, "2026-07", "and keeps its key, so the picker stays on it");

  // Month length is not assumed. 2026 is not a leap year.
  assert.equal(r.resolveRange("2026-02").to, "2026-02-28", "February knows how long it is");
  assert.equal(r.resolveRange("2025-12").to, "2025-12-31", "and December does not roll the year");

  /*
   * A month still running stops at today. Running it to the 31st would divide
   * this month's spend by days that have not happened, and report a cost per
   * day nobody has spent.
   */
  const thisMonth = r.resolveRange(today.slice(0, 7));
  assert.equal(thisMonth.to, today, "the current month stops at today, not at its last day");

  // Nonsense falls back rather than producing an empty board that reads as a
  // month with no spend in it.
  for (const bad of ["2026-13", "2026-00", "garbage", ""]) {
    assert.equal(r.resolveRange(bad).key, "this_month", `${JSON.stringify(bad)} falls back`);
  }

  assert.equal(r.monthRangeLabel("2026-07"), "Jul 2026", "and it is named the way people say it");
  const months = r.recentMonths(3, new Date(2026, 0, 15));
  assert.deepEqual(months, ["2026-01", "2025-12", "2025-11"], "the list walks back across a year end");
  ok("the ads board reports by named month, and knows how long each one is");
}

/* ---------------- stepped with arrows, from one implementation ---------------- */
{
  const step = await load("lib/date-range.ts");
  const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

  /*
   * Through Date rather than by adding to the number, so December rolls the
   * year instead of producing month 13 — which is the whole reason this is
   * one shared component and not two copies. The ads board and the client's
   * monthly plan both step months, and a rollover bug fixed in one of two
   * copies is a rollover bug.
   */
  const cases = [
    ["2026-12", 1, "2027-01"],
    ["2026-01", -1, "2025-12"],
    ["2024-02", 1, "2024-03"],
    ["2026-08", -1, "2026-07"],
  ];
  for (const [mk, delta, want] of cases) {
    assert.equal(step.shiftMonth(mk, delta), want, `${mk} ${delta > 0 ? "+" : ""}${delta}`);
  }
  assert.equal(step.monthRangeLabel("2026-09"), "Sept 2026", "and reads as a month, not a key");

  for (const f of ["app/(app)/ads/range-picker.tsx", "app/(app)/clients/[id]/monthly-plan.tsx"]) {
    assert.match(read(f), /<MonthStepper/, `${f} uses the shared stepper`);
    assert.ok(!/ChevronLeft/.test(read(f)), `${f} has no arrows of its own left`);
  }

  // "This year" survives the change: it is the one period a month cannot say,
  // and it is what the board is opened on for a total.
  const picker = read("app/(app)/ads/range-picker.tsx");
  assert.match(picker, /This year/, "the year is still reachable");
  assert.match(picker, /aria-pressed=\{onYear\}/, "and says when it is the one showing");
  ok("months are stepped with arrows, from a single implementation");
}

await clean();
await finish(pass);
