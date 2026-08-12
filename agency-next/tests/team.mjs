/**
 * Every staff account can be seen, and therefore managed.
 *
 * The bug this pins: Settings → Team listed roles from a hand-written list,
 * written before `video_editor` existed. You could create an editor — the
 * option is right there in the Add form — and they would vanish from the page
 * the moment they were saved. They still appeared on every board, still took
 * assignments, still had a login. There was simply no screen that could edit,
 * deactivate or delete them.
 *
 * From the outside that is "I removed them and they are still there".
 *
 * Four more places had their own copy of the same list, all equally out of
 * date, so an editor could not be picked as an assignee anywhere either.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const db = await load("lib/db.ts");
const team = await load("lib/team.ts");
const deliverables = await load("lib/deliverables.ts");
const roles = await load("lib/roles.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = () => db.execute("DELETE FROM users WHERE email LIKE 'zz-team-%'");
await clean();

const mk = async (email, name, role) =>
  Number(
    (await db.execute(
      "INSERT INTO users (name, email, password_hash, role, is_active) VALUES (?,?,'x',?,1)",
      [name, email, role]
    )).insertId
  );

/* ---------------- every staff role reaches the Team page ---------------- */
{
  const made = {};
  for (const role of roles.STAFF_ROLES) {
    made[role] = await mk(`zz-team-${role}@example.com`, `ZZ ${role}`, role);
  }

  const listed = await team.getTeam();
  const ids = new Set(listed.map((m) => m.id));
  for (const role of roles.STAFF_ROLES) {
    assert.ok(ids.has(made[role]), `a ${role} appears in Settings → Team`);
  }
  ok(`all ${roles.STAFF_ROLES.length} staff roles are listed, including video_editor`);

  // A client is not staff and is managed from the Clients module.
  const clientUser = await mk("zz-team-client@example.com", "ZZ client login", "client");
  const again = await team.getTeam();
  assert.ok(!again.some((m) => m.id === clientUser), "a client login is not in the team list");
  ok("client logins stay out of it, as they always did");
}

/* ---------------- and can then actually be removed ---------------- */
{
  const editorId = Number(
    (await db.queryOne("SELECT id FROM users WHERE email = 'zz-team-video_editor@example.com'")).id
  );

  // With work assigned, because that is the realistic case and the one where
  // a foreign key could refuse the delete.
  const clientId = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ team client','active')"))
      .insertId
  );
  const taskId = Number(
    (await db.execute(
      `INSERT INTO deliverables (client_id, title, status, month_key, assigned_to, instagram_status)
       VALUES (?, 'ZZ team task', 'editing', ?, ?, 'none')`,
      [clientId, new Date().toISOString().slice(0, 7), editorId]
    )).insertId
  );

  await db.execute("DELETE FROM users WHERE id = ?", [editorId]);
  const after = await team.getTeam();
  assert.ok(!after.some((m) => m.id === editorId), "they are gone from the team list");

  // Their work survives them, unassigned — the delete must not take a client's
  // task with it.
  const task = await db.queryOne(
    "SELECT id, assigned_to FROM deliverables WHERE id = ?",
    [taskId]
  );
  assert.ok(task, "the task they were working on still exists");
  assert.equal(task.assigned_to, null, "and is unassigned rather than deleted");
  ok("removing a member removes them, and leaves their tasks behind unassigned");

  await db.execute("DELETE FROM deliverables WHERE id = ?", [taskId]);
  await db.execute("DELETE FROM clients WHERE id = ?", [clientId]);
}

/* ---------------- an editor can be given work ---------------- */
{
  const editorId = await mk("zz-team-editor2@example.com", "ZZ editor two", "video_editor");
  const assignees = await deliverables.getAssignees();
  assert.ok(
    assignees.some((a) => a.id === editorId),
    "a video editor is offered as an assignee — the whole editing workflow depends on it"
  );

  const crm = await db.queryOne("SELECT id FROM users WHERE email = 'zz-team-crm@example.com'");
  assert.ok(
    !assignees.some((a) => a.id === Number(crm.id)),
    "a crm is not: they own clients, not deliverables"
  );

  // Deactivated people stop being offered new work but stay on the team page,
  // so they can be turned back on.
  await db.execute("UPDATE users SET is_active = 0 WHERE id = ?", [editorId]);
  const after = await deliverables.getAssignees();
  assert.ok(!after.some((a) => a.id === editorId), "a deactivated member is not offered work");
  assert.ok(
    (await team.getTeam()).some((m) => m.id === editorId),
    "but is still listed, because deactivating is not deleting"
  );
  ok("editors can be assigned work; deactivating stops that without hiding them");
}

/* ---------------- one list, so it cannot fall behind again ---------------- */
{
  // Five places kept their own copy and all five were out of date. The point
  // of the constant is that the sixth cannot be.
  for (const [file, wanted] of [
    ["lib/team.ts", "STAFF_ROLES"],
    ["lib/deliverables.ts", "ASSIGNABLE_ROLES"],
    ["app/(app)/assistant-actions.ts", "ASSIGNABLE_ROLES"],
    ["app/(app)/deliverables/client-board-actions.ts", "ASSIGNABLE_ROLES"],
  ]) {
    const src = readFileSync(`${SRC}/${file}`, "utf8");
    assert.match(src, new RegExp(`sqlRoleList\\(${wanted}\\)`), `${file} asks for the shared list`);
    assert.ok(
      !/role IN \('super_admin','admin','poster_designer'/.test(src),
      `${file} keeps no copy of its own`
    );
  }
  assert.ok(roles.ASSIGNABLE_ROLES.includes("video_editor"));
  assert.ok(!roles.ASSIGNABLE_ROLES.includes("crm"));
  assert.equal(roles.sqlRoleList(["admin", "crm"]), "'admin','crm'");
  ok("the role list lives in one place and every caller reads it from there");
}

await clean();
await db.execute("DELETE FROM clients WHERE company_name = 'ZZ team client'");
await finish(pass);
