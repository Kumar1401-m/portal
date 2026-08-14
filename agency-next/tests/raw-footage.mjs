/**
 * Footage that arrives before anybody has written the brief.
 *
 * A client who already has the video should not have to wait to be asked for
 * it. The client portal and the WhatsApp handler have always accepted that;
 * the agency's own form was the one place that refused, so a link a client had
 * sent could not be pasted in by the person it was sent to.
 *
 * The harder half is what it must NOT do: taking the footage cannot also skip
 * the content gate.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const raw = await import(pathToFileURL(`${SRC}/lib/raw-footage.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

/* ---------------- an unwritten slot takes footage too ---------------- */
{
  assert.ok(raw.acceptsRaw("waiting_for_raw"), "the case where we asked");
  assert.ok(raw.acceptsRaw("pending"), "and the slot nobody has asked about");
  // Once it is being cut, a link is a change request, not footage.
  for (const s of ["raw_uploaded", "editing", "caption_ready", "review", "posted", "completed"]) {
    assert.ok(!raw.acceptsRaw(s), `${s} is past taking footage`);
  }
  ok("footage is accepted before the brief is written, not after the cut starts");
}

/* ---------------- but taking it does not skip the content gate ---------------- */
{
  // The bug this closes. Every path set `raw_uploaded` unconditionally, so a
  // pending task jumped straight to "ready to edit": the brief was never
  // written, never approved, the piece vanished from the content desk, and an
  // editor opened it to find footage and no copy.
  assert.equal(raw.rawUploadStatus("waiting_for_raw"), "raw_uploaded", "asked for, and it came");
  assert.equal(raw.rawUploadStatus("pending"), null, "sent early — the status does not move");
  assert.equal(raw.rawUploadStatus("editing"), null);
  ok("footage arriving early is recorded without advancing the task");
}

/* ---------------- and all four callers read the one rule ---------------- */
{
  // They were three copies of a list and three copies of an UPDATE. Two of the
  // copies already disagreed with the third, which is how this started.
  for (const [file, why] of [
    ["app/portal/actions.ts", "the client's own upload"],
    ["app/api/whatsapp/footage/route.ts", "a link shared in the group"],
    ["app/(app)/deliverables/actions.ts", "the agency's form"],
  ]) {
    const src = readFileSync(`${SRC}/${file}`, "utf8");
    has(src, "rawUploadStatus(", `${why} asks before advancing`);
    assert.ok(
      !/status = 'raw_uploaded'/.test(src),
      `${why} no longer hard-codes the advance`
    );
  }

  // The dialog is a client component and `lib/portal.ts` is server-only, which
  // is why the rules moved to a module of their own.
  const modal = readFileSync(`${SRC}/app/(app)/deliverables/edit-video-modal.tsx`, "utf8");
  has(modal, 'from "@/lib/raw-footage"', "the dialog reads the pure module");
  assert.ok(!/from "@\/lib\/portal"/.test(modal), "and not the server-only one");
  has(modal, "acceptsRaw(d.status)", "so the form shows on both statuses");

  const pure = readFileSync(`${SRC}/lib/raw-footage.ts`, "utf8");
  assert.ok(
    !/^import "server-only";/m.test(pure),
    "which stays importable from a client component"
  );

  // Still one definition: portal.ts re-exports rather than keeping a copy.
  const portal = readFileSync(`${SRC}/lib/portal.ts`, "utf8");
  has(portal, 'export { ACCEPTS_RAW, rawUploadStatus } from "./raw-footage";', "one definition");
  ok("four callers, one rule, and none of them a copy of it");
}

/* ---------------- empty service tabs are not offered ---------------- */
{
  // "Meta Ads 0 · Content 0" on every board for ever is a permanent offer of
  // an empty list, taking the width the tabs that do something need.
  const tabs = readFileSync(`${SRC}/components/admin/service-tabs.tsx`, "utf8");
  has(
    tabs,
    "SERVICE_LIST.filter((s) => counts[s.key] > 0 || active === s.key)",
    "a service with nothing in it gets no tab"
  );
  // Filtering to a service and having its tab vanish underneath you leaves no
  // way back to it.
  has(tabs, "active === s.key", "except the one you are on");
  ok("only the services actually in use get a tab");
}

/* ---------------- and the day board sees it arrive ---------------- */
{
  const today = readFileSync(`${SRC}/app/(app)/today/page.tsx`, "utf8");

  // Footage no longer advances a pending task — it cannot, or it would skip
  // the content gate — so without this the client's video sits on the content
  // desk alone and nobody on the day board knows it came.
  has(today, "const arrived = (d: (typeof board)[number]) =>", "a slot with footage is recognised");
  has(
    today,
    '(d.status !== "pending" || arrived(d)) && !isFinished(d.status, d.posting_status)',
    "and shown on Today's Tasks, unwritten or not"
  );
  // It is still unwritten, so it is still on the desk as well.
  has(today, 'board.filter((d) => d.status === "pending").length', "and still counted there");

  // Content approval was never the missing half — waiting_for_raw is neither
  // pending nor finished, so it has always been on the board. Named here so a
  // future filter cannot quietly drop it.
  assert.ok(
    !/waiting_for_raw/.test(today.split("const all = board.filter")[1].slice(0, 400)),
    "nothing excludes a task whose content was just approved"
  );

  const route = readFileSync(`${SRC}/app/api/whatsapp/footage/route.ts`, "utf8");
  has(route, "The content still needs writing.", "and the alert says which case it is");
  ok("footage the client sends shows up on the day board either way");
}

await finish(pass);
