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
