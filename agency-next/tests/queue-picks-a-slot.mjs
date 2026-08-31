/**
 * A button that queues something the publisher will skip.
 *
 * The task screen showed this, all at once: "Waiting for its slot", a warning
 * reading *"No posting time is set, so it is never due"*, a button saying
 * **Put it in the queue** — and, after pressing it, a green line saying
 * *"Queued — but fix the points above or the publisher will still skip it."*
 *
 * Every part of that was true. `retryPublish` cleared the attempts and set the
 * status back to scheduled, and a row with no `scheduled_at` is never due, so
 * the queue was a place the task sat for ever. A button that knowingly
 * performs a no-op and then explains the no-op is worse than no button: the
 * person pressing it has already told us exactly what they want.
 *
 * So it picks the slot — by the same rule approval uses, not by a guess.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);
const ig = await import(pathToFileURL(`${SRC}/lib/instagram.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZslot%'");
  await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ slot%'");
};
await clean();

const clientId = (
  await db.execute(
    `INSERT INTO clients (company_name, status, placeholder_values)
     VALUES ('ZZ slot co', 'active', '{"country":"India"}')`
  )
).insertId;

const task = async (over = {}) => {
  const due = over.due_date ?? "2026-09-15";
  const scheduled = over.scheduled_at ?? null;
  return (
    await db.execute(
      `INSERT INTO deliverables
         (client_id, title, status, instagram_status, due_date, scheduled_at, month_key, post_attempts)
       VALUES (?, ?, 'approved', 'failed', ?, ?, '2026-09', 3)`,
      [clientId, over.title ?? "ZZslot one", due, scheduled]
    )
  ).insertId;
};

/* ------------------------------------------------------------------ *
 * No time set: one is chosen
 * ------------------------------------------------------------------ */
{
  const id = await task({ title: "ZZslot no time" });

  assert.equal(await ig.retryPublish(id), true, "it queues");

  const row = await db.queryOne(
    "SELECT scheduled_at, instagram_status, post_attempts FROM deliverables WHERE id = ?",
    [id]
  );

  assert.ok(row.scheduled_at, "and it now has a time, so the publisher can find it");
  assert.equal(String(row.instagram_status), "scheduled", "back in the queue");
  assert.equal(Number(row.post_attempts), 0, "with its attempts cleared");

  /*
   * On the day the task is down for — not "now plus a bit". A reel due on the
   * 15th that queues itself for the 12th is a different kind of wrong from not
   * posting at all, and harder to notice.
   */
  const day = String(row.scheduled_at).slice(0, 10);
  assert.ok(day >= "2026-09-15", `on or after its due date, not before (got ${day})`);
  ok("queueing something with no time gives it one, on the day it belongs to");
}

/* ------------------------------------------------------------------ *
 * A time somebody chose is left alone
 * ------------------------------------------------------------------ */
{
  const chosen = "2026-09-20 13:30:00";
  const id = await task({ title: "ZZslot has time", scheduled_at: chosen });

  await ig.retryPublish(id);

  const row = await db.queryOne("SELECT scheduled_at FROM deliverables WHERE id = ?", [id]);
  assert.equal(
    String(row.scheduled_at).slice(0, 16),
    chosen.slice(0, 16),
    "the time is untouched"
  );
  /*
   * Somebody chose it. Quietly moving a client's post because a button was
   * pressed twice would be worse than anything this fixes — and it would be
   * invisible, because the button's whole job is to look like it did nothing
   * much.
   */
  ok("a time that was already set is never moved");
}

/* ------------------------------------------------------------------ *
 * And a posted reel is still refused
 * ------------------------------------------------------------------ */
{
  const id = await task({ title: "ZZslot posted" });
  await db.execute("UPDATE deliverables SET instagram_status = 'posted' WHERE id = ?", [id]);
  assert.equal(await ig.retryPublish(id), false, "there is nothing to re-queue");
  ok("something already live is not put back in the queue");
}

/* ------------------------------------------------------------------ *
 * The same rule the rest of the pipeline uses
 * ------------------------------------------------------------------ */
{
  const src = read("lib/instagram.ts");
  const fn = src.slice(src.indexOf("export async function retryPublish"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  assert.ok(body.includes("postingSlotFor("), "the slot comes from the shared rule");
  assert.ok(
    src.includes("postingSlotFor(") && src.indexOf("approvalHandoff") > 0,
    "which is the one approval schedules by — not a second definition of when to post"
  );

  /*
   * Best-effort, and it has to stay that way. If the slot cannot be worked
   * out, the row still goes back in the queue with its attempts cleared —
   * which is what this button did before, and is never worse than refusing.
   */
  assert.ok(/postingSlotFor\([\s\S]{0,160}catch\(/.test(body.replace(/\s+/g, " ").replace(/\. catch/g, ".catch")) ||
    body.includes(".catch("), "a failure to pick one does not fail the queueing");
  ok("the queue schedules by the same rule as approval, and never fails on it");
}

await clean();
await finish(pass);
