/**
 * An approval is the last thing anybody does.
 *
 * Three places accept one — the desk, the client portal, and a reply in the
 * client's WhatsApp group — and each used to decide for itself what an
 * approval was allowed to set in motion:
 *
 *   the portal      five conditions, written out inline
 *   WhatsApp        two of them, so a poster or a video-less reel was marked
 *                   scheduled and handed to a queue that would never return it
 *   the desk        none, because the desk did not schedule at all — approving
 *                   left the row at `approved` and a person pressed Schedule
 *
 * They drifted because each worked from whatever columns its own query
 * happened to select. `approvalHandoff` reads the row itself, so all three ask
 * the same question, and this file is what fails when a fourth path is written
 * that does not.
 *
 * ## The narrowness is the feature
 *
 * Nothing here infers consent. A client who has not ticked auto-publish, one
 * with no Instagram account on file, a poster, a task with no finished video —
 * every one of those still stops at "approved" and waits for a person. This
 * removes the clicking, not the decision.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const ig = await import(pathToFileURL(`${SRC}/lib/instagram.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);
const wa = await import(pathToFileURL(`${SRC}/lib/whatsapp-approvals.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ appr%'");
  await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ appr%'");
};

/** A client and one finished reel of theirs, waiting on a yes. */
async function fixture({
  autoPublish = 1,
  igUserId = "17841400000000000",
  category = "Instagram Reel",
  service = "video_editing",
  video = true,
  link = "https://example.com/zz.mp4",
} = {}) {
  const cid = Number(
    (
      await db.execute(
        `INSERT INTO clients (company_name, status, auto_publish, ig_user_id, placeholder_values)
         VALUES ('ZZ appr client', 'active', ?, ?, ?)`,
        [autoPublish, igUserId, JSON.stringify({ country: "India" })]
      )
    ).insertId
  );
  const did = Number(
    (
      await db.execute(
        `INSERT INTO deliverables (client_id, title, status, content_category, service, edited_link, scheduled_at)
         VALUES (?, 'ZZ appr reel', 'review', ?, ?, ?, NULL)`,
        [cid, category, service, video ? link : null]
      )
    ).insertId
  );
  return { cid, did };
}

/* ------------------------------------------------------------------ *
 * Set up to post: approving schedules it, nobody clicks anything
 * ------------------------------------------------------------------ */
{
  await clean();
  const f = await fixture();
  try {
    const out = await ig.approvalHandoff(f.did);
    assert.equal(out.status, "scheduled", "the task moves itself to scheduled");
    assert.equal(out.instagram_status, "scheduled", "the publishing queue is told");
    assert.equal(out.posting_status, "scheduled", "and so is the board");

    /*
     * A time, and a future one. The queue only returns rows whose slot has
     * arrived, so a null time is never due and never posts — which is exactly
     * what "approved and queued for nothing" looked like.
     */
    assert.ok(out.scheduled_at, "with a time on it");
    assert.ok(
      new Date(String(out.scheduled_at).replace(" ", "T") + "Z").getTime() > Date.now(),
      "in the future, not the moment somebody happened to answer"
    );
    ok("an approval on a video that is set up to post hands it straight to the publisher");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * Every reason it stays a plain approval
 * ------------------------------------------------------------------ */
{
  for (const [why, opts] of [
    ["auto-publish is off for the client", { autoPublish: 0 }],
    ["no Instagram account is linked", { igUserId: null }],
    ["a long video is not a reel", { category: "YouTube Long Video" }],
    ["there is no finished file yet", { video: false }],
    /*
     * A thumbnail is made for a YouTube video and a banner for a website.
     * Both are poster work; neither belongs on a feed.
     */
    ["a thumbnail is not a post", { service: "poster_designing", category: "Thumbnail", link: "https://x/t.png" }],
    ["a banner is not a post", { service: "poster_designing", category: "Banner", link: "https://x/b.png" }],
    /*
     * And the one that matters most for posters: a designer submits a Canva
     * address, which is a web app, not a file. Meta fetches the page, refuses
     * it, and spends an attempt — four times — on a poster that cannot
     * succeed until the image itself is uploaded.
     */
    [
      "the only link is a Canva page, not a file",
      { service: "poster_designing", category: "Offer Poster", link: "https://www.canva.com/design/DAF123/view" },
    ],
  ]) {
    await clean();
    const f = await fixture(opts);
    try {
      const out = await ig.approvalHandoff(f.did);
      assert.deepEqual(out, {}, `${why}: nothing is scheduled`);
    } finally {
      await clean();
    }
  }
  ok("approving is never read as consent to start posting automatically");
}

/* ------------------------------------------------------------------ *
 * A poster is a post too, and goes out as one
 * ------------------------------------------------------------------ */
{
  /*
   * Posters used to stop at "approved" for ever. Not by a decision — the gate
   * was one category name, `"Instagram Reel"`, so a poster could not match it
   * and nothing said why. Every poster in the portal was published by hand.
   */
  for (const [what, opts] of [
    ["the image is in our own storage", { service: "poster_designing", category: "Offer Poster", link: "https://cdn/x.png" }],
    [
      // What a designer actually pastes. Drive serves an HTML page at the
      // share address and the same file at a download one, and the publisher
      // rewrites between them.
      "the designer pasted a Drive link",
      {
        service: "poster_designing",
        category: "Festival Poster",
        link: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing",
      },
    ],
  ]) {
    await clean();
    const f = await fixture(opts);
    try {
      const out = await ig.approvalHandoff(f.did);
      assert.equal(out.status, "scheduled", `${what}: the poster is scheduled`);
      assert.ok(out.scheduled_at, `${what}: with a time on it`);
    } finally {
      await clean();
    }
  }
  ok("an approved poster is scheduled exactly as a reel is");
}

/* ------------------------------------------------------------------ *
 * And is published as a photo, on both platforms
 * ------------------------------------------------------------------ */
{
  const posting = await import(pathToFileURL(`${SRC}/lib/posting.ts`).href);
  const poster = { service: "poster_designing", content_category: "Offer Poster" };
  const reel = { service: "video_editing", content_category: "Instagram Reel" };

  assert.equal(posting.autoPostKind(poster), "IMAGE", "a poster publishes as a photo");
  assert.equal(posting.autoPostKind(reel), "REELS", "a reel as a reel");
  assert.equal(
    posting.autoPostKind({ service: null, video_type: "Poster", content_category: "Offer Poster" }),
    "IMAGE",
    "and a legacy row with no service still reads as a poster"
  );

  /*
   * The container is the half that was impossible to get right by accident.
   * Instagram takes `image_url` for a photo and `video_url` for a reel, and
   * this sent `video_url` whatever it held — so a poster was offered as a
   * video with no video in it, and Meta's error named the field that *was*
   * sent rather than the one that should have been.
   */
  const pub = read("lib/instagram-publish.ts");
  assert.ok(
    pub.includes('? { image_url: item.video_url }'),
    "a photo container is built with image_url"
  );
  assert.ok(
    pub.includes(': { video_url: item.video_url, media_type: "REELS" }'),
    "and a reel with video_url and its media_type"
  );

  /*
   * Facebook takes the same decision at its own endpoint, and the media kind
   * now comes from the task rather than from a substring of its category
   * name — which was right about "Educational Poster" only by luck.
   */
  const fb = read("lib/facebook.ts");
  assert.ok(fb.includes('mediaType === "IMAGE" ? "photos" : "videos"'), "a photo goes to /photos");
  assert.ok(
    fb.includes("mediaTypeFor(row.cloud_video_key || mediaUrl, row.content_category, row)"),
    "and the standalone Page button asks the same question the queue does"
  );

  /*
   * YouTube must not be offered one at all. Its upload queue filters on
   * `youtube_status` and no media kind is among its conditions, so a JPEG
   * queued there would be handed to it as a Short.
   */
  const yt = await import(pathToFileURL(`${SRC}/lib/youtube.ts`).href);
  assert.deepEqual(
    yt.youtubeHandoff({ youtube_enabled: 1, youtube_status: "not_posted", ...poster }),
    {},
    "a poster is never queued for YouTube"
  );
  assert.deepEqual(
    yt.youtubeHandoff({ youtube_enabled: 1, youtube_status: "not_posted", ...reel }),
    { youtube_status: "scheduled" },
    "a reel still is"
  );
  ok("one media kind, and Instagram, Facebook and YouTube all read it the same way");
}

/* ------------------------------------------------------------------ *
 * A time somebody chose is never overwritten
 * ------------------------------------------------------------------ */
{
  await clean();
  const f = await fixture();
  const chosen = "2030-01-01 12:30:00";
  await db.execute("UPDATE deliverables SET scheduled_at = ? WHERE id = ?", [chosen, f.did]);
  try {
    const out = await ig.approvalHandoff(f.did);
    assert.equal(out.status, "scheduled", "it is still handed to the queue");
    assert.equal(out.scheduled_at, undefined, "and the time a person picked is left alone");
    ok("scheduling fills a blank and never argues with a decision already made");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * A posted video is history, not a queue entry
 * ------------------------------------------------------------------ */
{
  await clean();
  const f = await fixture();
  await db.execute("UPDATE deliverables SET instagram_status = 'posted' WHERE id = ?", [f.did]);
  try {
    assert.deepEqual(await ig.approvalHandoff(f.did), {}, "nothing is re-queued");
    ok("an approval cannot put a published post back in the queue");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * All three paths ask the one question
 * ------------------------------------------------------------------ */
{
  for (const [f, what] of [
    ["app/(app)/deliverables/actions.ts", "the desk"],
    ["app/portal/actions.ts", "the client portal"],
    ["lib/whatsapp-approvals.ts", "a reply in the WhatsApp group"],
  ]) {
    const s = read(f);
    assert.ok(s.includes("approvalHandoff("), `${what} uses the shared handoff`);
    /*
     * And does not keep its own copy of the conditions beside it. This is the
     * assertion that catches the drift rather than its symptoms: the WhatsApp
     * path had `auto_publish === 1 && ig_user_id` written out locally, which
     * looked complete and was missing the two checks that mattered.
     */
    assert.ok(
      !s.includes("Number(row.auto_publish) === 1 && row.ig_user_id"),
      `${what} does not carry a second copy of the conditions`
    );
  }

  /*
   * The desk in particular: approving now schedules, where it used to set an
   * approval flag and stop. That one line was the whole of the manual step.
   */
  const desk = read("app/(app)/deliverables/actions.ts");
  assert.ok(
    desk.includes("Object.assign(updates, await approvalHandoff(id));"),
    "approving at the desk schedules in the same write"
  );
  ok("one definition of what an approval sets in motion, in all three places");
}

/* ------------------------------------------------------------------ *
 * And end to end, through the path a client actually uses
 * ------------------------------------------------------------------ */
{
  /*
   * The blocks above test the handoff. This tests that a real "OK" typed into
   * a WhatsApp group reaches it — which is the case that was broken, and the
   * one where the whole chain has to hold: the reply is matched to a video,
   * the approval is recorded, and the row lands in the publisher's queue
   * without anybody opening the portal.
   */
  await clean();
  const f = await fixture();
  const group = `zz-appr-${f.cid}@g.us`;
  await wa.linkGroup(f.cid, group, "ZZ appr client", true);
  await db.execute(
    "UPDATE deliverables SET video_code = 'ZA901', wa_status = 'sent', wa_group_id = ? WHERE id = ?",
    [group, f.did]
  );
  try {
    const res = await wa.recordApproval({
      videoCode: "ZA901",
      command: "approve",
      groupId: group,
      approvedBy: "Venkat",
      waMessageId: "zz-appr-msg-1",
      message: "OK",
    });
    assert.equal(res.ok, true, `the approval is accepted (${res.error ?? ""})`);

    const row = await db.queryOne(
      "SELECT status, instagram_status, posting_status, scheduled_at FROM deliverables WHERE id = ?",
      [f.did]
    );
    assert.equal(row.status, "scheduled", "and the task moved itself to scheduled");
    assert.equal(row.instagram_status, "scheduled", "the publishing queue was told");
    assert.equal(row.posting_status, "scheduled", "and so was the board");
    assert.ok(row.scheduled_at, "with a time on it");
    ok("an OK in the group is the last human act — nothing waits for a click");
  } finally {
    await db.execute("DELETE FROM whatsapp_send_log WHERE video_code LIKE 'ZA%'");
    await db.execute("DELETE FROM whatsapp_groups WHERE group_id LIKE 'zz-appr%'");
    await db.execute(
      "DELETE FROM activity_logs WHERE entity_type='deliverable' AND description LIKE '%ZZ appr%'"
    );
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * The publisher is actually triggered often enough to serve a window
 * ------------------------------------------------------------------ */
{
  const cron = JSON.parse(readFileSync(`${SRC}/../vercel.json`, "utf8"));
  const publish = cron.crons.find((c) => c.path === "/api/automation/publish/run");
  assert.ok(publish, "the daily backstop still exists");

  /*
   * India posts 5–7 PM IST, which is 11:30–13:30 UTC. A once-a-day run has to
   * land near the *start* of that, or a reel it finds still encoding is handed
   * back with nothing left to look at it again before the slot expires. It
   * used to run at 13:15 — fifteen minutes of margin.
   */
  const [minute, hour] = publish.schedule.split(" ");
  const at = Number(hour) * 60 + Number(minute);
  assert.ok(at >= 11 * 60 + 30, "it fires inside India's window, not before it opens");
  assert.ok(at <= 12 * 60 + 30, "and early enough in it to come back for a slow encode");
  ok("the daily backstop lands where a video it starts can still be finished");
}

await finish(pass);
