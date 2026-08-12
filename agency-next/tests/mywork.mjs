/**
 * The editor / designer dashboard.
 *
 * Two things have to hold. It shows one person their own work and nobody
 * else's — the numbers are the point of the page, and a leak here would show a
 * designer the whole agency's book. And "send for approval" must be understood
 * as a hand-off to the super admin, not to the client: the status the editor
 * can reach has to be counted as "with the super admin", and the statuses that
 * mean the client already has it must be unreachable from an editor's buttons.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const db = await load("lib/db.ts");
const mw = await load("lib/my-work.ts");
const constants = await load("lib/constants.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const TAG = "ZZ mywork";
const MONTH = new Date().toISOString().slice(0, 7);
const today = new Date().toISOString().slice(0, 10);
const day = (n) => `${MONTH}-${String(n).padStart(2, "0")}`;

const clean = async () => {
  await db.execute(
    "DELETE FROM deliverables WHERE client_id IN (SELECT id FROM clients WHERE company_name LIKE ?)",
    [`${TAG}%`]
  );
  await db.execute("DELETE FROM clients WHERE company_name LIKE ?", [`${TAG}%`]);
  await db.execute("DELETE FROM users WHERE email LIKE 'zz-mywork-%'");
};
await clean();

/* Two editors, so "mine" has something to be wrong about. */
const mkUser = async (email, name, role) =>
  Number(
    (await db.execute(
      "INSERT INTO users (name, email, password_hash, role, is_active) VALUES (?, ?, 'x', ?, 1)",
      [name, email, role]
    )).insertId
  );
const meId = await mkUser("zz-mywork-a@example.com", "Editor A", "video_editor");
const otherId = await mkUser("zz-mywork-b@example.com", "Editor B", "video_editor");
const me = { id: meId, name: "Editor A", role: "video_editor" };

const mkClient = async (suffix) =>
  Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES (?, 'active')", [
      `${TAG} ${suffix}`,
    ])).insertId
  );
const c1 = await mkClient("one");
const c2 = await mkClient("two");
const c3 = await mkClient("three"); // only the other editor works here

const mk = async (clientId, title, status, assignedTo, dueDate, monthKey = MONTH) =>
  Number(
    (await db.execute(
      `INSERT INTO deliverables
         (client_id, title, status, assigned_to, due_date, month_key, instagram_status)
       VALUES (?, ?, ?, ?, ?, ?, 'none')`,
      [clientId, title, status, assignedTo, dueDate, monthKey]
    )).insertId
  );

// Mine, client one: a finished one, one sitting with the super admin, one
// still to do and overdue.
await mk(c1, "A posted", "posted", meId, day(2));
const handedOn = await mk(c1, "A with admin", "caption_ready", meId, day(3));
await mk(c1, "A editing late", "editing", meId, "2020-01-05");
// Mine, client two: with the client, changes asked for, one due today.
await mk(c2, "A with client", "review", meId, day(4));
// No date on this one: still to do, but nothing about it is late. Whether a
// task without a date counts as overdue is exactly the sort of thing a
// COALESCE in the wrong place gets wrong.
await mk(c2, "A changes", "changes_requested", meId, null);
await mk(c2, "A due today", "raw_uploaded", meId, today);
// Mine, but cancelled — not work, and not a number on anyone's card.
await mk(c2, "A cancelled", "cancelled", meId, day(6));
// Mine, last month — the month cards must not count it, the worklist must.
await mk(c1, "A leftover", "editing", meId, "2020-01-01", "2020-01");
// The other editor's, including a client I am not on at all.
await mk(c3, "B editing", "editing", otherId, day(2));
await mk(c1, "B caption ready", "caption_ready", otherId, day(2));

/* ---------------- the numbers are one person's ---------------- */
{
  const w = await mw.getMyWork(me, MONTH);
  const s = w.stats;
  assert.equal(s.assigned, 6, `six of mine this month, cancelled excluded, got ${s.assigned}`);
  assert.equal(s.clients, 2, "two clients — not the three that exist");
  assert.equal(s.done, 1, "posted counts as done");
  assert.equal(s.withAdmin, 1, "caption_ready is with the super admin");
  assert.equal(s.withClient, 1, "review is with the client");
  assert.equal(s.changes, 1);
  assert.equal(s.toDo, 3, "editing + changes_requested + raw_uploaded");
  assert.equal(s.overdue, 1, "the 2020 one, and only it");
  assert.equal(s.dueToday, 1);
  ok("the month's cards count only this editor's work, cancelled aside");

  const names = w.clients.map((c) => c.company);
  assert.deepEqual(
    [...names].sort(),
    [`${TAG} one`, `${TAG} two`],
    `only clients I am on, got ${names.join(", ")}`
  );
  const one = w.clients.find((c) => c.company === `${TAG} one`);
  assert.equal(one.assigned, 3, "B's task on the same client is not mine");
  assert.equal(one.done, 1);
  assert.equal(one.toDo, 1);
  assert.equal(one.nextDue, "2020-01-05", "next due is the soonest unfinished");
  ok("the per-client rows stay scoped to me even where two editors share a client");
}

/* ---------------- the worklist reaches back ---------------- */
{
  const w = await mw.getMyWork(me, MONTH);
  const titles = w.upNext.map((t) => t.title);
  assert.ok(titles.includes("A leftover"), "last month's leftover is still work");
  assert.equal(titles[0], "A leftover", "and it is the first thing to pick up");
  assert.ok(!titles.includes("A posted"), "finished work is not a to-do");
  assert.ok(!titles.includes("A with admin"), "handed on is not a to-do");
  assert.ok(!titles.some((t) => t.startsWith("B ")), "and none of it is B's");
  assert.equal(w.upNext.find((t) => t.title === "A leftover").overdue, true);
  assert.equal(w.upNext.find((t) => t.title === "A due today").overdue, false, "today is not late");
  ok("Up next crosses months, skips finished work, and flags only what is actually late");
}

/* ---------------- handed on, and visible ---------------- */
{
  const rows = await mw.awaitingAdminReview(me);
  assert.equal(rows.length, 1, `one of mine is with the super admin, got ${rows.length}`);
  assert.equal(Number(rows[0].id), handedOn);
  assert.equal(rows[0].company, `${TAG} one`);
  ok("work waiting on the super admin shows on the editor's own screen");

  const theirs = await mw.awaitingAdminReview({ id: otherId, name: "Editor B", role: "video_editor" });
  assert.deepEqual(theirs.map((r) => r.title), ["B caption ready"], "and B sees only B's");
  ok("two editors never see each other's queue");
}

/* ---------------- the month picker offers only real months ---------------- */
{
  const months = await mw.myMonths(me);
  assert.ok(months.includes("2020-01"), "a month I have work in is offered");
  assert.ok(months.includes(MONTH), "and the current one always is, work or not");
  assert.equal(months[0], MONTH, "newest first");
  const theirs = await mw.myMonths({ id: otherId, name: "Editor B", role: "video_editor" });
  assert.ok(!theirs.includes("2020-01"), "B was not working in January 2020");
  ok("the month list is the person's own, and never offers an empty month");
}

/* ---------------- a churned client drops out ---------------- */
{
  await db.execute("UPDATE clients SET status = 'churned' WHERE id = ?", [c2]);
  const w = await mw.getMyWork(me, MONTH);
  assert.equal(w.stats.clients, 1, "a churned client is not still on my plate");
  assert.equal(w.stats.assigned, 3);
  assert.ok(!w.upNext.some((t) => t.title === "A due today"), "nor is their work");
  await db.execute("UPDATE clients SET status = 'active' WHERE id = ?", [c2]);
  ok("churned clients leave the dashboard with their work");
}

/* ---------------- send for approval means: to the super admin ---------------- */
{
  const controls = readFileSync(
    `${SRC}/app/(app)/deliverables/[id]/workflow-controls.tsx`,
    "utf8"
  );
  assert.match(
    controls,
    /label: "Send to super admin for review", status: "caption_ready"/,
    "the button an editor presses says where the work goes"
  );

  // The client-facing gates are barred to an editor twice over: the button is
  // filtered out of their controls, and the server refuses the status.
  const editable = constants.EDITOR_STATUSES;
  for (const s of ["content_review", "review", "approved", "scheduled", "posted"]) {
    assert.ok(!editable.includes(s), `an editor cannot set ${s} themselves`);
  }
  assert.ok(editable.includes("caption_ready"), "caption_ready is the far end of their reach");
  ok("an editor's furthest step is the super admin — never the client group");

  const actions = readFileSync(`${SRC}/app/(app)/deliverables/actions.ts`, "utf8");
  assert.match(
    actions,
    /effective === "caption_ready" && !ADMIN_ROLES\.includes\(user\.role\)[\s\S]{0,200}notifyAdmins/,
    "and the super admin is told, whichever screen the editor used"
  );
  ok("the hand-off notifies the super admin rather than waiting to be noticed");
}

/* ---------------- the dashboard is reachable ---------------- */
{
  const nav = await load("components/admin/nav-config.ts");
  const hrefs = (role) => nav.navForRole(role).map((n) => n.href);

  for (const role of ["video_editor", "poster_designer", "admin"]) {
    assert.ok(hrefs(role).includes("/my-work"), `${role} has My work in the nav`);
  }
  assert.ok(!hrefs("crm").includes("/my-work"), "a crm makes nothing, so has no My work");
  // My work is one person's own assigned work. A super admin has none, so the
  // entry would open on an empty screen — the nav of the person running the
  // place should not contain a wrong turn.
  assert.ok(!hrefs("super_admin").includes("/my-work"), "and neither does a super admin");

  const auth = readFileSync(`${SRC}/lib/auth.ts`, "utf8");
  assert.match(
    auth,
    /role === "poster_designer" \|\| role === "video_editor"\) return "\/my-work"/,
    "and both making roles land there on login"
  );
  ok("both making roles have the dashboard in the nav and as their landing page");

  /*
   * Today's Tasks is the agency's whole board filtered to one date. Everyone
   * who runs the day keeps it; it goes only for the editor, who was being
   * shown every client's work when their own list is what they opened it for.
   */
  assert.ok(!hrefs("video_editor").includes("/today"), "an editor no longer has Today's Tasks");
  for (const role of ["super_admin", "admin", "poster_designer", "crm"]) {
    assert.ok(hrefs(role).includes("/today"), `${role} keeps Today's Tasks`);
  }
  ok("Today's Tasks is gone from the editor's nav only — every other role keeps it");

  // Gone from the nav is not gone: an editor with an old link would still
  // land on the agency's board unless the route itself turns them away.
  const today = readFileSync(`${SRC}/app/(app)/today/page.tsx`, "utf8");
  assert.match(
    today,
    /requireUser\(STAFF_ROLES\.filter\(\(r\) => r !== "video_editor"\)\)/,
    "the route bars an editor, who is redirected to their own work"
  );
  ok("and the page turns an editor away rather than showing them the whole agency");
}

await clean();
await finish(pass);
