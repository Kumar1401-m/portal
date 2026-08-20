/**
 * A post goes out in the client's evening, and is reported in ours.
 *
 * The portal was written for a roster that was entirely Indian, so one window
 * — 5 to 7 PM — and one clock served everybody, and the country a client is in
 * was a caption setting. An Australian client breaks all three at once: their
 * reel has to go out at 6 PM in Sydney, which is half past one in the
 * afternoon here, and the people who have to notice if it fails are here.
 *
 * So every posting time now has two readings and both must be right. Telling
 * the client 1:30 would be telling them the wrong thing about their own
 * account; showing 6:00 to the agency and nothing else would leave somebody
 * working out the conversion at the moment they least want to.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const p = await import(pathToFileURL(`${SRC}/lib/posting.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- the evening belongs to the client ---------------- */
{
  // 6 PM Sydney is 08:00 UTC. Not 6 PM here, and not 6 PM UTC.
  const au = p.scheduleDateToUtc("2026-08-21", "Australia");
  assert.equal(au, "2026-08-21 08:00:00", "6 PM AEST is 08:00 UTC");

  // 5 PM IST is 11:30 UTC — the Indian slot, unchanged.
  assert.equal(p.scheduleDateToUtc("2026-08-21", "India"), "2026-08-21 11:30:00");

  // An unknown or missing country is India, deliberately and not by accident.
  assert.equal(p.scheduleDateToUtc("2026-08-21", null), "2026-08-21 11:30:00");
  assert.equal(p.scheduleDateToUtc("2026-08-21", "Wakanda"), "2026-08-21 11:30:00");
  ok("a date is stored as that country's evening, in UTC");
}

/* ---------------- and is read back in both clocks ---------------- */
{
  // The same instant, said twice: theirs first, because the post is for them.
  const both = p.bothClocks("2026-08-21 08:00:00", "Australia");
  assert.match(both, /6:00 pm AEST/, "the client's own evening");
  assert.match(both, /1:30 pm IST/, "and what that is here");
  assert.match(both, /21 Aug 2026/, "with the date said once");
  ok("an Australian post reads 6:00 pm AEST · 1:30 pm IST");
}

{
  // An Indian client gets one time. The same clock printed twice reads as a
  // bug, and invites somebody to "fix" it.
  const one = p.bothClocks("2026-08-21 11:30:00", "India");
  assert.match(one, /5:00 pm IST/);
  assert.ok(!one.includes("·"), `"${one}" should not repeat itself`);
  ok("a client in our own timezone is told the time once");
}

{
  assert.equal(p.bothClocks(null, "Australia"), null, "nothing scheduled, nothing said");
  ok("no time is not a time");
}

/* ---------------- the window is the client's too ---------------- */
{
  assert.deepEqual(p.postingWindowFor("Australia"), { fromHour: 18, toHour: 19, zone: "AEST" });
  assert.deepEqual(p.postingWindowFor("India"), { fromHour: 17, toHour: 19, zone: "IST" });
  assert.equal(p.windowHoursFor("Australia"), 1, "6 to 7, so one hour");
  assert.equal(p.windowHoursFor("India"), 2, "5 to 7, so two");
  ok("each country's window comes from its own row, not from one number");
}

{
  /*
   * The reason this matters, and the bug it prevents.
   *
   * The publish queue prefilters in SQL on the widest window on the roster,
   * because a country lives in a JSON column and cannot be read per row there.
   * If a row were not then checked against its OWN window, an Australian reel
   * an hour and a half late would still be handed out — inside India's two
   * hours, past the seven o'clock the client was told about, and dark in
   * Sydney by then.
   */
  assert.equal(p.MAX_WINDOW_HOURS, 2, "the widest window is India's two hours");
  assert.ok(
    p.MAX_WINDOW_HOURS >= p.windowHoursFor("Australia"),
    "the SQL prefilter can never be narrower than a client's own window"
  );

  const ig = read("lib/instagram.ts");
  assert.match(
    ig,
    /if \(missedItsWindow\(String\(r\.scheduled_at\), countryOf\(r\.placeholder_values\)\)\) return null;/,
    "so each queued row is checked against its own window before it goes out"
  );
  assert.match(ig, /PUBLISH_WINDOW_HOURS = MAX_WINDOW_HOURS/, "and the SQL uses the widest");
  ok("over-selecting in SQL and narrowing per client, never the other way round");
}

/* ---------------- the country is findable, and its effect is stated -------------- */
{
  // It was a caption setting, and blank quietly meant India — so an Australian
  // client left blank would post at half past midnight, their time, with
  // nothing on any screen having said so.
  const form = read("app/(app)/clients/client-form.tsx");
  assert.match(form, /country also sets when their posts go out/, "the form says what it does");
  assert.match(form, /postingTimeLabel\(d\.loc_country \|\| "india"\)/, "and shows the window");
  assert.match(form, /No country set, so posts go out/, "including when nobody set one");
  ok("the country field says it decides posting time, and shows which window");
}

{
  assert.equal(p.postingTimeLabel("Australia"), "6:00 – 7:00 PM AEST");
  assert.equal(p.postingTimeLabel("India"), "5:00 – 7:00 PM IST");
  assert.equal(p.postingTimeLabel("UAE"), "8:00 – 9:00 PM GST");
  ok("the window is written the way somebody would say it out loud");
}

/* ---------------- the panel that answers "when does this post?" ---------------- */
{
  const ig = read("lib/instagram.ts");
  // Both of these used to be prettyLocal, which was hardcoded to India — so
  // the panel for an Australian client showed the right instant as the wrong
  // time, on the one screen someone opens to ask exactly this.
  assert.match(ig, /scheduledAt: bothClocks\(row\.scheduled_at, country\)/);
  assert.match(ig, /postedAt: bothClocks\(row\.instagram_posted_at \|\| row\.posted_at, country\)/);
  assert.match(ig, /const country = countryOf\(row\.placeholder_values\)/, "from the client's own record");
  // And the missed-window message names the window it means.
  assert.match(ig, /Its window \(\$\{postingTimeLabel\(country\)\}\) closed/);
  ok("the publish panel reads every time in the client's clock, then ours");
}

await finish(pass);
