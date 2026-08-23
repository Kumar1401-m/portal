/**
 * Asking a client to approve what has already been approved.
 *
 * A super admin can approve inside the portal — on the client's behalf, when
 * the client has answered some other way or the agency has decided. That
 * writes `status` and `approval_status`, and never `wa_status`, because
 * nothing happened on WhatsApp.
 *
 * The guard that stops an approval request going out asked `wa_status` alone.
 * So it did not fire, and the video went to the client's group asking them to
 * approve something already approved — which reads, to the client, as the
 * agency having lost track of its own work.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const wa = await import(pathToFileURL(`${SRC}/lib/whatsapp-approvals.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

{
  const clean = async () => {
    await db.execute("DELETE FROM deliverables WHERE title = 'ZZ approved already'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ approved already'");
  };
  await clean();
  const cid = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ approved already','active')")).insertId
  );
  const mk = async (status, approval, waStatus) =>
    Number((await db.execute(
      `INSERT INTO deliverables (client_id, title, status, approval_status, wa_status)
       VALUES (?, 'ZZ approved already', ?, ?, ?)`,
      [cid, status, approval, waStatus]
    )).insertId);

  try {
    // Approved at a desk: nothing happened on WhatsApp, so wa_status is stale.
    const desk = await mk("approved", "approved", "sent");
    const r1 = await wa.prepareSend(desk);
    assert.equal(r1.ok, false, "an approval given in the portal stops the ask");
    assert.match(r1.error, /already been approved/, "and says so plainly");

    // Already out. Asking permission for a published reel is worse still.
    const posted = await mk("posted", "pending", "viewed");
    assert.equal((await wa.prepareSend(posted)).ok, false, "a published reel is never asked about");

    const scheduled = await mk("scheduled", "pending", "delivered");
    assert.equal((await wa.prepareSend(scheduled)).ok, false, "nor one already scheduled");

    /*
     * And the case the guard exists for stays untouched: a video genuinely
     * waiting on the client is still sendable. This fails on "no WhatsApp
     * group linked" rather than on approval, which is the next check along —
     * what matters is that it got past this one.
     */
    const waiting = await mk("review", "pending", "not_sent");
    const r4 = await wa.prepareSend(waiting);
    assert.equal(r4.ok, false, "this fixture has no group, so it stops later");
    assert.ok(
      !/already been approved/.test(r4.error),
      "but not on approval — a video still waiting is still askable"
    );
  } finally {
    await clean();
  }
  ok("a video approved anywhere is never sent to the group to be approved again");
}

await finish(pass);
