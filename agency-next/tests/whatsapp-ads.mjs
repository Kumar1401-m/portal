/**
 * Ad questions, answered in the client's own WhatsApp group — without money.
 *
 * A client asking "how are my ads going?" is asking about themselves, and the
 * portal has known the answer all along: reach, engagements, clicks, profile
 * visits, enquiries, and where each ad is running. Until now the assistant had
 * none of it in front of it and had to say it would check with the team, for a
 * question it could have answered exactly.
 *
 * ## The rule that shapes the whole thing
 *
 * What the ads cost never enters the group. Not "the model is told not to say
 * it" — the facts are built by `clientAdsSummary`, which does not select
 * spend, currency, cost per lead or CPM, so there is no figure in the prompt
 * to leak. A prompt rule is an instruction a message can argue with. A column
 * that was never fetched is not.
 *
 * That matters more here than on the portal page it is shared with. A page
 * renders what it is handed; a model is handed everything and asked to be
 * helpful, and helpful plus a spend figure is a client comparing what they pay
 * us against what we pay Meta, in writing, in their own group.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const wa = await import(pathToFileURL(`${SRC}/lib/whatsapp-ai.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * The money is never fetched, so it can never be said
 * ------------------------------------------------------------------ */
{
  const lib = read("lib/whatsapp-ai.ts");

  assert.ok(lib.includes("clientAdsSummary(clientId"), "the facts come from the money-free reader");
  assert.ok(
    !lib.includes("adPerformance("),
    "never from the agency reader, which carries spend and cost per lead"
  );

  /*
   * The two function bodies that build the facts, comments stripped.
   *
   * Not the whole file: the system prompt names spend on purpose, to tell the
   * model it does not have it. Matching that would push somebody to delete the
   * instruction to get green. And the file's own comments explain at length
   * why there is no money here — a test that failed on the explanation is a
   * test that gets fixed by removing the reasoning.
   */
  const bodyOf = (name) => {
    const from = lib.indexOf(name);
    assert.ok(from > 0, `${name} exists`);
    return lib
      .slice(from, lib.indexOf("\n}\n", from) + 3)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  };
  for (const fn of ["export async function clientFacts", "export function adLines"]) {
    assert.ok(
      !/spend|cost|cpm|₹/i.test(bodyOf(fn)),
      `${fn} neither fetches money nor formats it`
    );
  }
  ok("the assistant reads ads from the reader that has no money in it");
}

/* ------------------------------------------------------------------ *
 * What the client is actually told
 * ------------------------------------------------------------------ */
{
  // Shaped exactly like `clientAdsSummary` returns, including the nulls Meta
  // leaves behind on accounts that do not report an action type.
  const summary = {
    from: "2026-08-01",
    to: "2026-08-30",
    company: "Freskos",
    totals: {
      ads: 2,
      impressions: 5382,
      clicks: 210,
      ctr: 3.9,
      videoViews: 1400,
      profileVisits: null,
      engagement: 96,
      leads: 7,
      reach: 991,
      reachDays: 28,
    },
    ads: [
      {
        adId: "1",
        name: "Freskos - Video Ad 5 - Order Now",
        campaign: null,
        locations: "Hyderabad, Telangana",
        impressions: 4000,
        clicks: 180,
        ctr: 4.5,
        videoViews: 1200,
        profileVisits: null,
        engagement: 70,
        leads: 6,
      },
      {
        adId: "2",
        name: "Freskos - Poster",
        campaign: null,
        locations: null,
        impressions: 1382,
        clicks: 30,
        ctr: 2.1,
        videoViews: null,
        profileVisits: null,
        engagement: 26,
        leads: 1,
      },
    ],
  };

  const text = wa.adLines(summary).join("\n");

  // The funnel, in the order it happens — the same words the client's own Ads
  // page uses, so a figure quoted here and one read there are the same figure.
  for (const said of [
    "991 accounts reached",
    "5,382 impressions",
    "96 engagements",
    "210 clicks",
    "3.90% click rate",
    "7 enquiries",
  ]) {
    assert.ok(text.includes(said), `it can say "${said}"`);
  }

  // Asked for by name: which ad, and where it is running.
  assert.ok(text.includes("running in Hyderabad"), "and where an ad is running");
  assert.ok(!text.includes("Freskos - Video Ad"), "their own name is not read back to them");
  assert.ok(text.includes('"Video Ad 5 - Order Now"'), "the part that tells the ads apart is kept");

  /*
   * A dash is not a nought, in a chat as much as on a page. Meta reports
   * profile visits on some accounts and not others; "0 profile visits" tells a
   * client their ad was ignored when the truth is we do not have the figure.
   */
  assert.ok(!/profile visits/.test(text), "an unreported figure is left out, not sent as zero");
  assert.ok(!/\b0 /.test(text), "and nothing else became a zero either");

  // Not one figure that is money, or that money can be recovered from.
  assert.ok(!/₹|spend|cost|budget|CPM/i.test(text), "and no money reaches the group");

  assert.equal(
    wa.adLines(null)[0],
    "They have no ads running with us.",
    "a client with no ads is told so plainly rather than shown an empty table"
  );
  ok("the group gets the funnel and the places, and never a rupee");
}

/* ------------------------------------------------------------------ *
 * And the model is told what it does not have
 * ------------------------------------------------------------------ */
{
  const lib = read("lib/whatsapp-ai.ts");

  /*
   * The absent data is the guarantee; this is the manners. Without it the
   * model meets "how much are you spending on my ads?" with a figure it has
   * assembled from somewhere — a package price, an invoice total — which is
   * worse than the real number, because it is wrong as well as private.
   */
  assert.ok(lib.includes("ADS. Answer these as fully as any other question"), "ads are answerable");
  assert.ok(
    lib.includes("What is NOT in FACTS is what the ads cost"),
    "and the one thing it does not have is named"
  );
  assert.ok(
    lib.includes("the team will come back to them on it"),
    "asked for it anyway, it hands over to a person"
  );
  assert.ok(
    lib.includes("never call it zero"),
    "and a figure Meta never reported is not turned into a zero in prose"
  );

  // Only a client who wants messages at all gets these.
  const route = read("app/api/whatsapp/message/route.ts");
  assert.ok(route.includes("ai_replies"), "and the client's own switch still governs replying");
  ok("what it cannot answer, it hands to a person rather than inventing");
}

await finish(pass);
