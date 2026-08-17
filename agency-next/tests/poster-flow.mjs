/**
 * A poster, from written brief to the client's screen.
 *
 *   super admin writes the content  →  super admin releases it
 *     →  designer designs it        →  super admin approves it
 *       →  client sees the poster
 *
 * The client used to sit at that first arrow, signing the copy off before
 * anything was made. They no longer do — content is settled inside the agency
 * and the only thing put in front of a client is the finished poster.
 *
 * Two hand-offs matter more than the rest, because in both the work changes
 * hands and the person receiving it has no reason to be looking.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const posters = await load("lib/posters.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- a poster is not the designer's until it is ---------------- */
{
  // Being written, or with the client. There is no poster to make yet.
  for (const s of ["pending", "content_review"]) {
    assert.ok(posters.posterAwaitingContent(s), `${s} is still content`);
    assert.ok(!posters.posterWithDesigner(s), `${s} is not the designer's`);
  }

  // Content signed off. `waiting_for_raw` is where the content gate leaves a
  // task; on a poster there is no footage to wait for, so it means "design it".
  for (const s of ["waiting_for_raw", "raw_uploaded", "editing", "resolved"]) {
    assert.ok(posters.posterWithDesigner(s), `${s} is the designer's turn`);
    assert.ok(!posters.posterAwaitingContent(s));
  }

  // Sent back is theirs again — that is the whole point of sending it back.
  assert.ok(posters.posterWithDesigner("changes_requested"));

  // Submitted, and out of their hands.
  for (const s of ["caption_ready", "review"]) {
    assert.ok(posters.posterInReview(s), `${s} is with somebody else`);
    assert.ok(!posters.posterWithDesigner(s), `${s} is not still to do`);
  }
  assert.ok(posters.posterDone("posted") && posters.posterDone("completed"));
  ok("each stage belongs to exactly one person, and the designer's starts after content");
}

/* ---------------- so the queue cannot show work that has no brief ---------------- */
{
  const q = readFileSync(`${SRC}/app/(app)/my-work/poster-queue.tsx`, "utf8");
  assert.match(
    q,
    /const todo = posters\.filter\(\(p\) => posterWithDesigner\(p\.status\)\)/,
    "the to-do list is only what the content gate has released"
  );
  assert.match(q, /posterAwaitingContent\(p\.status\)/, "the rest is counted separately");
  assert.match(
    q,
    /waiting on\s*\n?\s*content approval/,
    "and named, so the month ahead is visible without looking startable"
  );
  // Designing from a blank brief means designing twice.
  assert.ok(
    !/!posterDone\(p\.status\) && !posterInReview\(p\.status\)/.test(q),
    "the old catch-all, which swept in briefs nobody had written, is gone"
  );
  ok("a designer's list holds only posters whose content is approved");
}

/* ---------------- both hand-offs are announced ---------------- */
{
  const actions = readFileSync(`${SRC}/app/(app)/deliverables/actions.ts`, "utf8");

  // Client approves the content → the designer is told it is theirs. Without
  // this the poster simply appears in a list they had no reason to open.
  assert.match(
    actions,
    /if \(handedToMaker && d\.assigned_to && !quiet\)[\s\S]{0,900}notifyUser\(/,
    "content approval notifies whoever the work is assigned to"
  );
  assert.match(actions, /A poster is ready to design/, "and says so in poster words");
  assert.match(
    actions,
    /service === "poster_designing"[\s\S]{0,160}video_type[\s\S]{0,40}poster/,
    "recognising a poster by service, and by the legacy column for older rows"
  );

  // Designer submits → the super admin is told. The other direction.
  assert.match(
    actions,
    /effective === "caption_ready" && !ADMIN_ROLES\.includes\(user\.role\)[\s\S]{0,200}notifyAdmins/,
    "submitting notifies the super admin"
  );

  const submit = readFileSync(`${SRC}/app/(app)/poster/actions.ts`, "utf8");
  assert.match(submit, /status = 'caption_ready'/, "a submitted design lands with the super admin");
  assert.match(submit, /notifyAdmins/, "who is told about it");
  ok("both hand-offs tell the person receiving the work, in each direction");
}

/* ---------------- and the client gate stays the super admin's ---------------- */
{
  const controls = readFileSync(
    `${SRC}/app/(app)/deliverables/[id]/workflow-controls.tsx`,
    "utf8"
  );
  // A designer must not be able to send their own poster to the client. The
  // super admin looks at it first — that is the whole reason for the middle
  // step.
  assert.match(
    controls,
    /const SEND_TO_CLIENT_STATUSES = \["review"\]/,
    "the client-facing gate is named — one now, since content stays in-house"
  );
  assert.match(
    controls,
    /canSendToClient \|\| !SEND_TO_CLIENT_STATUSES\.includes\(a\.status\)/,
    "and filtered out for anyone who may not send to a client"
  );

  const poster = readFileSync(`${SRC}/app/(app)/poster/page.tsx`, "utf8");
  assert.match(
    poster,
    /!isDesigner && p\.status === "caption_ready" && user\.role === "super_admin"/,
    "approve-and-send is the super admin's button alone"
  );
  ok("only the super admin sends a poster on to the client");
}

/* ---------------- and content never reaches a client at all ---------------- */
{
  const actions = readFileSync(`${SRC}/app/(app)/deliverables/actions.ts`, "utf8");

  /*
   * There used to be a per-client switch here — some clients read the month's
   * copy before anything was made, some handed us the month and wanted it made
   * — and "send for content review" either went to the client or skipped them.
   * Content is settled inside the agency now, so there is nothing to skip and
   * nothing to switch.
   */
  assert.ok(!/skipsClientContent/.test(actions), "the per-client skip is gone");
  assert.ok(!/clientSignsOffContent/.test(actions), "and so is the flag behind it");
  assert.match(
    actions,
    /const effective = contentGate \? "waiting_for_raw" : status/,
    "approving the copy is the only thing that hands it to the maker"
  );

  // The maker must never be told the client approved something no client saw.
  assert.ok(
    !/approved the content for/.test(actions),
    "the handover never claims a client approved it"
  );
  assert.match(actions, /is written and it's yours/, "it says what actually happened");

  const controls = readFileSync(`${SRC}/app/(app)/deliverables/[id]/workflow-controls.tsx`, "utf8");
  assert.ok(!/clientApprovesContent/.test(controls), "the buttons no longer vary by client");
  assert.match(controls, /label: "Move to content review"/, "and the label says an internal move");

  const form = readFileSync(`${SRC}/app/(app)/clients/client-form.tsx`, "utf8");
  assert.ok(!/content_approval/.test(form), "the client record has no such setting any more");
  ok("content is an internal step, with no client and no switch");
}

await finish(pass);
