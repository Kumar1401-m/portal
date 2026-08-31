/**
 * Refreshing one client's ads, from that client's page.
 *
 * The board had a Refresh button and a client's own page had nothing — so the
 * page somebody opens *before ringing a client about their spend* was the one
 * page with no way to make the numbers current.
 *
 * ## And the line above them was wrong
 *
 * Both pages said the figures came "straight from Meta". They do not, on
 * purpose: `adSummary` and `clientAdDetail` read the stored daily rows,
 * because a page that calls the Graph API per client on every load is slow
 * when it matters and blank when a token lapses. So the one claim on the page
 * that could not be checked sat directly over numbers about to be read out to
 * a client. When it was last pulled is both true and more useful.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const ads = await import(pathToFileURL(`${SRC}/lib/ads.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute(
    "DELETE FROM ad_insights WHERE client_id IN (SELECT id FROM clients WHERE company_name LIKE 'ZZ ads%')"
  );
  await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ ads%'");
};

/* ------------------------------------------------------------------ *
 * "Last refreshed" is about this client, not about the newest row anywhere
 * ------------------------------------------------------------------ */
{
  await clean();
  const mk = async (name) =>
    Number(
      (await db.execute("INSERT INTO clients (company_name, status) VALUES (?, 'active')", [name]))
        .insertId
    );
  const quiet = await mk("ZZ ads quiet");
  const fresh = await mk("ZZ ads fresh");

  try {
    await db.execute(
      `INSERT INTO ad_insights (client_id, date, spend, currency, impressions, reach, clicks, leads, synced_at)
       VALUES (?, '2030-02-01', 10, 'INR', 100, 90, 2, 0, '2030-02-01 09:00:00'),
              (?, '2030-02-10', 20, 'INR', 200, 180, 4, 1, '2030-02-10 09:00:00')`,
      [quiet, fresh]
    );

    /*
     * The board's figure is the newest row anywhere, which is right for a
     * board. On a client's own page it is a lie of the most convincing kind: a
     * nightly run that succeeded for nine clients and failed on the tenth
     * would tell the tenth's page its numbers are minutes old.
     */
    assert.equal(
      String(await ads.lastAdSync(quiet)).slice(0, 10),
      "2030-02-01",
      "the quiet client reports its own last refresh"
    );
    assert.equal(
      String(await ads.lastAdSync(fresh)).slice(0, 10),
      "2030-02-10",
      "and the busy one reports its own"
    );
    assert.notEqual(
      String(await ads.lastAdSync(quiet)).slice(0, 10),
      String(await ads.lastAdSync()).slice(0, 10),
      "which is not the same question as the board's"
    );
    ok("a client's page says when that client was last refreshed");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * One button, and the scope follows the page
 * ------------------------------------------------------------------ */
{
  const button = read("app/(app)/ads/sync-button.tsx");
  assert.ok(
    button.includes("clientId ? await syncOneClientAction(clientId) : await syncAdsAction()"),
    "the same button refreshes one client or the whole book"
  );
  assert.ok(read("app/(app)/ads/[id]/page.tsx").includes("<SyncButton clientId={clientId} />"),
    "the client page asks for one");
  assert.ok(read("app/(app)/ads/page.tsx").includes("<SyncButton />"), "the board asks for all");

  /*
   * Not a second button. Two of these drift, and the one that drifts is the
   * one nobody is looking at — here that would be the failure reporting, which
   * is the whole reason this button is more than a fetch.
   */
  const actions = read("app/(app)/ads/actions.ts");
  assert.ok(actions.includes("syncClientAds(clientId)"), "and one definition of refreshing");
  assert.ok(
    actions.includes("await syncAllAds()"),
    "both reaching the same sync the nightly job uses"
  );

  /*
   * Reachable without the page, so it is guarded again here. A crm may refresh
   * their own clients and nobody else's.
   */
  assert.ok(
    actions.includes("await canAccessClient(user, clientId)"),
    "and a client id in a request proves nothing on its own"
  );
  ok("refreshing one client is the same act as refreshing all of them, scoped");
}

/* ------------------------------------------------------------------ *
 * The page says where the numbers came from, truthfully
 * ------------------------------------------------------------------ */
{
  // Comments stripped first: both files still *mention* the old wording, in
  // the note explaining why it went. Only what renders is the claim.
  const rendered = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  for (const p of ["app/(app)/ads/page.tsx", "app/(app)/ads/[id]/page.tsx"]) {
    assert.ok(!rendered(p).includes("straight from Meta"), `${p} no longer claims to be live`);
    assert.ok(
      read(p).includes("last refreshed ${prettyLocal(syncedAt)"),
      `${p} says when it was pulled`
    );
  }

  /*
   * And it is the stored rows they read — which is the deliberate choice the
   * old wording contradicted, not an oversight to be "fixed" by calling Meta
   * on page load.
   */
  const lib = read("lib/ads.ts");
  assert.ok(
    lib.includes("Reads the stored daily rows rather than calling Meta"),
    "reading stored rows is on purpose, and still says so"
  );
  ok("the line over the numbers describes where they actually came from");
}

await finish(pass);
