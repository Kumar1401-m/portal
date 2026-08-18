/**
 * The poster chain, end to end.
 *
 * It was broken in the quietest possible way. A poster is created at
 * `pending`, and the only thing that ever moved it on was the content-approval
 * desk — so when that came out, every poster stopped where it was created. No
 * error, no empty state: the designer's queue simply never showed a submit box
 * for a poster nobody could see was stuck.
 *
 * So the test walks the whole route a poster takes, and the first assertion is
 * the one that would have caught it.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const posters = await load("lib/posters.ts");
const db = await load("lib/db.ts");
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- the four stages a poster passes through ---------------- */
{
  // Created, and not yet anybody's to design.
  assert.equal(posters.posterAwaitingContent("pending"), true);
  assert.equal(posters.posterWithDesigner("pending"), false, "a fresh poster is not the designer's");

  // Content written and handed over — this is the transition that was missing.
  assert.equal(posters.posterWithDesigner("waiting_for_raw"), true, "once sent, it is theirs");
  assert.equal(posters.posterAwaitingContent("waiting_for_raw"), false);

  // Submitted, with the super admin.
  assert.equal(posters.posterInReview("caption_ready"), true);
  assert.equal(posters.posterWithDesigner("caption_ready"), false, "and off the designer's to-do");

  // Sent to the client, then approved.
  assert.equal(posters.posterInReview("review"), true);
  assert.equal(posters.posterDone("approved"), true);

  // Sent back: the designer's again, and their submit box returns.
  assert.equal(posters.posterWithDesigner("changes_requested"), true);
  ok("pending → designer → super admin → client → done, and back again on a change");
}

/* ---------------- every stage is somebody's, and only one ---------------- */
{
  // A status belonging to two stages at once would put the same poster in two
  // queues; one belonging to none makes it vanish off every board.
  for (const s of [
    "pending", "content_review", "waiting_for_raw", "raw_uploaded", "editing",
    "changes_requested", "resolved", "caption_ready", "review", "approved", "completed",
  ]) {
    const stages = [
      posters.posterAwaitingContent(s),
      posters.posterWithDesigner(s),
      posters.posterInReview(s),
      posters.posterDone(s),
    ].filter(Boolean).length;
    assert.equal(stages, 1, `"${s}" belongs to exactly one stage, not ${stages}`);
  }
  ok("no status is in two queues at once, and none falls out of all of them");
}

/* ---------------- the designer sees what to design ---------------- */
{
  // A designer designing from a title designs it twice. The brief the super
  // admin wrote has to reach their card.
  const lib = read("lib/posters.ts");
  assert.match(lib, /d\.description/, "the brief is selected");
  assert.match(lib, /description: string \| null;/, "and typed on the row");

  const queue = read("app/(app)/my-work/poster-queue.tsx");
  assert.match(queue, /On the poster/, "and shown on their card");
  assert.match(queue, /<PosterSubmitForm/, "beside the box they submit from");
  ok("the designer reads the brief on the same card they submit from");
}

/* ---------------- the content gate is a person, not the model ---------------- */
{
  const actions = read("app/(app)/poster/actions.ts");
  // Drafting and sending are separate calls on purpose: what a client's
  // poster says is the agency's responsibility, and a generated line nobody
  // read is the opposite of that.
  assert.match(actions, /export async function draftPosterContentAction/);
  assert.match(actions, /export async function sharePosterWithDesigner/);
  assert.match(actions, /Drafted, not applied/i);
  assert.ok(
    !/status = 'waiting_for_raw'/.test(
      actions.slice(actions.indexOf("draftPosterContentAction"), actions.indexOf("sharePosterWithDesigner"))
    ),
    "drafting moves nothing on its own"
  );

  // And a brief too short to design from is refused rather than sent.
  assert.match(actions, /brief\.length < 10/);
  assert.match(actions, /a designer cannot design a title/i);

  const panel = read("app/(app)/poster/poster-content.tsx");
  assert.match(panel, /Read it before you send/i, "the page says the same thing to the person sending");
  ok("AI drafts the poster copy, a person reads it, and only then does it move");
}

/* ---------------- it really moves, against the database ---------------- */
{
  const clean = async () => {
    await db.execute("DELETE FROM deliverables WHERE title = 'ZZ poster flow'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ poster client'");
  };
  await clean();

  const clientId = Number(
    (await db.execute("INSERT INTO clients (company_name,status) VALUES ('ZZ poster client','active')"))
      .insertId
  );
  const id = Number(
    (await db.execute(
      `INSERT INTO deliverables (client_id, title, service, video_type, content_category, status, month_key)
       VALUES (?,'ZZ poster flow','poster_designing','Poster','Instagram Post','pending','2026-08')`,
      [clientId]
    )).insertId
  );

  // As created: awaiting content, invisible to the designer's to-do.
  let row = await db.queryOne("SELECT status, description FROM deliverables WHERE id = ?", [id]);
  assert.equal(posters.posterWithDesigner(row.status), false, "starts off the designer's list");

  // What the share action does, exactly as it writes it.
  await db.execute(
    "UPDATE deliverables SET description = ?, status = 'waiting_for_raw', reject_reason = NULL WHERE id = ?",
    ["HEADLINE: ZZ test\nCALL TO ACTION: WhatsApp us", id]
  );
  row = await db.queryOne("SELECT status, description FROM deliverables WHERE id = ?", [id]);
  assert.equal(posters.posterWithDesigner(row.status), true, "and lands on it once the content is sent");
  assert.match(row.description, /HEADLINE/, "carrying the brief with it");

  await db.execute("DELETE FROM deliverables WHERE id = ?", [id]);
  await clean();
  ok("a poster created today reaches the designer's queue, brief and all");
}

await finish(pass);
