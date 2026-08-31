/**
 * What the client sees about their own ads — and what they must never see.
 *
 * A client is owed the outcome: how many people saw it, how many clicked, how
 * many watched, how many went and looked at the profile, how many got in
 * touch. What the agency paid Meta is the agency's business — a negotiated
 * rate that differs between clients, and the fastest way to turn a results
 * conversation into a pricing argument.
 *
 * ## Absent, not hidden
 *
 * The strongest form of that rule is the one being tested: spend never leaves
 * the database. A column fetched and then not rendered is one careless spread
 * away from a client's screen, and the diff that does it looks harmless. Cost
 * per lead and CPM are gone for the same reason — both are spend wearing a
 * different hat, and either one beside a lead count gives the spend back by
 * arithmetic.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");

/*
 * A file with its comments stripped.
 *
 * The ads page carries long notes explaining why each figure is on it or off
 * it, and a test that matched the explanation would be pushing somebody to
 * delete the reasoning to get green — which is how a rule like the one below
 * quietly stops being understood and then stops being kept.
 */
const codeOf = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);
const ads = await import(pathToFileURL(`${SRC}/lib/ads.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * The money never leaves the database
 * ------------------------------------------------------------------ */
{
  const src = read("lib/ads.ts");
  const fn = src.slice(src.indexOf("export async function clientAdsSummary"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  assert.ok(!/spend/i.test(body), "clientAdsSummary does not so much as name spend");
  assert.ok(!/currency/i.test(body), "nor a currency, which only money needs");
  assert.ok(!/costPerLead|cost_per_lead|cpm/i.test(body), "and no figure spend can be recovered from");

  const code = codeOf("app/portal/ads/page.tsx");
  assert.ok(!/spend|₹|money\(|cost/i.test(code), "and the page renders no money either");
  assert.ok(!code.includes("adPerformance("), "it does not reach for the admin reader by mistake");
  assert.ok(code.includes("clientAdsSummary("), "it uses the money-free one");
  ok("spend is absent from the client's ads page, not merely unrendered");
}

/* ------------------------------------------------------------------ *
 * A dash is not a nought
 * ------------------------------------------------------------------ */
if (!(await db.hasTable("ad_performance"))) {
  console.log("  --  ad_performance not applied here; the read-back needs it");
} else {
  const clean = async () => {
    await db.execute("DELETE FROM ad_performance WHERE ad_id LIKE 'ZZcp%'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ portal ads'");
  };
  await clean();

  const clientId = (
    await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ portal ads', 'active')")
  ).insertId;

  const extra = await db.hasColumn("ad_performance", "profile_visits");
  const put = (adId, date, name, impressions, clicks, leads, views, visits) =>
    db.execute(
      `INSERT INTO ad_performance
         (client_id, ad_id, date, ad_name, campaign_name, spend, currency,
          impressions, reach, clicks, leads${extra ? ", video_views, profile_visits" : ""})
       VALUES (?,?,?,?,'ZZ camp',9999,'INR',?,0,?,?${extra ? ",?,?" : ""})`,
      extra
        ? [clientId, adId, date, name, impressions, clicks, leads, views, visits]
        : [clientId, adId, date, name, impressions, clicks, leads]
    );

  // Spend is deliberately 9999 on every row: if it ever reaches the client
  // view it will be unmissable rather than plausible.
  await put("ZZcp-1", "2026-08-20", "ZZ reel", 1000, 30, 1, 400, 12);
  await put("ZZcp-1", "2026-08-21", "ZZ reel", 1000, 20, 1, 350, 8);
  // An account where Meta never reported profile visits.
  await put("ZZcp-2", "2026-08-21", "ZZ static", 500, 5, 0, null, null);
  // Never shown to anybody — Meta returns the row, it just has nothing in it.
  await put("ZZcp-3", "2026-08-21", "ZZ unshown", 0, 0, 0, null, null);

  const out = await ads.clientAdsSummary(clientId, "2026-08-01", "2026-08-31");

  assert.equal(out.ads.length, 2, "an ad nobody was shown is not a row");
  assert.deepEqual(out.ads.map((a) => a.adId), ["ZZcp-1", "ZZcp-2"], "most-seen first");

  const reel = out.ads[0];
  assert.equal(reel.impressions, 2000, "the days are added up");
  assert.equal(reel.clicks, 50);
  assert.equal(Number(reel.ctr.toFixed(2)), 2.5, "and the click rate follows from them");
  assert.equal(reel.leads, 2);

  // Nothing that could be turned back into spend.
  assert.ok(!("spend" in reel), "no spend on the row");
  assert.ok(!("costPerLead" in reel), "and no cost per lead");

  if (extra) {
    assert.equal(reel.videoViews, 750, "video views add up");
    assert.equal(reel.profileVisits, 20, "so do profile visits");

    /*
     * The one that must not become a zero. Meta names Instagram profile visits
     * differently across accounts and API versions, and does not report every
     * action type at all. A confident "0 profile visits" tells a client their
     * ad was ignored, when the truth is that we do not have the figure.
     */
    assert.equal(out.ads[1].profileVisits, null, "an unreported figure stays null");
    assert.equal(out.ads[1].videoViews, null);

    // And a total made only of nulls is null, not the sum of nothing.
    const quiet = await ads.clientAdsSummary(clientId, "2026-08-21", "2026-08-21");
    assert.equal(
      quiet.ads.find((a) => a.adId === "ZZcp-2").profileVisits,
      null,
      "still null on its own"
    );
  }

  assert.equal(out.totals.ads, 2, "the count is ads that ran, not ads that exist");
  assert.equal(out.totals.impressions, 2500);
  ok("the client's own figures add up, and a figure Meta never sent stays a dash");

  await clean();
}

/* ------------------------------------------------------------------ *
 * The tab only exists for clients it is about
 * ------------------------------------------------------------------ */
{
  const header = read("app/portal/portal-header.tsx");
  assert.ok(header.includes("hasAds ? [{ label: \"Ads\""), "the tab is conditional");

  /*
   * Most clients here are content only. A tab that always opens on "no ads ran
   * in this period" teaches the client that the portal is half-built, which
   * costs more than the tab is worth.
   */
  const layout = read("app/portal/layout.tsx");
  assert.ok(layout.includes('hasTable("ad_performance")'), "guarded on an unapplied database");
  assert.ok(layout.includes("LIMIT 1"), "and answered with one row, on every page in the portal");
  ok("the Ads tab appears for clients who have had ads, and nobody else");
}


/* ------------------------------------------------------------------ *
 * Accounts reached is a real figure, not impressions renamed
 * ------------------------------------------------------------------ */
{
  /*
   * The easy version of this was to relabel impressions, and it would have
   * been wrong every time: reach is people, impressions are times shown. On
   * the account this was built against, 103 impressions were 99 people.
   *
   * Reach cannot be produced by any arithmetic we can do. The daily column
   * cannot be summed — the same person on two days is one person — and the
   * per-ad figures cannot be summed either, because two ads reaching
   * overlapping audiences do not add. Only Meta deduplicates it.
   */
  const src = read("lib/ads.ts");
  assert.ok(src.includes("fields=reach&level=account"), "reach is asked for at account level");
  assert.ok(!/SUM\(reach\)|SUM\(p\.reach\)/.test(src), "and is never summed");
  assert.ok(
    src.includes("reach_window_days"),
    "and is stored with the number of days it covers"
  );

  const page = read("app/portal/ads/page.tsx");
  assert.ok(page.includes("Accounts reached"), "the client sees it named as people");
  /*
   * When there is a figure it is shown with the period it covers, and when
   * there is none the card says so. What it never does is fall back to
   * impressions — the number that is easy to get and means something else.
   *
   * Requiring the range to match the sync window exactly left this card as a
   * dash for ever: Meta deduplicates over 28 days and the page defaults to a
   * calendar month, so a real figure was being thrown away over three days.
   */
  assert.ok(page.includes("Real people, over the last"), "the period is stated beside it");
  assert.ok(
    page.includes("Not counted yet"),
    "and having no figure at all is said, not filled in with impressions"
  );
  /*
   * Impressions were demoted first and then taken off the page entirely — see
   * the block at the end of this file. Reach is what stands in the headline
   * now, and it is a different number, not the same one relabelled.
   */
  ok("accounts reached is Meta's deduplicated count, and impressions are not dressed up as it");
}


/* ------------------------------------------------------------------ *
 * Impressions are shown, under their own name
 * ------------------------------------------------------------------ */
{
  /*
   * They were taken off this page once and asked back on, and both asks were
   * about the same thing: the label. "Times shown" is the biggest number here
   * and reads as a count of people — 538 against 99 people is one audience
   * shown the ad five times, and the card immediately after it is the real
   * people count. Called impressions and set beside accounts reached, the
   * pair says what it is.
   *
   * So the figure is shown and the old label is not, and it is money that
   * stays absent — that rule is tested at the top of this file and is a
   * different kind of rule entirely.
   */
  const shown = codeOf("app/portal/ads/page.tsx");

  assert.ok(!/Times shown|times shown/.test(shown), "the label that reads as people is gone");
  assert.ok(shown.includes("num(t.impressions)"), "the total is rendered");
  assert.ok(shown.includes("num(a.impressions)"), "and so is the per-ad figure");

  /*
   * Everything is in the order it happens, impressions first: appeared,
   * reached, engaged, clicked, visited, enquired. The drop between two steps
   * is the interesting part of this page, and it only reads as a drop if the
   * steps are in order.
   */
  const steps = [
    "Impressions",
    "Accounts reached",
    "Engagement",
    "Clicks",
    "Profile visits",
    "Enquiries",
  ];
  for (const step of [...steps, "Click rate"]) {
    assert.ok(shown.includes(step), `${step} is on the page`);
  }
  const order = steps.map((k) => shown.indexOf(k));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the cards are a funnel, in order");

  // The caption may name the column it sorts on, now that it is on screen.
  assert.ok(shown.includes("Most-seen first"), "the ordering is explained by a visible column");
  ok("impressions are shown as impressions, and the funnel reads in order");
}

await finish(pass);
