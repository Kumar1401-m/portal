/**
 * The Facebook link is Meta's answer, not our arithmetic.
 *
 * Every Facebook link this portal showed was *derived* from a stored id: a
 * composite `{page}_{post}` became a /posts/ link, a bare id became a /reel/
 * one. Both forms were checked against a real Page when they were written,
 * and both are kept — old rows have nothing else to go on.
 *
 * But deriving an address means knowing which surface Meta filed the post
 * under, and an id does not carry that. The same id is a Reel or a feed post
 * depending on how Meta handled it, and when the guess is wrong the link
 * opens something else — on the client's own account, in the message telling
 * them their post is live, beside an Instagram link that is correct.
 *
 * Meta answers the question directly: `permalink_url`. It is asked for at the
 * moment of publishing and kept, and from then on nothing is worked out.
 *
 * NOTE: the underlying report — a wrong Facebook link on a real post — has
 * not been reproduced against the live Graph API, which needs a working Meta
 * token. This removes the class of fault rather than confirming the instance.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const fb = await import(pathToFileURL(`${SRC}/lib/facebook.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * What is stored beats what can be derived
 * ------------------------------------------------------------------ */
{
  const real = "https://www.facebook.com/100064/videos/1234567890/";
  assert.equal(
    fb.facebookLinkOf({ facebook_permalink: real, facebook_post_id: "1234567890" }),
    real,
    "Meta's own answer is used when we have it"
  );

  /*
   * A composite id is a genuine post address and still works, which is what
   * every photo posted before this change has.
   */
  assert.equal(
    fb.facebookLinkOf({ facebook_permalink: null, facebook_post_id: "100064_9988" }),
    "https://www.facebook.com/100064/posts/9988",
    "a photo's post id still makes its own link"
  );

  /*
   * A bare id still falls back to the /reel/ form, which the note in the
   * source records as checked against a real Page. It is kept deliberately:
   * rows published before the link was stored have nothing else, and swapping
   * a link that works for none would be worse than the problem.
   */
  assert.equal(
    fb.facebookLinkOf({ facebook_permalink: null, facebook_post_id: "1234567890" }),
    "https://www.facebook.com/reel/1234567890/",
    "an old row still gets the best link that can be derived"
  );
  assert.equal(fb.facebookLinkOf({}), null, "and nothing yields nothing");

  /*
   * The point of the change: what Meta said outranks anything derived. An id
   * cannot say which surface a post was filed under, and the same id can be a
   * Reel or a feed post depending on how Meta handled it.
   */
  assert.equal(
    fb.facebookLinkOf({ facebook_permalink: real, facebook_post_id: "100064_9988" }),
    real,
    "the stored answer wins even when an id could have produced one"
  );
  ok("a Facebook link is Meta's answer first, and only then something derived");
}

/* ------------------------------------------------------------------ *
 * It is asked for at the moment of publishing
 * ------------------------------------------------------------------ */
{
  const src = read("lib/facebook.ts");
  assert.ok(src.includes("fields=permalink_url"), "Meta is asked where the post went");
  assert.ok(src.includes("async function pagePermalink("), "by a helper of its own");

  /*
   * Best-effort, and that matters: a failed lookup must never turn a
   * published post into a failed one. The post is on the Page either way.
   */
  assert.ok(
    src.includes("  } catch {\n    return null;\n  }\n}\n\nasync function record("),
    "and a failure there returns null rather than throwing"
  );
  assert.ok(
    src.includes("return { ok: true, postId, permalink, onFeed: Boolean(feedStory) };"),
    "the caller gets the link, not just the id"
  );

  /*
   * And whether there is a post at all.
   *
   * `post_id` is a story on the Page; `id` alone is not. A photo returns both.
   * A video can return `id` and nothing else — Meta has taken the file into
   * the Page's video library and made no story for it, so nothing is on the
   * timeline and no follower scrolling past ever sees it. This read
   * `post_id || id` and called both "posted", which is why an invisible post
   * looked identical to a published one on every screen in the portal.
   */
  assert.ok(src.includes("const feedStory = json.post_id ?? null;"), "the two are told apart");
  assert.ok(
    src.includes("no post on the "),
    "and the row says why nothing is on the Page"
  );

  const pub = read("lib/instagram-publish.ts");
  assert.ok(pub.includes("if (fb.ok && !fb.onFeed) {"), "somebody is told about it");
  assert.ok(
    pub.includes("fb.ok && fb.onFeed\n  );"),
    "and the client is not told their post is live somewhere it is not"
  );

  /*
   * Stored behind a column check, like every other column that arrived with a
   * later migration. Named unconditionally it is a hard SQL error on a
   * database that has not run it — and this one is in the path that records a
   * successful publish.
   */
  assert.ok(
    src.includes('hasColumn("deliverables", "facebook_permalink")'),
    "and stored only where the column exists"
  );
  ok("the link is captured when it is known, and never at the cost of the post");
}

/* ------------------------------------------------------------------ *
 * Everything that shows a link goes through the one helper
 * ------------------------------------------------------------------ */
{
  for (const f of [
    "lib/whatsapp-ai.ts",
    "app/api/automation/notify/route.ts",
  ]) {
    const s = read(f);
    assert.ok(s.includes("facebookLinkOf("), `${f} uses the shared helper`);
    assert.ok(
      s.includes('hasColumn("deliverables", "facebook_permalink")'),
      `${f} guards the column it reads`
    );
  }

  /*
   * The client's "it's live" message takes the resolved link, not an id to
   * guess from — and takes separately whether it reached the Page at all,
   * because Meta will occasionally accept a video and decline to say where it
   * put it. "Live on Instagram" about a post that is also on Facebook is the
   * wrong half of the truth.
   */
  const pub = read("lib/instagram-publish.ts");
  assert.ok(pub.includes("onFacebook: boolean"), "the message is told whether it went to the Page");
  assert.ok(
    pub.includes('const where = onFacebook ? "Instagram and Facebook" : "Instagram";'),
    "and says so from that, not from whether a link exists"
  );
  ok("one definition of the Facebook link, everywhere it is shown");
}

await finish(pass);
