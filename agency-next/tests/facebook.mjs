/**
 * The same post, on the client's Facebook Page.
 *
 * The rule this must not break: by the time Facebook is attempted, the reel is
 * already live on Instagram and the row says so. A Page that refuses the video
 * is a thing to record — marking the publish failed would invite a retry, and
 * the retry would post to Instagram a second time.
 */
import assert from "node:assert/strict";
import fs2 from "node:fs";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const fb = await import(pathToFileURL(`${SRC}/lib/facebook.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

/* ---------------- it rides on the Instagram publish, and after it -------- */
{
  const pub = readFileSync(`${SRC}/lib/instagram-publish.ts`, "utf8");

  // Order is the whole safety argument. markPosted is the write that says the
  // reel is live; Facebook must come after it and must not be able to undo it.
  const postedAt = pub.indexOf("await markPosted({");
  const fbAt = pub.indexOf("const fb = await publishToPage({");
  assert.ok(postedAt > 0 && fbAt > postedAt, "Facebook is attempted after Instagram is recorded");

  // Nothing it returns can turn the publish into a failure. Scoped to the rest
  // of `publishClaimed` — the file has other functions after it that legitimately
  // mark things failed.
  const endOfFn = pub.indexOf("return { ok: true, deliverableId: item.deliverable_id, mediaId: published.id", fbAt);
  assert.ok(endOfFn > fbAt, "the function ends by succeeding");
  const tail = pub.slice(fbAt, endOfFn);
  assert.ok(!/markFailed/.test(tail), "and nothing between can mark the publish failed");
  assert.ok(!/return { ok: false/.test(tail), "nor return a failure from it");
  has(pub, "}).catch((err) => ({", "a throw from it is caught, not propagated");
  has(pub, "return { ok: true, deliverableId: item.deliverable_id, mediaId: published.id", "the run still succeeds");

  // Meta already fetched this URL for Instagram — one more call, not a second
  // upload.
  has(pub, "mediaUrl: item.video_url,", "the same file URL is reused");
  ok("Facebook happens after the reel is live, and cannot unpublish it");
}

/* ---------------- one field decides it ---------------- */
{
  const lib = readFileSync(`${SRC}/lib/facebook.ts`, "utf8");
  // A Page id on a client record has never meant anything but "post there",
  // so a second switch would be one more thing to set and to forget.
  has(lib, "if (!pageId) {", "no Page means nothing is attempted");
  has(lib, "skipped: true", "and that is not a failure");

  const ig = readFileSync(`${SRC}/lib/instagram.ts`, "utf8");
  has(ig, "fb_page_id: string | null;", "the queue carries it");
  has(ig, "c.ig_user_id, c.ig_access_token, c.fb_page_id,", "read alongside the Instagram account");

  const form = readFileSync(`${SRC}/app/(app)/clients/client-form.tsx`, "utf8");
  has(form, 'name="fb_page_id"', "and it is on the client form");
  const act = readFileSync(`${SRC}/app/(app)/clients/actions.ts`, "utf8");
  // People paste "Page ID: 1234" straight out of Business Suite.
  has(act, 'fb_page_id: orNull(s(fd, "fb_page_id").replace(/[^0-9]/g, ""))', "stored as digits");
  ok("setting the Page id is the whole configuration");
}

/* ---------------- a photo and a video are different endpoints ---------- */
{
  const lib = readFileSync(`${SRC}/lib/facebook.ts`, "utf8");
  // Same two facts, different spelling. The wrong pairing fails with a message
  // about a missing parameter rather than the real cause.
  has(lib, 'mediaType === "IMAGE" ? "photos" : "videos"', "a poster goes to /photos");
  has(lib, "{ url: mediaUrl, caption, access_token: token }", "which wants url + caption");
  has(lib, "{ file_url: mediaUrl, description: caption, access_token: token }", "and a video wants file_url + description");

  /*
   * `/videos` is the fallback now, not the choice.
   *
   * It was the choice, on the reasoning that the Reels API is a resumable
   * upload of the file and a serverless function cannot do that. Half true:
   * that is one of its two modes, and the other hands Meta a `file_url` and
   * lets it fetch the bytes, exactly as `/videos` does. The reasoning cost a
   * client a month of an empty Page — see the block below.
   */
  has(lib, "/video_reels`", "a video is offered as a Reel");
  assert.ok(
    lib.indexOf("publishReel(pageId") < lib.indexOf('mediaType === "IMAGE" ? "photos" : "videos"'),
    "and that happens before the library upload, not after it"
  );
  ok("a poster and a video each go to the endpoint that takes them");
}

/* ---------------- a video is a Reel, and a Reel is a post -------------- */
{
  /*
   * The bug this is the fix for: `/{page}/videos` takes the file, answers with
   * an `id` and no `post_id`, and creates no story. The video sits in the
   * Page's library, every screen here reads it as posted, and the client —
   * who only ever looks at the Page — sees nothing there. It took a client in
   * Australia asking why their Facebook was empty to find it.
   *
   * Driven rather than grepped: the three phases have to happen in order and
   * the third is the one that publishes. A start and an upload with no finish
   * is a draft, which is the same invisible post wearing a different hat.
   */
  const reply = (o) =>
    new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

  const run = async (handler, input) => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init) ?? reply({});
    };
    try {
      return { out: await fb.publishToPage(input), calls };
    } finally {
      globalThis.fetch = real;
    }
  };

  const video = {
    deliverableId: 0, // no such row; `record` swallows its own failures
    pageId: "PAGE",
    token: "TOK",
    mediaUrl: "https://example.test/v.mp4",
    mediaType: "REELS",
    caption: "hello",
  };

  const asReel = (u, init) => {
    if (u.endsWith("/video_reels")) {
      return String(init.body ?? "").includes("upload_phase=start")
        ? reply({ video_id: "REEL1", upload_url: "https://rupload.facebook.com/x" })
        : reply({ success: true });
    }
    if (u.startsWith("https://rupload.facebook.com/")) return reply({ success: true });
    if (u.includes("fields=permalink_url")) return reply({ permalink_url: "/reel/REEL1/" });
    return reply({ error: { message: "nothing else should be called" } });
  };

  {
    const { out, calls } = await run(asReel, video);
    assert.equal(out.ok, true);
    assert.equal(out.postId, "REEL1");
    assert.equal(out.onFeed, true, "a published Reel is on the timeline, not in a library");
    assert.equal(out.permalink, "https://www.facebook.com/reel/REEL1/");

    const phases = calls.filter((c) => c.url.endsWith("/video_reels") || c.url.includes("rupload"));
    assert.equal(phases.length, 3, "three phases, no more");
    assert.ok(String(phases[0].init.body).includes("upload_phase=start"), "start first");

    // The address, not the bytes. This is the whole reason the Reels API is
    // usable from a serverless function at all.
    assert.equal(phases[1].init.headers.file_url, video.mediaUrl, "the file is handed over as a URL");
    assert.equal(phases[1].init.headers.Authorization, "OAuth TOK");

    const finishBody = String(phases[2].init.body);
    assert.ok(finishBody.includes("upload_phase=finish"), "and then finish");
    assert.ok(finishBody.includes("video_state=PUBLISHED"), "which publishes it");
    assert.ok(finishBody.includes("video_id=REEL1"), "the one that was started");
    assert.ok(finishBody.includes("hello"), "carrying the caption");

    assert.ok(!calls.some((c) => c.url.endsWith("/videos")), "the library upload is not touched");
  }

  {
    // Not every video is Reel-shaped: too long, too wide, too small. A video
    // in the library is worse than a Reel and better than nothing.
    const { out, calls } = await run((u, init) => {
      if (u.endsWith("/video_reels") && String(init.body ?? "").includes("start")) {
        return reply({ error: { message: "Video is too long for a Reel.", code: 100 } });
      }
      if (u.endsWith("/videos")) return reply({ id: "VID9", post_id: "PAGE_9" });
      if (u.includes("fields=permalink_url")) return reply({ permalink_url: "/x/posts/9" });
      return reply({});
    }, video);

    assert.equal(out.ok, true, "a refused Reel falls back rather than failing");
    assert.equal(out.postId, "PAGE_9");
    assert.ok(calls.some((c) => c.url.endsWith("/videos")), "to the library endpoint");
  }

  {
    // A photo has never had this problem — /photos always comes back with a
    // post_id — so it does not pay for three phases to find that out.
    const { calls } = await run(
      (u) => (u.endsWith("/photos") ? reply({ id: "P1", post_id: "PAGE_1" }) : reply({})),
      { ...video, mediaType: "IMAGE" }
    );
    assert.ok(!calls.some((c) => c.url.includes("video_reels")), "a poster is not a Reel");
  }

  ok("a video goes up as a published Reel, and falls back to the library only if refused");
}

/* ---------------- and a failure says what to change ---------------- */
{
  const lib = readFileSync(`${SRC}/lib/facebook.ts`, "utf8");
  // The first thing anyone sees on switching this on: a token that visibly
  // works for Instagram is refused by the Page, because publishing to a Page
  // needs pages_manage_posts on top of the Instagram scopes. In Meta's own
  // words that reads as a bug in the portal.
  has(lib, "pages_manage_posts", "the permissions case is named outright");
  has(lib, "code === 190", "an expired token is told apart from a refused one");
  has(lib, "It is the Page's own id, not the Instagram account id.", "and so is the wrong id");

  // Recorded either way, on whatever columns exist.
  has(lib, 'hasColumn("deliverables", "facebook_post_id")', "the detail columns are gated");
  has(lib, 'await record(deliverableId, "failed", null, message)', "a refusal is written down");
  /*
   * A success now carries whether there is a post on the Page at all: a photo
   * comes back with a `post_id`, a video can come back with only an `id` —
   * taken into the Page's video library with no story made for it, so nothing
   * appears on the timeline. Both are "posted"; only one is visible, and the
   * note on the row is what says which. See facebook-link.mjs.
   */
  has(lib, 'await record(\n      deliverableId,\n      "posted",\n      postId,', "a success is written down too");
  has(lib, "permalink\n    );", "with the link Meta gave");

  assert.equal(fb.facebookPermalink(null), null, "no id, no link");
  assert.equal(
    fb.facebookPermalink("12345_67890"),
    "https://www.facebook.com/12345/posts/67890",
    "and the underscore form resolves as a URL"
  );
  ok("a refusal is recorded with the sentence that fixes it");
}

/* ---------------- the client is told only what is true ---------------- */
{
  const pub = readFileSync(`${SRC}/lib/instagram-publish.ts`, "utf8");
  // A flag, not the link. Meta will occasionally accept a video and decline
  // to say where it put it, and "live on Instagram" about a post that is also
  // on Facebook is the wrong half of the truth.
  has(pub, 'onFacebook ? "Instagram and Facebook" : "Instagram"', "the message names Facebook only when it worked");
  has(pub, "fb.ok ? fb.permalink ?? facebookPermalink(fb.postId) : null", "using the outcome, not the intent");

  const panel = readFileSync(`${SRC}/app/(app)/deliverables/[id]/publish-status.tsx`, "utf8");
  has(panel, "info.facebook ?", "the panel shows it only for a client who uses it");
  has(panel, "Waiting on the Instagram post", "and says why it has not happened yet");
  ok("nobody is told a post is on Facebook when the Page refused it");
}

/* ---------------- and there is a way back when the Page refuses -------- */
{
  const lib = readFileSync(`${SRC}/lib/facebook.ts`, "utf8");

  // The Instagram retry cannot do this job: it refuses anything already
  // posted, and rightly — re-running it would put the reel on Instagram a
  // second time. So a permissions failure, which is the first thing anyone
  // hits, had no recovery inside the portal at all.
  has(lib, "export async function publishToPageNow", "the Page can be posted to on its own");
  has(lib, 'if (row.facebook_status === "posted")', "but never twice");
  has(lib, "resolveVideoUrl(row.cloud_video_key", "and the media URL is resolved again");

  const ig = readFileSync(`${SRC}/lib/instagram.ts`, "utf8");
  has(ig, "WHERE id = ? AND instagram_status <> 'posted'", "which is why the IG retry cannot");

  const act = readFileSync(`${SRC}/app/(app)/deliverables/actions.ts`, "utf8");
  has(act, "export async function postToFacebookAction", "it has an action");
  has(act, "const user = await requireUser(SUPER_ADMIN_ROLES);", "reserved like Post now");

  const panel = readFileSync(`${SRC}/app/(app)/deliverables/[id]/publish-status.tsx`, "utf8");
  has(panel, "Try the Page again", "a refusal offers a retry");
  has(panel, "Post to the Page", "and a Page added later offers a first post");
  // Only once Instagram is done — before that the ordinary run will do it.
  has(panel, 'info.facebook.status !== "posted" && isTerminal', "offered only after the reel is live");
  ok("a Page that refused the video can be retried without touching Instagram");
}

/* ---------------- and you can tell whether it is connected at all ---------------- */
{
  const lib = readFileSync(`${SRC}/lib/facebook.ts`, "utf8");
  const page = readFileSync(`${SRC}/app/(app)/clients/[id]/page.tsx`, "utf8");

  /*
   * Asked, not assumed. The Instagram row beside this one goes green on
   * `ig_user_id` being non-empty, which only proves somebody typed a number —
   * and the number people type there most often is a Facebook Page id, which
   * looks right and never publishes. A badge earned that way answers the
   * question wrongly, which is worse than leaving it open.
   */
  has(lib, "export async function checkPageConnection", "the connection is checked against Meta");
  has(lib, "?fields=name&", "by asking for the Page's own name");
  has(lib, "if (nameJson.error || !nameJson.name)", "and no name means not connected");
  assert.ok(
    !/state: "connected"[\s\S]{0,80}Boolean\(pageId\)/.test(lib),
    "never green merely because the column is filled in"
  );

  /*
   * The name alone is not enough, and this was measured rather than reasoned:
   * a Page token reads a *different* Page's public name perfectly well, so a
   * token generated in Graph API Explorer with the wrong Page selected would
   * have come back green. `/{page-id}/roles` separates them — verified live
   * against a real Page token: `{"data":[]}` for the Page it administers,
   * `(#200) ... insufficient administrative permission` for one it does not.
   */
  has(lib, "/roles?", "so administration is checked too");
  has(lib, "rolesJson.error.code === 200", "and the wrong-Page case is named");
  has(lib, "Regenerate the token with", "with the fix in the message");

  /*
   * `tasks` is not a field on a Page node. It was asked for once, on the
   * assumption it reported what the token may do, and Meta answered "(#100)
   * nonexisting field (tasks)" — which this code would have shown as Not
   * connected for a Page that was working. Asserted so it cannot come back.
   */
  assert.ok(!/fields=name,tasks/.test(lib), "the tasks field is not asked for");
  assert.ok(!/canPost/.test(lib) && !/canPost/.test(page), "and the guess it fed is gone");

  // The three states are different things and read differently: off is not a
  // failure, and a permanent red on a client who does not use Facebook is how
  // people learn to ignore red.
  has(lib, 'if (!pageId) return { state: "off" }', "no Page id is off, not broken");
  has(lib, 'state: "broken"', "a refusal is broken");
  has(page, '"Not connected"', "which the badge says in those words");
  has(page, '"Not set up"', "and no Page id is neither");

  // The commonest cause by far, so it names where to fix it rather than
  // stating a fact about configuration.
  // Named the same way the field is, and the field is named the same way the
  // env var is. It used to say "Page access token" while the box said one
  // thing and META_ACCESS_TOKEN said another.
  has(lib, "paste this client's on their edit page, under Instagram automation", "a missing token says what to do");

  // It runs beside the plan queries, not after them: it is a network call to
  // Meta on a page somebody is waiting for.
  has(page, "checkPageConnection(c.id),", "the check is awaited in parallel");
  has(lib, "AbortSignal.timeout(8_000)", "and cannot hang the client page");
  ok("a client page says whether Facebook is connected, having actually asked");
}

/* ---------------- and it says the right thing about the wrong thing ---------------- */
{
  /*
   * Meta's real answers, pasted verbatim from live calls against a real Page
   * token. The advice attached to an error is the whole value of this
   * function — a message that sends somebody to fix a permission when the
   * actual fault is a typo in the Page id costs them an afternoon in Business
   * Settings.
   */
  const MISSING_OBJECT =
    "Unsupported get request. Object with ID '99999999999999' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api";
  const WRONG_PAGE =
    "(#10) This endpoint requires the 'pages_read_engagement' permission or the 'Page Public Content Access' feature or the 'Page Public Metadata Access' feature.";
  const NOT_ADMIN =
    "(#200) User does not have sufficient administrative permission for this action on this page.";

  /*
   * The ordering bug this block exists for: Meta's missing-object message
   * lists every possible cause, "missing permissions" among them, so the
   * permission catch-all matched a bad Page id first and told the user to go
   * and grant pages_manage_posts.
   */
  const missing = fb.explain(MISSING_OBJECT, 100);
  assert.match(missing, /check the Page id/i, "a Page id that does not exist blames the Page id");
  assert.ok(
    !/pages_manage_posts/.test(missing),
    "and never sends them to Business Settings for a typo"
  );

  // A Page token reads its own Page freely; needing a reviewed permission to
  // read this one means it belongs to a different Page.
  const wrong = fb.explain(WRONG_PAGE, 10);
  assert.match(wrong, /different Page selected/i, "a wrong-Page token says so");

  // The genuine permission case still gets the genuine advice.
  assert.match(
    fb.explain(NOT_ADMIN, 200),
    /pages_manage_posts/,
    "an actual permission refusal names the permission"
  );
  assert.match(
    fb.explain("Error validating access token: Session has expired", 190),
    /expired or invalid/i,
    "an expired token says to make a new one"
  );

  // Meta's own words survive in every case — the advice is appended, never
  // substituted, because the original is what is searchable.
  for (const [m, c] of [[MISSING_OBJECT, 100], [WRONG_PAGE, 10], [NOT_ADMIN, 200]]) {
    assert.ok(fb.explain(m, c).startsWith(m), "Meta's own message is kept");
  }
  assert.equal(fb.explain(undefined, undefined), "Facebook refused the post.", "and silence still says something");
  ok("each Meta error is explained as the thing that is actually wrong");
}


/* ---------------- the link actually goes somewhere ---------------- */
{
  /*
   * `/{page-id}/videos` returns two ids and they are not the same thing.
   * `post_id` is `<pageId>_<postId>` — a feed post, which lives at /posts/.
   * `id` alone is the video, and it does not live there: asked for its own
   * `permalink_url`, Meta answers `/reel/<id>/`.
   *
   * This built facebook.com/<id> for the second — a bare number after the
   * domain, which is a profile URL for somebody who does not exist. Every
   * video published without a feed post got a link that went nowhere, on a
   * page a client is shown.
   */
  assert.equal(
    fb.facebookPermalink("973697795837500_1122334455"),
    "https://www.facebook.com/973697795837500/posts/1122334455",
    "a feed post keeps its page and its post"
  );
  assert.equal(
    fb.facebookPermalink("3431135350380461"),
    "https://www.facebook.com/reel/3431135350380461/",
    "and a bare video id is a reel, which is what Meta itself returns"
  );
  assert.equal(fb.facebookPermalink(null), null, "nothing published, nothing linked");
  ok("a published video links to the video, not to a profile that is not there");
}
/* ---------------- and the client is sent the link that exists ---------------- */
{
  /*
   * The live-post message sent `instagram_permalink` and nothing else, so a
   * reel published to the client's Facebook Page and not to Instagram arrived
   * with no link at all — a message telling somebody their post is live and
   * giving them no way to look at it. The button said Instagram either way.
   */
  const route = fs2.readFileSync(`${SRC}/app/api/automation/notify/route.ts`, "utf8");
  assert.ok(route.includes("d.facebook_post_id"), "the Facebook post is read too");
  assert.ok(
    route.includes("target.permalink || fbLink"),
    "and used when there is no Instagram link"
  );
  assert.ok(
    !route.includes('platform: "Instagram" }'),
    "the platform in the button is no longer assumed"
  );
  ok("a post that went to Facebook is linked to on Facebook");
}

/* ---------------- a Page id filled in later still gets the post -------- */
{
  const pub = readFileSync(`${SRC}/lib/instagram-publish.ts`, "utf8");
  has(pub, "async function catchUpFacebook(", "the run tidies up after itself");

  /*
   * The gap it closes is the common order, not the exotic one: the reel goes
   * out, the client asks for Facebook too, the Page id is filled in the next
   * day — and nothing is left to schedule, because the publisher only looks
   * at what is due and the Instagram half is done. Silent, because no Page id
   * is a skip rather than a failure, which is right for the many clients here
   * who are Instagram only.
   */
  has(pub, "d.facebook_status = 'not_posted'", "only what was never attempted");
  assert.ok(
    !/facebook_status\s*(IN|=)\s*\(?'failed'/.test(pub),
    "a failure is not retried every quarter hour for ever"
  );
  has(pub, "c.fb_page_id IS NOT NULL AND TRIM(c.fb_page_id) <> ''", "and only where there is a Page");

  /*
   * Three days, and the reason is not politeness. Without a floor the first
   * run after this shipped would have posted every video the portal has ever
   * published to every Page it can reach — a year of backlog onto a client's
   * timeline in one afternoon.
   */
  has(pub, "3 * 86_400_000", "bounded to the last three days");
  assert.ok(
    !/instagram_posted_at\s*>=\s*NOW\(\)/.test(pub),
    "measured on our clock, not the database's — this one keeps IST and the column is UTC"
  );

  // After the queue and unable to spoil it: a post that is due is the job,
  // a Page that got missed is tidying up.
  const loopEnd = pub.indexOf("const caughtUp = await catchUpFacebook(");
  assert.ok(loopEnd > pub.indexOf("const due = await getPublishQueue(limit)"), "it runs after the queue");
  has(pub, "await catchUpFacebook(2).catch(() => [])", "and cannot fail the run");

  // Not silently, which is the whole shape of the bug being fixed.
  const route = fs2.readFileSync(`${SRC}/app/api/automation/publish/run/route.ts`, "utf8");
  assert.ok(route.includes("summary.facebookCaughtUp"), "the run says when it caught one up");
  ok("a Page id added after the reel went out is picked up on the next run");
}

await finish(pass);
