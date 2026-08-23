/**
 * A published reel is a record, not a draft.
 *
 * The task page kept its upload box and its caption editor open after the work
 * was on the client's account. A new cut or a rewritten caption could be saved
 * over what actually went out — changing nothing on Instagram and losing the
 * record of what was posted. Reject and Cancel were offered too, on something
 * the portal cannot un-publish.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const c = await import(pathToFileURL(`${SRC}/lib/constants.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- the rule ---------------- */
{
  for (const s of ["posted", "completed", "cancelled", "rejected"]) {
    assert.ok(c.isFinished(s), `${s} is finished`);
  }
  for (const s of ["review", "editing", "approved", "scheduled"]) {
    assert.ok(!c.isFinished(s), `${s} is still work in progress`);
  }
  // Published by the runner without the workflow status catching up.
  assert.ok(c.isFinished("approved", "posted"), "posting_status alone is enough");
  ok("finished means finished, by either column");
}

/* ---------------- and the page obeys it ---------------- */
{
  const page = readFileSync(`${SRC}/app/(app)/deliverables/[id]/task-detail.tsx`, "utf8");
  assert.ok(page.includes("const locked = isFinished(d.status)"), "the page knows when it is done");
  assert.ok(
    page.includes("canUploadVideo && !isPoster && !locked"),
    "and no new cut can be uploaded over a published one"
  );
  assert.ok(page.includes("locked={locked}"), "and the caption editor is told");

  const studio = readFileSync(`${SRC}/app/(app)/deliverables/[id]/caption-studio.tsx`, "utf8");
  assert.ok(studio.includes("if (locked) {"), "which shows the caption instead of editing it");
  assert.ok(
    studio.includes("the record of what was published"),
    "and says why it cannot be changed"
  );
  ok("upload and caption editing close when the work is out");
}

/* ---------------- nothing left to reject ---------------- */
{
  const wf = readFileSync(`${SRC}/app/(app)/deliverables/[id]/workflow-controls.tsx`, "utf8");
  assert.ok(
    wf.includes('if (!["posted", "completed", "cancelled", "rejected"].includes(status))'),
    "Reject and Cancel are not offered on something already on Instagram"
  );
  // Mark completed is the one move that is still honest, and stays.
  assert.ok(
    wf.includes('posted: [{ label: "Mark completed", status: "completed" }]'),
    "but marking it completed still is"
  );
  ok("the only button left on a posted task is the one that means something");
}

await finish(pass);
