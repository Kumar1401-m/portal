/**
 * The heartbeat, and the endpoints it is supposed to hit.
 *
 * The portal's automation map says publishing runs every fifteen minutes.
 * Nothing was making that true: Vercel's free plan allows two cron jobs and
 * only daily schedules, so a reel scheduled for seven in the evening went out
 * whenever the single daily cron next fired — which is the whole of "posts
 * sariga padatledhu". The Apps Script in `automation/apps-script/` is the
 * missing clock.
 *
 * A script pasted into a Google account cannot be run from here, so what is
 * checked is the part that rots: the URLs it calls have to be routes that
 * exist and accept a bearer token, and the intervals have to match what the
 * portal claims about itself. A renamed route would leave the script pinging
 * a 404 four times an hour, silently, for ever.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const ROOT = `${SRC}/..`;
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const gs = read("automation/apps-script/portal-cron.gs");

/* ------------------------------------------------------------------ *
 * Every URL it calls is a route that exists
 * ------------------------------------------------------------------ */
{
  const paths = [...gs.matchAll(/ping_\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(paths.length >= 3, "it pings the automation endpoints");

  for (const p of paths) {
    const file = `${SRC}/app${p}/route.ts`;
    assert.ok(existsSync(file), `${p} is a real route (${file})`);

    /*
     * And one that will accept it. These are called with a bearer token and
     * nothing else — no session, no cookie — so a route that checked for a
     * signed-in user would reject the heartbeat with a 401 that looks
     * identical to a wrong secret.
     */
    const src = readFileSync(file, "utf8");
    assert.ok(
      src.includes("isAuthorizedCronRequest"),
      `${p} authorises a cron caller rather than a session`
    );
    assert.ok(/export async function GET\(/.test(src), `${p} answers a GET`);
  }
  ok("every endpoint the schedule calls exists and takes a bearer token");
}

/* ------------------------------------------------------------------ *
 * At the frequency the portal claims for itself
 * ------------------------------------------------------------------ */
{
  assert.match(
    gs,
    /newTrigger\('runPublisher'\)[\s\S]{0,60}everyMinutes\(15\)/,
    "publishing every 15 minutes"
  );
  assert.match(
    gs,
    /newTrigger\('runReminders'\)[\s\S]{0,60}everyMinutes\(15\)/,
    "and the reminders with the outbox in them"
  );

  /*
   * Which is the number the portal's own map promises. If somebody changes the
   * map to hourly and leaves this at fifteen minutes, the map turns amber for
   * a job that is running perfectly — and a health panel that cries wolf is a
   * health panel nobody reads.
   */
  const map = readFileSync(`${SRC}/lib/automation-map.ts`, "utf8");
  assert.match(
    map,
    /key: "publishing"[\s\S]{0,220}everyMinutes: 15/,
    "matching what the automations page says to expect"
  );
  ok("the schedule fires as often as the portal says it should");
}

/* ------------------------------------------------------------------ *
 * It carries no secret, and cannot quietly die
 * ------------------------------------------------------------------ */
{
  /*
   * The token comes from Script Properties, never from the file — this gets
   * pasted into a browser, mailed around and committed here, and a literal
   * would leak on the first of those.
   */
  assert.match(gs, /PropertiesService\.getScriptProperties\(\)/, "the secret is a property");
  assert.ok(
    !/CRON_SECRET\s*=\s*['"][A-Za-z0-9_-]{8,}/.test(gs),
    "and no key is hard-coded in the file"
  );

  /*
   * `muteHttpExceptions`, and a catch around the fetch. Apps Script disables a
   * trigger that keeps throwing, so an unhandled 500 would turn one bad
   * afternoon into a permanently dead heartbeat — the exact failure this
   * script exists to prevent, arriving by a different door.
   */
  assert.match(gs, /muteHttpExceptions: true/, "a failing endpoint is read, not thrown");
  assert.match(gs, /catch \(err\)/, "and a network failure does not kill the trigger");

  // Installing twice is the obvious thing to do when unsure it worked.
  assert.match(
    gs,
    /getProjectTriggers\(\)[\s\S]{0,200}deleteTrigger/,
    "installing again replaces the schedule rather than doubling it"
  );
  ok("the schedule holds no credential and survives a bad response");
}

await finish(pass);
