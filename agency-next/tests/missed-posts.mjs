/**
 * "Not posted" — and, at last, why.
 *
 * The card listed videos whose slot had gone and said, underneath, "usually
 * the Zap is off, or Instagram rejected the video". Both halves aged badly:
 * Zapier was removed from this portal and posting runs through n8n and the
 * portal's own publisher, so the sentence pointed at software that no longer
 * exists. And the one column that could have helped said "Scheduled" on every
 * row — which is not a diagnosis, it is the definition of being on the list.
 *
 * Every condition the publish queue silently drops a row on is knowable from
 * the row. This pins that each one is named, and named in the order somebody
 * would fix them.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const db = await load("lib/db.ts");
const q = await load("lib/queries.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ-MISS %'");
  await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ-MISS%'");
};
await clean();

const month = new Date().toISOString().slice(0, 7);
/** Two hours ago, in the app's UTC — past the card's 30-minute grace. */
const late = new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 19).replace("T", " ");

const mkClient = async (name, cols = {}) => {
  const keys = ["company_name", "status", ...Object.keys(cols)];
  const vals = [name, "active", ...Object.values(cols)];
  return Number(
    (await db.execute(
      `INSERT INTO clients (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      vals
    )).insertId
  );
};

const mkTask = async (clientId, title, cols = {}) => {
  const keys = ["client_id", "title", "status", "month_key", "scheduled_at", "instagram_status", ...Object.keys(cols)];
  const vals = [clientId, title, "scheduled", month, late, "scheduled", ...Object.values(cols)];
  return Number(
    (await db.execute(
      `INSERT INTO deliverables (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      vals
    )).insertId
  );
};

/** The one row this run cares about. */
const reasonFor = async (id) => (await q.getMissedPosts(null)).find((m) => m.id === id)?.reason;

/* ---------------- the client's settings come first ---------------- */
{
  const c = await mkClient("ZZ-MISS no account");
  const id = await mkTask(c, "ZZ-MISS a", { content_category: "Instagram Reel", edited_link: "https://x/v.mp4" });
  assert.match(await reasonFor(id), /No Instagram account/, "the first thing to fix");
  ok("a client with no Instagram account is told so, not guessed at");
}

{
  const c = await mkClient("ZZ-MISS autopublish off", { ig_user_id: "1784100000", auto_publish: 0 });
  const id = await mkTask(c, "ZZ-MISS b", { content_category: "Instagram Reel", edited_link: "https://x/v.mp4" });
  assert.match(await reasonFor(id), /Auto-publishing is off/);
  ok("auto-publishing left off is the reason, and says whose setting it is");
}

/* ---------------- then the task's ---------------- */
{
  const c = await mkClient("ZZ-MISS ready", { ig_user_id: "1784100001", auto_publish: 1 });

  const noVideo = await mkTask(c, "ZZ-MISS c", { content_category: "Instagram Reel" });
  assert.match(await reasonFor(noVideo), /No finished video/);

  const wrongKind = await mkTask(c, "ZZ-MISS d", {
    content_category: "Instagram Post",
    edited_link: "https://x/v.mp4",
  });
  assert.match(await reasonFor(wrongKind), /Only Instagram Reels post automatically/);
  ok("a task with no video, or of a kind that never auto-posts, says which");
}

/* ---------------- and then the publisher itself ---------------- */
{
  /*
   * The case that produced this work: nothing is wrong with the row.
   *
   * The client is set up, the video is there, the category is right, no error
   * and no attempts used — and it is still sitting there an hour late. That is
   * not a fault in the data, it is nothing having come to collect it: the
   * publisher is an n8n schedule calling the queue endpoint, and a schedule
   * that is off looks exactly like this, on every video at once.
   */
  const c = await mkClient("ZZ-MISS nobody came", { ig_user_id: "1784100002", auto_publish: 1 });
  const id = await mkTask(c, "ZZ-MISS e", {
    content_category: "Instagram Reel",
    edited_link: "https://x/v.mp4",
  });
  assert.match(await reasonFor(id), /Nothing collected it/, "the schedule, not the row");
  ok("a video with nothing wrong with it says the publisher never came for it");
}

{
  const c = await mkClient("ZZ-MISS errored", { ig_user_id: "1784100003", auto_publish: 1 });
  const id = await mkTask(c, "ZZ-MISS f", {
    content_category: "Instagram Reel",
    edited_link: "https://x/v.mp4",
    post_error: "The media could not be fetched by Instagram.",
  });
  // Instagram's own words beat any of ours — it is the only party that knows.
  assert.match(await reasonFor(id), /could not be fetched/);
  ok("when Instagram gave a reason, that is the reason shown");
}

/* ---------------- the slot says what time, and whose ---------------- */
{
  const c = await mkClient("ZZ-MISS overseas", {
    ig_user_id: "1784100004",
    auto_publish: 1,
    placeholder_values: JSON.stringify({ country: "Australia" }),
  });
  const id = await mkTask(c, "ZZ-MISS g", {
    content_category: "Instagram Reel",
    edited_link: "https://x/v.mp4",
  });
  const row = (await q.getMissedPosts(null)).find((m) => m.id === id);
  // "20 Aug 2026" beside "1h late" cannot be reconciled without the time on
  // it — and for an overseas client, without knowing whose clock it is in.
  assert.match(row.scheduled_label, /AEST/, "the client's own clock");
  assert.match(row.scheduled_label, /IST/, "and ours after it");
  ok("the missed slot is shown as a time, in both clocks");
}

/* ---------------- a missing token costs nothing ---------------- */
{
  /*
   * The expensive version of "not set up".
   *
   * With no Meta token, publishClaimed fails every video it is handed with
   * permanent: true — right for a genuinely bad video, exactly wrong for an
   * absent setting. One daily run would have burned the entire queue, one
   * permanent failure each, for a config nobody knew was missing. So it is
   * asked before anything is claimed and the run reports itself unready
   * instead, leaving the queue untouched.
   */
  const ig = await load("lib/instagram.ts");
  const readiness = await ig.publishingReadiness();
  const hasToken =
    Boolean(process.env.META_ACCESS_TOKEN) ||
    Number(
      (await db.queryOne(
        "SELECT COUNT(*) AS n FROM clients WHERE ig_access_token IS NOT NULL AND ig_access_token <> ''"
      )).n
    ) > 0;

  if (hasToken) {
    assert.equal(readiness.ready, true, "a token is configured, so publishing is ready");
  } else {
    assert.equal(readiness.ready, false, "no token anywhere means not ready");
    assert.match(readiness.reason, /No Meta access token/);
  }

  // Whichever way this machine is configured, the check must be the thing that
  // decides — not a comment claiming it does.
  const src = read("lib/instagram.ts");
  assert.match(src, /if \(!env\.meta\.accessToken\)/, "readiness asks about the token");
  assert.match(
    src,
    /const \{ ready \} = await publishingReadiness\(\)/,
    "and the queue asks readiness before returning anything to claim"
  );
  ok("with no Meta token the run reports itself unready instead of failing every video");
}

/* ---------------- Post now means post now ---------------- */
{
  /*
   * The contradiction this closes.
   *
   * A video past its window carries the blocker "Its window (…) closed … Move
   * the date to the next day, or use Post now" — and pressing Post now handed
   * that same sentence straight back as the reason it would not. The one
   * escape hatch the message names was the one thing it refused.
   *
   * The window exists to stop the *unattended* publisher going out at 3am. A
   * person pressing the button has decided otherwise; that is the button.
   */
  const src = read("lib/instagram-publish.ts");
  const at = src.indexOf("const fatal = info.blockers.filter");
  const filter = src.slice(at, at + 400);
  for (const [pattern, why] of [
    [/\^Auto-publishing is off/, "pressing it is the missing consent"],
    [/\^No posting time is set/, "and the missing time"],
    [/\^Its window /, "and the decision to post outside the window"],
    [/\^It has used all/, "and to spend another attempt"],
  ]) {
    assert.match(filter, pattern, `overruled by a person: ${why}`);
  }

  // The ones a person cannot overrule: there is nothing to send without them.
  const ig = read("lib/instagram.ts");
  assert.match(ig, /No Instagram account is linked/, "an account is still required");
  assert.match(ig, /There is no finished video/, "and so is a video");

  // And readiness is asked before the claim, so a missing token does not get
  // recorded against the video as a permanent failure.
  const readyAt = src.indexOf("publishingReadiness()");
  assert.ok(readyAt > 0 && readyAt < at, "readiness is checked before anything is claimed");
  ok("Post now overrules the window it tells you to use it for");
}

/* ---------------- "Connected" has to mean connected ---------------- */
{
  /*
   * The badge that caused this whole afternoon.
   *
   * The Instagram row on a client's page went green whenever `ig_user_id` was
   * a non-empty string — a check that somebody had typed a number. So a client
   * with no working token, or with a Facebook Page id in the Instagram field,
   * showed exactly the same green "Connected" as one publishing every evening.
   * It answered the most important question on the page wrongly, which is
   * worse than leaving it open: nobody goes looking for a problem the portal
   * says they do not have.
   *
   * The Facebook row beside it already earned its badge with a Graph call, and
   * its own comment names this row as the counter-example. Both now mean the
   * same thing by the same method.
   */
  const page = read("app/(app)/clients/[id]/page.tsx");
  assert.ok(
    !/tone=\{c\.ig_user_id \? "success" : "muted"\}/.test(page),
    "the badge is no longer read off the column"
  );
  assert.match(page, /checkInstagramConnection\(c\.id\)/, "it asks Meta");
  assert.match(page, /ig\.state === "broken"/, "and has somewhere to put the reason");

  const lib = read("lib/instagram-connection.ts");
  // Asking for `username` is the whole trick: a Page id answers 200 with no
  // username, which is the silent mix-up this is here to catch.
  assert.match(lib, /fields=username/, "it asks for the one field a Page does not have");
  assert.match(lib, /if \(!json\.username\)/, "and treats a 200 without one as broken");
  assert.match(lib, /row\?\.ig_access_token \|\| env\.meta\.accessToken/, "same token order as the publisher");
  ok("the Instagram badge is earned from Meta, not from somebody having typed a number");
}

/* ---------------- a saved token says it is saved ---------------- */
{
  /*
   * "meta access token echina tharavatha disappear avuthundi."
   *
   * It was not disappearing. The field is a password input, and a password
   * input still ships its value to the browser, so it is deliberately never
   * populated — which looks exactly like a save that failed. People re-typed
   * the token, watched it vanish again, and concluded the portal was losing
   * it. Nothing on the page was willing to say otherwise.
   *
   * Two things have to hold at once: the value never reaches the browser, and
   * the page says whether one is stored.
   */
  const form = read("app/(app)/clients/client-form.tsx");
  const at = form.indexOf('name="ig_access_token"');
  const field = form.slice(at - 400, at + 500);
  assert.ok(
    !/defaultValue=\{d\.ig_access_token\}/.test(field),
    "the stored token is never rendered into the input"
  );
  assert.match(field, /d\.has_ig_token/, "but whether one exists is");
  assert.match(form, /A token is saved for this client/, "and says so in words");
  // The way out, since a blank field means "leave it alone" and not "clear it".
  assert.match(form, /to remove it/, "and says how to remove one");

  const edit = read("app/(app)/clients/[id]/edit/page.tsx");
  assert.match(edit, /has_ig_token: Boolean\(client\.ig_access_token\)/, "a boolean, not the value");
  assert.match(edit, /ig_access_token: ""/, "the value itself stays empty");

  // And blank still means unchanged on save, which is what made the silence
  // safe rather than destructive in the first place.
  const actions = read("app/(app)/clients/actions.ts");
  assert.match(actions, /if \(token\) columns\.ig_access_token =/, "blank leaves the stored one alone");
  ok("a saved token is invisible but not silent");
}

/* ---------------- the group gets both links, or neither claim ---------------- */
{
  /*
   * The message said "live on Instagram and Facebook" and carried one link.
   *
   * A client told about two posts was handed one address and left to find the
   * other themselves, on an account they pay us to run. Both links now, one
   * labelled line each — two bare URLs in a row is the shape of a forwarded
   * advert, and somebody scanning their group should not have to open both to
   * learn which is which.
   */
  const pub = read("lib/instagram-publish.ts");
  assert.match(pub, /`Instagram: \$\{permalink\}`/, "the Instagram link is labelled");
  assert.match(pub, /`Facebook: \$\{fbLink\}`/, "and so is the Facebook one");
  assert.match(pub, /facebookPermalink\(facebookPostId\)/, "built from the Page post's id");

  // Facebook is claimed only when it actually went. Telling a client their
  // post is on a Page that refused it is the one version worth never sending.
  assert.match(pub, /facebookPostId \? "Instagram and Facebook" : "Instagram"/);
  assert.match(pub, /tellTheClient\(item, permalink, fb\.ok \? fb\.postId : null\)/);
  ok("the group is sent both links, and Facebook is named only when it went");
}

{
  /*
   * Half-posted appears on no board.
   *
   * "Not posted" lists what never reached Instagram. This reached Instagram
   * and stopped — and nobody opens the task page of a video that published
   * successfully, so the client's Page would quietly run a month behind their
   * feed with the client the first to notice.
   */
  const pub = read("lib/instagram-publish.ts");
  const at = pub.indexOf("is live on Instagram but not on Facebook");
  assert.ok(at > 0, "the partial failure is detected");
  const branch = pub.slice(at, at + 1400);
  assert.match(branch, /notifyAdmins\(/, "and somebody is told about it");
  assert.match(branch, /publish_partial/, "under its own type, not mixed in with failures");
  assert.match(branch, /\/deliverables\/\$\{item\.deliverable_id\}/, "with a link to the task");

  // Never able to fail the publish: the reel is live by this point.
  assert.match(branch, /\.catch\(\(\) => \{\}\)/, "and it cannot break a successful publish");
  ok("a post that reached Instagram but not Facebook tells somebody");
}

/* ---------------- and the card no longer guesses ---------------- */
{
  const page = read("app/(app)/dashboard/page.tsx");
  assert.ok(!/Zap is off/.test(page), "Zapier is gone from the portal and from the copy");
  assert.match(page, /Why not/, "the column says why instead of repeating the status");
  assert.ok(
    !/label\(m\.instagram_status\)/.test(page),
    'and no longer prints "Scheduled" on every row of a list of unscheduled-looking things'
  );
  assert.match(page, /m\.scheduled_label \?\? fmtDate\(m\.scheduled_at\)/, "the slot carries its time");
  ok("the card explains itself instead of naming software the portal stopped using");
}

await clean();
await finish(pass);
