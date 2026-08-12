/**
 * The YouTube publisher: same video, same minute, separate failure.
 *
 * The queue and the claim are the parts worth pinning. A queue that returns a
 * video whose slot has gone puts a Short on a client's channel at 3am; a claim
 * that two runs can both win puts two copies on it.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const db = await load("lib/db.ts");
const yt = await load("lib/youtube.ts");
const ig = await load("lib/instagram.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const TAG = "ZZ yt client";
const OFF = "ZZ yt optedout";
const MONTH = new Date().toISOString().slice(0, 7);
const clean = async () => {
  await db.execute(
    "DELETE FROM deliverables WHERE client_id IN (SELECT id FROM clients WHERE company_name IN (?,?))",
    [TAG, OFF]
  );
  await db.execute("DELETE FROM clients WHERE company_name IN (?,?)", [TAG, OFF]);
};
await clean();

const mkClient = async (name, enabled) =>
  Number(
    (await db.execute(
      `INSERT INTO clients (company_name, status, youtube_enabled, auto_publish, ig_user_id)
       VALUES (?, 'active', ?, 1, '17841400000000000')`,
      [name, enabled]
    )).insertId
  );
const on = await mkClient(TAG, 1);
const off = await mkClient(OFF, 0);

/** A UTC datetime `mins` minutes from now, as the app writes them. */
const at = (mins) =>
  new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace("T", " ");

const mk = async (clientId, title, ytStatus, scheduledAt, category = "Instagram Reel") =>
  Number(
    (await db.execute(
      `INSERT INTO deliverables
         (client_id, title, status, month_key, content_category, caption, hashtags,
          cloud_video_url, scheduled_at, youtube_status, instagram_status)
       VALUES (?, ?, 'approved', ?, ?, 'Look at this', '#one #two', 'https://cdn.test/v.mp4', ?, ?, 'scheduled')`,
      [clientId, title, MONTH, category, scheduledAt, ytStatus]
    )).insertId
  );

/* ---------------- the queue is the same question as Instagram's ---------------- */
{
  const due = await mk(on, "ZZ due now", "scheduled", at(-5));
  await mk(on, "ZZ not yet", "scheduled", at(120));
  await mk(on, "ZZ slot gone", "scheduled", at(-60 * 5));
  await mk(on, "ZZ already up", "posted", at(-5));
  await mk(off, "ZZ client opted out", "scheduled", at(-5));

  const q = await yt.getYouTubeQueue(20);
  const titles = q.map((i) => i.title);
  assert.deepEqual(
    titles.filter((t) => t.startsWith("ZZ")),
    ["ZZ due now #Shorts"],
    `only the one that is due, got: ${titles.join(" | ")}`
  );
  ok("due now only — not early, not a slot that has gone, not one already up");

  const item = q.find((i) => i.title.startsWith("ZZ due now"));
  assert.equal(item.deliverable_id, due);
  assert.equal(item.video_url, "https://cdn.test/v.mp4", "n8n is told where to download it");
  assert.equal(item.description, "Look at this\n\n#one #two", "the caption becomes the description");
  assert.deepEqual(item.tags, ["one", "two"], "and the hashtags become tags, without the #");
  assert.equal(item.privacy_status, "public");
  ok("each item carries the file, the title, the description and the tags");

  // The opt-in is per client and the whole point of it.
  assert.ok(!titles.some((t) => t.includes("opted out")), "a client who did not ask is never queued");
  ok("nothing is uploaded for a client who has not opted in");
}

/* ---------------- a Reel becomes a Short, other formats do not ---------------- */
{
  assert.equal(yt.youtubeTitle("Diwali reel", true), "Diwali reel #Shorts");
  assert.equal(yt.youtubeTitle("Diwali reel", false), "Diwali reel");
  assert.equal(yt.youtubeTitle(null, false), "Untitled");
  // < and > are rejected outright by the API.
  assert.equal(yt.youtubeTitle("a <b> c", false), "a b c");

  // 100 characters is the hard limit, and the suffix counts against it — so
  // the room is reserved before truncating rather than bolted on after.
  const long = "x".repeat(200);
  const t = yt.youtubeTitle(long, true);
  assert.ok(t.length <= 100, `a long title fits in 100, got ${t.length}`);
  assert.ok(t.endsWith(" #Shorts"), "and still says Shorts");
  ok("titles fit YouTube's 100 characters with #Shorts intact");
}

/* ---------------- tags stay inside YouTube's own limit ---------------- */
{
  const many = Array.from({ length: 40 }, (_, i) => `#tag${i}averyverylongtagname`).join(" ");
  const tags = yt.youtubeTags(many);
  assert.ok(tags.length <= 15, `capped at 15, got ${tags.length}`);
  const total = tags.join(",").length;
  assert.ok(total < 500, `total under 500 characters, got ${total}`);
  assert.deepEqual(yt.youtubeTags("#food #food #cafe"), ["food", "cafe"], "duplicates go");
  assert.deepEqual(yt.youtubeTags("#a #b"), [], "and so do single letters, which search on nothing");
  assert.deepEqual(yt.youtubeTags(null), []);
  ok("tags are deduped and kept under the 500-character total YouTube rejects on");
}

/* ---------------- two runs cannot both take the same video ---------------- */
{
  const id = await mk(on, "ZZ race", "scheduled", at(-5));
  const [a, b] = await Promise.all([yt.claimForYouTube(id, "run-a"), yt.claimForYouTube(id, "run-b")]);
  const winners = [a, b].filter((r) => r.ok);
  assert.equal(winners.length, 1, "exactly one run gets it");
  const loser = [a, b].find((r) => !r.ok);
  assert.equal(loser.reason, "claimed_elsewhere");
  ok("a race for one video has exactly one winner — no channel gets two copies");

  const row = await db.queryOne(
    "SELECT youtube_status, youtube_attempts FROM deliverables WHERE id = ?",
    [id]
  );
  assert.equal(row.youtube_status, "processing");
  assert.equal(Number(row.youtube_attempts), 1, "one attempt spent, not two");
  ok("the loser's attempt is not charged against the budget");
}

/* ---------------- the result, both ways ---------------- */
{
  const id = await mk(on, "ZZ result", "scheduled", at(-5));
  await yt.claimForYouTube(id);

  // A failure that might pass next time goes back in the queue.
  await yt.recordYouTubeResult({ deliverableId: id, status: "failed", errorMessage: "backendError" });
  let row = await db.queryOne(
    "SELECT youtube_status, youtube_error FROM deliverables WHERE id = ?",
    [id]
  );
  assert.equal(row.youtube_status, "scheduled", "a transient failure waits for another run");
  assert.match(row.youtube_error, /backendError/);

  // One it will never pass stops there.
  await yt.claimForYouTube(id);
  await yt.recordYouTubeResult({
    deliverableId: id,
    status: "failed",
    errorMessage: "invalid_grant",
    permanent: true,
  });
  row = await db.queryOne("SELECT youtube_status FROM deliverables WHERE id = ?", [id]);
  assert.equal(row.youtube_status, "failed", "a permanent failure stops");
  ok("a failure either waits for another go or stops, and says which");

  await yt.retryYouTube(id);
  await yt.claimForYouTube(id);
  await yt.recordYouTubeResult({ deliverableId: id, status: "posted", videoId: "dQw4w9WgXcQ" });
  row = await db.queryOne(
    "SELECT youtube_status, youtube_video_id, youtube_url, youtube_posted_at FROM deliverables WHERE id = ?",
    [id]
  );
  assert.equal(row.youtube_status, "posted");
  assert.equal(row.youtube_url, "https://youtu.be/dQw4w9WgXcQ", "the link is derived when not given");
  assert.ok(row.youtube_posted_at, "and the time it went live is kept");
  ok("a success stores the id, the watch link and when it went up");

  // Idempotent both ways: a duplicate success changes nothing, and a late
  // failure callback can never un-post a live video.
  const before = row.youtube_posted_at;
  await yt.recordYouTubeResult({ deliverableId: id, status: "posted", videoId: "OTHER" });
  await yt.recordYouTubeResult({ deliverableId: id, status: "failed", errorMessage: "late" });
  row = await db.queryOne(
    "SELECT youtube_status, youtube_video_id, youtube_posted_at FROM deliverables WHERE id = ?",
    [id]
  );
  assert.equal(row.youtube_status, "posted", "still posted");
  assert.equal(String(row.youtube_posted_at), String(before), "and the original time stands");
  const claim = await yt.claimForYouTube(id);
  assert.equal(claim.reason, "already_posted", "and it can never be claimed again");
  ok("posting is idempotent — a replay or a late failure cannot undo it");
}

/* ---------------- scheduling hands off to both at once ---------------- */
{
  assert.deepEqual(
    yt.youtubeHandoff({ youtube_enabled: 1, youtube_status: "none" }),
    { youtube_status: "scheduled" },
    "an opted-in client's video joins the YouTube queue when it is scheduled"
  );
  assert.deepEqual(yt.youtubeHandoff({ youtube_enabled: 0 }), {}, "and an opted-out one does not");
  assert.deepEqual(
    yt.youtubeHandoff({ youtube_enabled: 1, youtube_status: "posted" }),
    {},
    "something already up is history, not a queue entry"
  );

  // Same window as Instagram, which is what makes them go out together.
  assert.equal(yt.MAX_UPLOAD_ATTEMPTS, 3);
  const actions = readFileSync(`${SRC}/app/(app)/deliverables/actions.ts`, "utf8");
  assert.match(
    actions,
    /Object\.assign\(updates, publishHandoff\(d\)\);[\s\S]{0,300}youtubeHandoff\(d\)/,
    "one Schedule press queues both platforms"
  );
  ok("pressing Schedule queues Instagram and YouTube from the same slot");
}

/* ---------------- the runner is importable and points at the real endpoints ---------------- */
{
  const wf = JSON.parse(readFileSync(`${SRC}/../../n8n/workflows/youtube-runner.json`, "utf8"));
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, spec] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), `${from} exists`);
    for (const branch of spec.main) {
      for (const c of branch) assert.ok(names.has(c.node), `${c.node} exists`);
    }
  }
  const urls = wf.nodes.map((n) => n.parameters?.url).filter((u) => typeof u === "string");
  for (const path of ["/youtube/queue", "/youtube/claim", "/youtube/result"]) {
    assert.ok(urls.some((u) => u.includes(path)), `the workflow calls ${path}`);
  }
  // Both failure paths must report, or a claimed row sits until its lease
  // expires and the video silently misses its slot.
  assert.deepEqual(
    wf.connections["Download the video"].main[1],
    [{ node: "Tell the portal it failed", type: "main", index: 0 }],
    "a download that fails is reported"
  );
  assert.deepEqual(
    wf.connections["Upload to YouTube"].main[1],
    [{ node: "Tell the portal it failed", type: "main", index: 0 }],
    "and so is an upload that fails"
  );
  ok("the n8n workflow is valid, wired to the real endpoints, and reports both failures");
}

await clean();
await finish(pass);
