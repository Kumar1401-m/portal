/**
 * The same post, on the client's Facebook Page.
 *
 * The rule this must not break: by the time Facebook is attempted, the reel is
 * already live on Instagram and the row says so. A Page that refuses the video
 * is a thing to record — marking the publish failed would invite a retry, and
 * the retry would post to Instagram a second time.
 */
import assert from "node:assert/strict";
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

  // /{page}/videos with file_url is chosen over the Reels API because Meta
  // fetches the bytes — the Reels endpoint is a resumable upload, the one
  // shape a serverless function cannot do. Same reason YouTube runs on n8n.
  assert.ok(!/video_reels/.test(lib), "the resumable Reels upload is not used here");
  ok("a poster and a video each go to the endpoint that takes them");
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
  has(lib, 'await record(deliverableId, "posted", postId, null)', "and so is a success");

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
  has(pub, 'onFacebook ? "Instagram and Facebook" : "Instagram"', "the message names Facebook only when it worked");
  has(pub, "await tellTheClient(item, permalink, fb.ok);", "using the outcome, not the intent");

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

await finish(pass);
