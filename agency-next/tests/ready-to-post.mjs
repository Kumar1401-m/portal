/**
 * "Ready to post", for a reel that went out weeks ago.
 *
 * Publishing sets `status` to 'posted' — unless the task is already
 * 'completed', which it deliberately leaves alone, because the work being
 * finished is the truer word for it once a client has signed it off.
 *
 * The approvals board did not know that. It counted anything approved whose
 * `status` was not the literal string 'posted' as still waiting to go out, so
 * every completed-and-published reel sat in "Ready to post" for ever and
 * nothing anybody did could clear it.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;
let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- Posted means it is on Instagram ---------------- */
{
  const board = readFileSync(`${SRC}/app/(app)/approvals/approval-board.tsx`, "utf8");
  assert.ok(
    board.includes('if (r.instagram_status === "posted") c.posted++;'),
    "the Posted card counts what the publisher actually sent"
  );
  assert.ok(
    !board.includes("readyToPost"),
    "and the card it replaces is gone — approved-and-waiting is already `approved`"
  );
  ok("Posted is a fact about Instagram, not about what a task is called");
}

/* ---------------- and the row carries it ---------------- */
{
  const lib = readFileSync(`${SRC}/lib/whatsapp-approvals.ts`, "utf8");
  assert.ok(lib.includes("instagram_status: string | null;"), "the row type has the field");
  assert.ok(lib.includes("d.instagram_status"), "and the query selects it");
  ok("the board is given what it needs to decide");
}

/* ---------------- the two words really do differ ---------------- */
{
  /*
   * The guard that makes this necessary. If publishing ever started
   * overwriting 'completed', the board could go back to reading `status` —
   * and if this line changes, the reason for the fix above is gone with it.
   */
  const ig = readFileSync(`${SRC}/lib/instagram.ts`, "utf8");
  assert.ok(
    ig.includes("status              = IF(status NOT IN ('completed'), 'posted', status)"),
    "publishing still leaves a completed task named completed"
  );
  ok("which is why the two fields cannot be read as the same thing");
}

/* ---------------- an answer is an answer, wherever it was given ---------------- */
{
  /*
   * `wa_status` knows only what happened on WhatsApp. A super admin approving
   * inside the portal writes `approval_status` and never touches it — so a
   * video answered at a desk stayed under "Awaiting client" for ever, and one
   * sent back for changes from the portal appeared under changes nowhere.
   */
  const board = readFileSync(`${SRC}/app/(app)/approvals/approval-board.tsx`, "utf8");
  assert.ok(board.includes("const SETTLED = ["), "the board knows what a settled answer looks like");
  assert.ok(
    board.includes("SETTLED.includes(r.approval_status"),
    "and prefers it over what WhatsApp last reported"
  );

  const lib = readFileSync(`${SRC}/lib/whatsapp-approvals.ts`, "utf8");
  assert.ok(
    lib.includes("d.approval_status = 'approved' OR d.wa_status = 'approved'"),
    "the server counts agree with the board"
  );
  assert.ok(
    lib.includes("COALESCE(SUM(d.instagram_status = 'posted'),0) AS posted"),
    "and Posted counts what is on Instagram"
  );
  assert.ok(!lib.includes("ready_to_post"), "Ready to post is gone, not merely hidden");
  ok("approving at a desk clears Awaiting client, and Posted is what went out");
}

await finish(pass);
