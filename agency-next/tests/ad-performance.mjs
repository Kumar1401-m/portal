/**
 * Which ad is working, and which is burning money.
 *
 * The board could not answer this and never could have. `ad_insights` holds
 * one row per client per day — the ad *account's* total — because the sync
 * asked Meta for `level=account`. There is no way to recover "which ad" from a
 * total, so the fix is a second request at `level=ad` and a second table, and
 * everything here rests on that.
 *
 * ## The judgement is the risky part
 *
 * Pausing an ad costs real money, so `rankAds` refuses more often than it
 * answers. It will not rank one ad against itself, it will not compare click
 * rates on ads nobody has seen, and it says which measure it used — "best" on
 * click rate and "best" on cost per lead are different claims, and a reader
 * who assumes the wrong one pauses the wrong ad.
 *
 * NOTE: the `level=ad` request shape is not exercised against the live Graph
 * API here — that needs a working Meta ads token and would spend the client's
 * quota. What is checked is that the ad-level pull cannot take the board down
 * with it, which is the failure that would matter.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);
const ads = await import(pathToFileURL(`${SRC}/lib/ads.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/** A row of the shape `adPerformance` returns, for the pure ranking checks. */
const ad = (adId, over) => ({
  adId,
  clientId: 1,
  client: "ZZ",
  name: adId,
  campaign: null,
  currency: "INR",
  spend: 1000,
  impressions: 1000,
  clicks: 10,
  leads: 0,
  costPerLead: null,
  ctr: 1,
  cpm: 1000,
  days: 1,
  lastDay: "2026-08-26",
  // The row widened when the table gained its Status / Reach / Views /
  // Engagement columns; a fixture that lags the type stops testing the thing.
  locations: null,
  status: null,
  engagement: null,
  videoViews: null,
  reach: null,
  ...over,
});

/* ------------------------------------------------------------------ *
 * What the client asks about, which is never the spend
 * ------------------------------------------------------------------ */
{
  const actions = [
    { action_type: "link_click", value: "17" },
    { action_type: "video_view", value: "283" },
    { action_type: "lead", value: "2" },
  ];
  const got = ads.reachedFromActions(actions);
  assert.equal(got.linkClicks, 17, "who clicked");
  assert.equal(got.videoViews, 283, "how many watched");

  /*
   * The one that must not be a zero.
   *
   * Meta does not report every action type on every account, and this one is
   * named differently across accounts and API versions — hence a list of
   * candidates rather than a string. A client shown a confident "0 profile
   * visits" would conclude the ad was ignored; the truth may be that this
   * account never reports it. Null renders as a dash, which is what we
   * actually know.
   */
  assert.equal(got.profileVisits, null, "an action Meta never sent is not zero");
  assert.equal(
    ads.reachedFromActions([{ action_type: "onsite_conversion.ig_profile_visit", value: "9" }])
      .profileVisits,
    9,
    "and is read when it is sent, whichever name it came under"
  );
  assert.equal(ads.reachedFromActions(undefined).linkClicks, null, "no actions at all is not zero");

  // Leads keep coercing to 0: every stored column and every cost-per-lead on
  // every screen has treated a missing lead figure as none since long before
  // any of this, and a nullable lead count would ripple through all of them.
  assert.equal(ads.leadsFromActions(undefined), 0, "leads stay a number");
  assert.equal(ads.leadsFromActions(actions), 2);
  ok("clicks, views and profile visits are kept — and a missing one is a dash, not a zero");
}

/* ------------------------------------------------------------------ *
 * Cost per lead settles it, when there are leads
 * ------------------------------------------------------------------ */
{
  const rows = [
    ad("cheap", { leads: 10, costPerLead: 100 }),
    ad("dear", { leads: 2, costPerLead: 500 }),
    ad("middle", { leads: 5, costPerLead: 200 }),
  ];
  const r = ads.rankAds(rows);
  assert.equal(r.by, "costPerLead", "leads exist, so leads decide it");
  assert.equal(r.best, "cheap");
  assert.equal(r.worst, "dear");

  /*
   * The one that must not happen: an ad with no leads at all is not the best.
   * `costPerLead` is null there rather than 0 precisely so it cannot sort to
   * the top of "cheapest" — a zero would read as a free lead.
   */
  const withDud = ads.rankAds([...rows, ad("nothing", { leads: 0, costPerLead: null, spend: 9000 })]);
  assert.equal(withDud.best, "cheap", "an ad with no leads never wins on cost per lead");
  assert.equal(withDud.worst, "dear", "and does not take the worst slot from a real figure");
  ok("cost per lead decides it, and no leads is not a cheap lead");
}

/* ------------------------------------------------------------------ *
 * Click rate is the fallback, and is named as one
 * ------------------------------------------------------------------ */
{
  const r = ads.rankAds([
    ad("clicky", { impressions: 5000, clicks: 250, ctr: 5 }),
    ad("dull", { impressions: 5000, clicks: 25, ctr: 0.5 }),
  ]);
  assert.equal(r.by, "ctr", "with no leads anywhere, click rate is what is left");
  assert.equal(r.best, "clicky");
  assert.equal(r.worst, "dull");

  /*
   * And only for ads that were actually delivered. Two clicks out of eleven
   * impressions is an 18% click rate and means nothing; ranked against a
   * properly delivered ad it would name the wrong winner with total
   * confidence, which is worse than declining to name one.
   */
  const noisy = ads.rankAds([
    ad("barely-shown", { impressions: 11, clicks: 2, ctr: 18.18 }),
    ad("delivered", { impressions: 5000, clicks: 100, ctr: 2 }),
  ]);
  assert.equal(noisy.by, null, "an ad nobody saw is not compared");
  assert.ok(noisy.reason, "and the screen is told why rather than shown a winner");
  assert.match(noisy.reason, new RegExp(String(ads.CTR_FLOOR)), "the reason names the floor");
  ok("click rate only decides it when the ads were actually shown");
}

/* ------------------------------------------------------------------ *
 * It refuses rather than guesses
 * ------------------------------------------------------------------ */
{
  const alone = ads.rankAds([ad("only", { impressions: 9000, ctr: 3 })]);
  assert.equal(alone.by, null, "one ad is not a comparison");
  assert.equal(alone.best, null);

  const none = ads.rankAds([]);
  assert.equal(none.by, null);
  assert.match(none.reason, /No ad data/i, "and an empty range says so");

  // One ad with leads among several without is a real answer, and does not
  // need a ranking to state it — but there is nothing to call "worst".
  const one = ads.rankAds([
    ad("winner", { leads: 4, costPerLead: 250 }),
    ad("silent", { leads: 0, costPerLead: null }),
  ]);
  assert.equal(one.best, "winner", "the only ad producing leads is the one that works");
  assert.equal(one.worst, null, "and nothing is called worst on a single data point");
  assert.ok(one.reason, "with the reason on screen");
  ok("no verdict is offered where there is nothing to compare");
}

/* ------------------------------------------------------------------ *
 * Reading it back out of the database
 * ------------------------------------------------------------------ */
if (!(await db.hasTable("ad_performance"))) {
  console.log("  --  ad_performance not applied here; the read-back needs it");
} else {
  const clean = async () => {
    await db.execute("DELETE FROM ad_performance WHERE ad_id LIKE 'ZZad%'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ ad perf'");
  };
  await clean();

  const clientId = (
    await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ ad perf', 'active')")
  ).insertId;

  const put = (adId, date, name, spend, impressions, clicks, leads) =>
    db.execute(
      `INSERT INTO ad_performance
         (client_id, ad_id, date, ad_name, campaign_name, spend, currency,
          impressions, reach, clicks, leads)
       VALUES (?,?,?,?,'ZZ campaign',?,'INR',?,0,?,?)`,
      [clientId, adId, date, name, spend, impressions, clicks, leads]
    );

  // Two days of one ad, one day of another, and a third that Meta returned
  // with nothing in it at all.
  await put("ZZad-1", "2026-08-20", "old name", 300, 1000, 20, 1);
  await put("ZZad-1", "2026-08-21", "ZZ winner", 300, 2000, 40, 3);
  await put("ZZad-2", "2026-08-21", "ZZ loser", 900, 3000, 15, 1);
  await put("ZZad-3", "2026-08-21", "ZZ never ran", 0, 0, 0, 0);

  const rows = await ads.adPerformance("2026-08-01", "2026-08-31", clientId);

  assert.equal(rows.length, 2, "an ad that spent nothing and was shown to nobody is not a row");
  assert.deepEqual(rows.map((r) => r.adId), ["ZZad-2", "ZZad-1"], "biggest spender first");

  const winner = rows.find((r) => r.adId === "ZZad-1");
  assert.equal(winner.spend, 600, "the days are added up");
  assert.equal(winner.impressions, 3000);
  assert.equal(winner.leads, 4);
  assert.equal(winner.costPerLead, 150, "and cost per lead is the range's spend over its leads");
  assert.equal(Number(winner.ctr.toFixed(2)), 2, "click rate too");
  assert.equal(winner.days, 2, "days counts the ones it actually spent on");

  /*
   * The latest name, not the alphabetically last one. Ads get renamed
   * mid-flight, and the old name on screen is how somebody pauses the wrong
   * ad — which is the whole reason this table exists.
   */
  assert.equal(winner.name, "ZZ winner", "the newest name Meta gave it");

  // And the verdict over real stored rows.
  const r = ads.rankAds(rows);
  assert.equal(r.by, "costPerLead");
  assert.equal(r.best, "ZZad-1", "600 over 4 leads beats 900 over 1");
  assert.equal(r.worst, "ZZad-2");
  ok("the stored days become one row per ad, named as Meta last named it");

  await clean();
}

/* ------------------------------------------------------------------ *
 * The extra pull cannot take the board down
 * ------------------------------------------------------------------ */
{
  const src = read("lib/ads.ts");
  assert.ok(src.includes("&time_increment=1&level=ad"), "Meta is asked ad by ad");
  assert.ok(src.includes("&time_increment=1&level=account"), "and the account total still is");

  /*
   * Order and containment, both load-bearing. The account rows are committed
   * first, and the ad-level call is awaited with its own catch — so a
   * Marketing API that declines ad-level access, a table nobody has applied,
   * or a timeout costs the detail and none of the board that has worked since
   * before any of this existed.
   */
  assert.ok(
    src.includes("await syncAdLevel(clientId, account, token, since, until).catch(() => 0);"),
    "the ad-level pull cannot throw into the sync"
  );
  assert.ok(
    src.indexOf("INSERT INTO ad_insights") < src.indexOf("await syncAdLevel("),
    "and runs only after the account totals are stored"
  );
  assert.ok(
    src.includes(`if (!(await hasTable("ad_performance"))) return 0;`),
    "a database without the table is not an error"
  );
  assert.ok(
    src.includes(`if (!(await hasTable("ad_performance"))) return [];`),
    "and reading it back on one is not either"
  );

  /*
   * Reach was left off the row entirely at first, because daily reach cannot
   * be summed — the same person reached on Monday and Tuesday is one person,
   * and a wrong number that looks like the right ones is worse than a missing
   * column.
   *
   * It is on the row now, asked for properly: Meta deduplicates it over the
   * window, and it is stored with the window it covers. The rule that mattered
   * has not changed and this is what still holds it — the daily figures are
   * never added together.
   */
  assert.ok(!/SUM\(p\.reach\)/.test(src), "daily reach is never summed");

  /*
   * Scoped to `adPerformance`, not the whole file. The older account-level
   * reader has its own `reach` from `ad_insights` and always has — this is
   * about the per-ad row, and a file-wide match caught that one instead.
   */
  const perAd = src.slice(
    src.indexOf("export async function adPerformance"),
    src.indexOf("export type ClientAdView")
  );
  assert.ok(
    perAd.includes("Number(r.reach_window_days) === askedDays"),
    "the per-ad reach comes from the window figure, and only for a matching range"
  );
  assert.ok(!/\breach\b[^\n]*p\.reach\b/.test(perAd), "never from the daily column");
  ok("the ad-level pull is additive — it cannot break what already worked");
}

/* ------------------------------------------------------------------ *
 * And the screen says what it judged on
 * ------------------------------------------------------------------ */
{
  const table = read("app/(app)/ads/ad-table.tsx");
  assert.ok(table.includes("rankAds("), "the badges come from the shared judgement");
  assert.ok(table.includes("cost per lead"), "and the basis is written next to them");
  assert.ok(table.includes("click rate"), "in both forms");

  const compare = read("app/(app)/ads/ad-compare.tsx");
  assert.ok(compare.includes("rankAds("), "the chart is judged the same way");
  assert.ok(compare.includes("MAX_BARS"), "and caps how many bars it draws");
  assert.ok(
    /dropped > 0/.test(compare),
    "saying what it dropped — a silent cap reads as 'this is all of them'"
  );
  ok("the verdict and its basis are on screen, and nothing is silently truncated");
}

/* ------------------------------------------------------------------ *
 * Where the ad ran
 * ------------------------------------------------------------------ */
{
  /*
   * Asked for directly, and it is the one thing about an ad that neither the
   * spend nor the click rate can tell you: two ads with identical numbers are
   * completely different pieces of work if one ran in Hyderabad and the other
   * across the whole country. It is also the first question a client asks.
   *
   * Targeting lives on the ad set, not the ad, so it is a third request to
   * Meta — and `describeGeo` is the part that can be held to account without
   * one, which is why the shape of the spec is pinned here.
   */
  const g = ads.describeGeo;

  // Smallest first. Two cities inside India is "Hyderabad, Bengaluru" —
  // answering "India" would be true and useless.
  assert.equal(
    g({ countries: ["IN"], cities: [{ name: "Hyderabad" }, { name: "Bengaluru" }] }),
    "Hyderabad, Bengaluru",
    "cities beat the country they sit in"
  );
  assert.equal(g({ countries: ["IN"] }), "India", "a country alone is named, not left as a code");
  assert.equal(g({ countries: ["AE"] }), "UAE", "and known codes are spelled out");
  assert.equal(g({ countries: ["ZZ"] }), "ZZ", "an unknown code is shown rather than dropped");
  assert.equal(
    g({ countries: ["IN"], regions: [{ name: "Telangana" }] }),
    "Telangana",
    "a region beats the country too"
  );

  // A pin on a map, which is what a local business actually buys.
  assert.equal(
    g({ custom_locations: [{ name: "Kukatpally", radius: 5 }] }),
    "Kukatpally +5km",
    "a radius is part of the answer, not a detail"
  );
  assert.equal(
    g({ custom_locations: [{ latitude: 17.4432, longitude: 78.3915, radius: 3 }] }),
    "17.44, 78.39 +3km",
    "an unnamed pin still says where it is"
  );

  /*
   * Truncation that admits itself. A list cut to four that reads as the whole
   * of it is how somebody concludes an ad is not running where it is.
   */
  assert.equal(
    g({ cities: ["A", "B", "C", "D", "E", "F"].map((name) => ({ name })) }),
    "A, B, C, D +2 more",
    "a long list says how much it is not showing"
  );

  // Nothing known is nothing said — never "everywhere", which would be a
  // claim, and a wrong one.
  assert.equal(g(null), null);
  assert.equal(g({}), null, "an empty spec is not a worldwide campaign");
  ok("where an ad ran is named smallest-first, and never guessed at");
}

/* ------------------------------------------------------------------ *
 * The shape Meta actually sends
 * ------------------------------------------------------------------ */
{
  /*
   * Taken off a live ad account, not from the documentation — and the two
   * disagree in the way that matters.
   *
   * Meta hands these back as **objects keyed by position**, not arrays:
   * `custom_locations: { "0": {...} }`. Written against the documented array
   * shape, `.map` is not a function, and the throw was swallowed by the
   * caller's catch — so the column stayed empty on every account that had any
   * targeting at all, and looked like a feature nobody had wired up.
   *
   * This is the exact payload from a real ad set, keys and all.
   */
  const live = {
    custom_locations: {
      "0": {
        name: "1 Secant St, Sydney, New South Wales, Australia",
        latitude: -33.91792,
        longitude: 150.92118,
        address_string: "1 Secant St, Sydney, New South Wales, Australia",
        radius: 12,
        distance_unit: "kilometer",
        primary_city_id: 114925,
        region_id: 131,
        country: "AU",
      },
    },
    location_types: { "0": "home", "1": "recent" },
  };

  assert.equal(
    ads.describeGeo(live),
    "1 Secant St, Sydney, New South Wales, Australia +12km",
    "a numbered object is read exactly like an array"
  );

  // And the documented array form still works — both are accepted rather than
  // one being picked, because Meta uses both.
  assert.equal(
    ads.describeGeo({ countries: { "0": "IN", "1": "AE" } }),
    "India, UAE",
    "countries too, whichever shape they arrive in"
  );

  /*
   * Meta's own unit, never an assumed one. An account set up in miles that
   * reads "+12km" is off by a factor of 1.6 and says so with total confidence.
   */
  assert.equal(
    ads.describeGeo({
      custom_locations: { "0": { name: "Kukatpally", radius: 5, distance_unit: "mile" } },
    }),
    "Kukatpally +5mi",
    "miles are miles"
  );

  // Some ad sets carry the address only under address_string.
  assert.equal(
    ads.describeGeo({
      custom_locations: [{ address_string: "MG Road, Bengaluru", radius: 3 }],
    }),
    "MG Road, Bengaluru +3km",
    "the address is used when there is no name"
  );
  ok("the live payload shape is handled, keys-as-array and all");
}


/* ------------------------------------------------------------------ *
 * The columns an ad table is read for
 * ------------------------------------------------------------------ */
{
  const src = read("lib/ads.ts");
  const table = read("app/(app)/ads/ad-table.tsx");

  for (const col of ["Status", "Reach", "Views", "Engagement"]) {
    assert.ok(table.includes(`>${col}</th>`), `the table has a ${col} column`);
  }

  /*
   * Engagement comes out of the same overlapping-actions rule as everything
   * else, so a missing one is a dash rather than a confident zero.
   */
  const got = ads.reachedFromActions([{ action_type: "post_engagement", value: "42" }]);
  assert.equal(got.engagement, 42, "engagement is read from the actions");
  assert.equal(ads.reachedFromActions([]).engagement, null, "and is null when Meta never sent it");

  /*
   * Reach is the one metric that cannot be summed, and the code has to say so
   * rather than quietly adding the daily figures: the same person reached on
   * Monday and Tuesday is one person, and no arithmetic over stored daily rows
   * recovers that. Meta is asked for the window instead.
   */
  assert.ok(src.includes("fields=ad_id,reach&level=ad"), "reach is asked for over the window");
  assert.ok(!/SUM\(p\.reach\)/.test(src), "and is never summed out of the daily rows");
  assert.ok(src.includes("reach_window_days"), "and is stored with the window it describes");
  assert.ok(
    src.includes("Number(r.reach_window_days) === askedDays"),
    "and shown only for a range that matches it"
  );
  assert.ok(
    table.includes("Reach cannot be added up across days"),
    "with the reason on the dash, so nobody reads it as missing data"
  );

  // Status is not an insights field at all — it lives on the ad object.
  assert.ok(src.includes("fields=id,effective_status"), "status comes from the ad, not insights");
  // The wording moved into lib/ad-labels.ts when those helpers were pulled out
  // of the component so they could be tested — see tests/ad-labels.mjs.
  assert.ok(
    read("lib/ad-labels.ts").includes("Ad set paused"),
    "and a paused parent is named rather than flattened to Paused"
  );
  assert.ok(table.includes("statusLabel("), "the table renders it through that helper");
  ok("status, reach, views and engagement — each from the place that actually has it");
}

/* ------------------------------------------------------------------ *
 * And none of it reaches the client
 * ------------------------------------------------------------------ */
{
  /*
   * The client page gained nothing here. Spend was already absent by
   * construction, and these columns are the agency reading whether an ad is
   * worth keeping — not the client reading their results.
   */
  const bare = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const clientPage = bare(read("app/portal/ads/page.tsx"));
  assert.ok(!/spend|cost/i.test(clientPage), "still no money on the client page");
  ok("the client page is unchanged and still has no money on it");
}

await finish(pass);
