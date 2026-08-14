/**
 * A poster, from written brief to the client's screen.
 *
 *   super admin writes the content  →  client approves it
 *     →  designer designs it        →  super admin approves it
 *       →  client sees the poster
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
    /const SEND_TO_CLIENT_STATUSES = \["content_review", "review"\]/,
    "both client-facing gates are named"
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

/* ---------------- unless the client doesn't do content approval ---------------- */
{
  const actions = readFileSync(`${SRC}/app/(app)/deliverables/actions.ts`, "utf8");

  // Some clients hand over the month and want it made. Sending those a content
  // approval gets no reply, and the task sits in `content_review` until
  // somebody notices — so the middle step is skipped and the brief goes
  // straight to the maker.
  assert.match(
    actions,
    /const skipsClientContent = status === "content_review" && !clientSignsOffContent/,
    "a client with sign-off off never gets sent a brief"
  );
  assert.match(
    actions,
    /const effective = contentGate \|\| skipsClientContent \? "waiting_for_raw" : status/,
    "and the task lands where the client's approval would have left it"
  );

  // Null is what a database without the column returns, and what a client
  // added before it existed holds. Both have to mean the old behaviour.
  assert.match(
    actions,
    /d\.content_approval === null \|\| Number\(d\.content_approval\) === 1/,
    "unknown means the client does approve — the step the portal has always had"
  );

  // The client is told nothing, because there is nothing for them to do. That
  // falls out of `effective` rather than a second rule: the notification block
  // keys off it, so there is no way for the two to disagree.
  assert.match(
    actions,
    /if \(effective === "content_review" \|\| effective === "review"\)[\s\S]{0,400}notifyClientById/,
    "the client mail keys off the status actually reached, not the button pressed"
  );

  // And the maker is not told the client approved something the client never
  // saw — they might repeat it back to that client.
  assert.match(actions, /skipsClientContent\s*\n?\s*\?\s*`The content for/, "the wording differs");

  const controls = readFileSync(
    `${SRC}/app/(app)/deliverables/[id]/workflow-controls.tsx`,
    "utf8"
  );
  assert.match(controls, /Hand the content to the team/, "and so does the button");
  // NEXT is a module constant shared by every render on the server; relabelling
  // it in place would rename the button for every other client too.
  assert.ok(
    !/for \(const a of out\)/.test(controls),
    "the per-client label is a copy, not a mutation of the shared table"
  );
  ok("a client who does not sign content off is never waited on");
}

/* ---------------- and the setting is per client, defaulting to on ---------------- */
{
  const form = readFileSync(`${SRC}/app/(app)/clients/client-form.tsx`, "utf8");
  assert.match(form, /name="content_approval"/, "it is on the client's own record");
  assert.match(
    form,
    /defaultChecked=\{d\.content_approval !== false\}/,
    "ticked for a new client, so nobody switches the gate off by not noticing it"
  );

  const save = readFileSync(`${SRC}/app/(app)/clients/actions.ts`, "utf8");
  assert.match(
    save,
    /hasColumn\("clients", "content_approval"\)[\s\S]{0,200}content_approval = fd\.get\("content_approval"\) \? 1 : 0/,
    "saved only where the column exists — the same gate every other new column uses"
  );

  const clients = readFileSync(`${SRC}/lib/clients.ts`, "utf8");
  assert.match(clients, /export async function clientApprovesContent/, "and readable on its own");
  assert.match(
    clients,
    /if \(!\(await hasColumn\("clients", "content_approval"\)\)\) return true/,
    "which also answers true on a database the migration has not reached"
  );
  ok("the switch lives on the client, and its default is the old behaviour");
}

await finish(pass);
