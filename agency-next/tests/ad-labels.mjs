/**
 * Making a Meta string fit a column without losing the point of it.
 *
 * The ad table had twelve columns under `table-fixed`, so each got a twelfth
 * of the width and the *name* — the one column that says which row you are
 * looking at — clipped to "Freskos - …" on every line. Twelve identical rows.
 *
 * Fixing the layout was half of it. The other half is these three, and both of
 * the first two shipped broken the first time in a way nothing on screen
 * showed: one silently stopped shortening anything, the other silently kept
 * the least useful part of an address. Neither would have thrown; both would
 * simply have looked like the table was still wrong.
 *
 * They live in `lib/` rather than in the component precisely so this file can
 * run them.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const { shortName, shortPlace, statusLabel } = await import(
  pathToFileURL(`${SRC}/lib/ad-labels.ts`).href
);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * The client's name is not worth saying twice
 * ------------------------------------------------------------------ */
{
  assert.equal(
    shortName("Freskos - Followers & Engagement - Liverpool 12km", "Freskos"),
    "Followers & Engagement - Liverpool 12km",
    "the prefix goes, the part that tells ads apart stays"
  );

  // Only when it really is a prefix followed by a separator.
  assert.equal(
    shortName("Freskos Coffee Dosa promo", "Freskos"),
    "Freskos Coffee Dosa promo",
    "a name that merely starts with the word is left alone"
  );
  assert.equal(shortName("Diwali reel", "Freskos"), "Diwali reel", "and one that does not");

  /*
   * Never down to nothing. An ad whose whole name is the client's is still
   * better identified by that than by an empty cell.
   */
  assert.equal(shortName("Freskos", "Freskos"), "Freskos", "never leaves the cell empty");
  assert.equal(shortName("Freskos - ", "Freskos"), "Freskos - ", "nor when only a separator follows");

  /*
   * The reason this is not a regex. A company name goes straight into the
   * pattern, so `A.B. (Pvt) Ltd` would have to be escaped — and unescaped it
   * is either a wrong match or a thrown error, on every row.
   */
  assert.equal(
    shortName("A.B. (Pvt) Ltd — Launch", "A.B. (Pvt) Ltd"),
    "Launch",
    "a name full of regex characters is handled as text"
  );
  assert.equal(shortName("anything", ""), "anything", "and an empty client changes nothing");
  ok("the client's name is dropped from the ad's, and only when it is safe to");
}

/* ------------------------------------------------------------------ *
 * An address is not a place
 * ------------------------------------------------------------------ */
{
  /*
   * "1 Secant St, Sydney, New South Wales, Australia +12km" clipped to
   * "1 Secant St," in the column — the half nobody is reading for.
   */
  assert.equal(
    shortPlace("1 Secant St, Sydney, New South Wales, Australia +12km"),
    "New South Wales, Australia +12km",
    "the last two parts and the radius survive"
  );

  // The radius is kept because a 12km circle and a 1km one are different work.
  assert.equal(shortPlace("Kukatpally +5km"), "Kukatpally +5km", "a short place keeps its radius");
  assert.equal(shortPlace("Kukatpally +5mi"), "Kukatpally +5mi", "miles too");

  // Short enough already, so nothing is dropped.
  assert.equal(shortPlace("Hyderabad, Telangana"), "Hyderabad, Telangana");
  assert.equal(shortPlace("India"), "India");

  /*
   * A last word that only looks like a radius is not one. The version written
   * as a regex had its escapes eaten in transit and matched a literal "s" and
   * "d" — which threw nothing and simply returned the wrong string.
   */
  assert.equal(shortPlace("Camp +something"), "Camp +something", "a plus is not enough on its own");
  ok("an address is shortened to the part somebody is reading for, radius kept");
}

/* ------------------------------------------------------------------ *
 * Where the ad actually stopped
 * ------------------------------------------------------------------ */
{
  assert.deepEqual(statusLabel("ACTIVE"), { text: "Active", live: true });
  assert.deepEqual(statusLabel("PAUSED"), { text: "Paused", live: false });

  /*
   * The two that catch people out. The ad is fine; something above it is off.
   * Flattening both to "Paused" sends somebody to look at the ad, which is the
   * one place the problem is not.
   */
  assert.deepEqual(statusLabel("ADSET_PAUSED"), { text: "Ad set paused", live: false });
  assert.deepEqual(statusLabel("CAMPAIGN_PAUSED"), { text: "Campaign paused", live: false });

  assert.equal(statusLabel(null), null, "nothing known is nothing shown");
  assert.equal(statusLabel("   "), null, "and neither is whitespace");

  // Anything Meta adds later reads as itself rather than vanishing.
  assert.deepEqual(statusLabel("IN_PROCESS"), { text: "in process", live: false });
  assert.equal(statusLabel("WITH_ISSUES").live, false, "and is never called live by accident");
  ok("a paused parent is named as the parent, and an unknown status still shows");
}

await finish(pass);
