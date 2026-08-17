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

  /*
   * Footage does not advance a pending task, so a slot the client has sent
   * their video for stays `pending` — and this board used to hide `pending`,
   * carving out that one case so the arrival was still visible.
   *
   * The carve-out is gone because the rule it excepted is gone: `pending` is
   * on the board now, footage or not. There is no content desk left for it to
   * be hidden in favour of, so hiding it meant hiding it everywhere.
   */
  has(
    today,
    "const all = board.filter((d) => !isFinished(d.status, d.posting_status))",
    "an unwritten slot with the client's footage on it is on the day board"
  );
  assert.ok(
    !/const arrived = /.test(today),
    "without needing a special case for it any more"
  );

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
