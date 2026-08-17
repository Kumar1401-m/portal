/**
 * A client you removed stops being work.
 *
 * The portal had one question about a client's status — `<> 'churned'` — and
 * asked it everywhere, so Inactive and Paused meant nothing to any number on
 * any board. A client switched to Inactive kept their unfinished videos in
 * Due today, in Upcoming and in Overdue, and the month generator went on
 * manufacturing fresh ones for them every month.
 *
 * The distinction this file exists to hold: "still a client" and "still being
 * worked on" are different questions. Reports, invoices, the clients list and
 * the assignee dropdown all still see a paused client. Anything that counts,
 * schedules or chases work does not.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const db = await load("lib/db.ts");
const cs = await load("lib/client-status.ts");
const q = await load("lib/queries.ts");
const d = await load("lib/deliverables.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- the predicate itself ---------------- */
{
  for (const s of ["churned", "inactive", "paused"]) {
    assert.equal(cs.isOnTheFloor(s), false, `${s} is not work on the floor`);
  }
  assert.equal(cs.isOnTheFloor("active"), true, "active is");

  /*
   * The NULL trap, which is the one that would have hurt. `NOT IN` returns
   * NULL — not true — for a row whose status was never set, so without the
   * COALESCE a filter meant to hide three clients silently hides every legacy
   * row in the table.
   */
  assert.equal(cs.isOnTheFloor(null), true, "a status nobody ever set is live work");
  assert.equal(cs.isOnTheFloor(undefined), true, "and so is a missing one");
  assert.match(cs.onTheFloor(), /COALESCE\(c\.status,'active'\)/, "the SQL says so too");
  assert.match(cs.onTheFloor("x"), /COALESCE\(x\.status,'active'\)/, "under any alias");
  assert.match(cs.onTheFloor(""), /COALESCE\(status,'active'\)/, "and with no alias at all");
  ok("removed means churned, inactive or paused — and never means 'unset'");
}

/* ---------------- and the boards actually obey it ---------------- */
const TAG = "ZZ status client";
const MONTH = new Date().toISOString().slice(0, 7);
const clean = async () => {
  await db.execute(
    "DELETE FROM deliverables WHERE client_id IN (SELECT id FROM clients WHERE company_name LIKE ?)",
    [`${TAG}%`]
  );
  await db.execute("DELETE FROM clients WHERE company_name LIKE ?", [`${TAG}%`]);
};
await clean();

const mk = async (status) => {
  const id = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES (?, ?)", [
      `${TAG} ${status}`,
      status,
    ])).insertId
  );
  // One overdue task each — the number the dashboard shouts loudest about.
  await db.execute(
    `INSERT INTO deliverables (client_id, title, status, due_date, month_key, service, instagram_status)
     VALUES (?, 'ZZ overdue piece', 'editing', '2020-01-01', ?, 'video_editing', 'none')`,
    [id, MONTH]
  );
  return id;
};

const ids = {};
for (const s of ["active", "paused", "inactive", "churned"]) ids[s] = await mk(s);

{
  const before = await q.getServiceMix();
  const mine = (rows) =>
    rows.find((r) => r.service === "video_editing")?.overdue ?? 0;

  // Four clients, one overdue task each, and exactly one of them is on the
  // floor. This is the bug as the screenshot showed it: an overdue count that
  // includes clients nobody is working with.
  const rows = await d.getDeliverables({});
  const shown = rows.filter((r) => String(r.company_name).startsWith(TAG));
  assert.deepEqual(
    shown.map((r) => r.company_name),
    [`${TAG} active`],
    `only the active client's work is on the board, got: ${shown.map((r) => r.company_name).join(", ") || "none"}`
  );
  assert.ok(mine(before) >= 1, "and the service mix counts at least that one");
  ok("paused, inactive and churned work is off the boards and out of the counts");
}

/* ---------------- but they are still clients ---------------- */
{
  const listed = (await q.getClients()).filter((c) => c.company_name.startsWith(TAG));
  assert.deepEqual(
    listed.map((c) => c.status).sort(),
    ["active", "inactive", "paused"],
    "the clients list still shows paused and inactive — you have to find them to switch them back"
  );

  const options = (await d.getClientsMini()).filter((c) => c.company_name.startsWith(TAG));
  assert.equal(options.length, 3, "and they can still be picked in a dropdown");
  ok("removed from the floor is not removed from the portal");
}

/* ---------------- and nothing new is made for them ---------------- */
{
  const plan = read("lib/task-plan.ts");
  // The quiet one. Every month the generator created a fresh set of videos
  // for anyone with a monthly target and no 'churned' on them, so a client
  // switched to Inactive grew a new backlog for as long as nobody noticed.
  assert.ok(
    !/WHERE status <> 'churned'/.test(plan),
    "the month generator no longer builds a month for a client who is off the floor"
  );
  assert.match(plan, /WHERE \$\{onTheFloor\(""\)\}/, "it asks the shared question");

  // The sharpest case of all: unattended WhatsApp messages.
  const rem = read("lib/whatsapp-reminders.ts");
  assert.ok(
    !/c\.status <> 'churned'/.test(rem),
    "and an inactive client is not chased on WhatsApp for footage"
  );
  ok("no new work, and no automated messages, for a client who is off the floor");
}

await clean();
await finish(pass);
