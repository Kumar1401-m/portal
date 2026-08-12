/**
 * The team board: a daily target per person, and whether they hit it.
 *
 * The arithmetic is trivial. What is worth pinning is what it refuses to say:
 * nobody is judged against a target they were never given, and "done today"
 * means today, not ever.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const db = await load("lib/db.ts");
const eff = await load("lib/effectiveness.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ-EFF %'");
  await db.execute("DELETE FROM clients WHERE company_name = 'ZZ-EFF client'");
  await db.execute("DELETE FROM users WHERE email LIKE 'zz-eff-%'");
};
await clean();

const clientId = Number(
  (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ-EFF client','active')"))
    .insertId
);
const month = new Date().toISOString().slice(0, 7);

const mk = async (name, role, target) =>
  Number(
    (await db.execute(
      `INSERT INTO users (name, email, password_hash, role, is_active, daily_target)
       VALUES (?, ?, 'x', ?, 1, ?)`,
      [name, `zz-eff-${name}@example.com`, role, target]
    )).insertId
  );

/** `doneToday` decides whether updated_at lands on today or long ago. */
const task = (uid, title, status, due, doneToday) =>
  db.execute(
    `INSERT INTO deliverables
       (client_id, title, status, due_date, month_key, assigned_to, instagram_status, updated_at)
     VALUES (?,?,?,?,?,?, 'none', ${doneToday ? "NOW()" : "'2020-01-01 10:00:00'"})`,
    [clientId, title, status, due, month, uid]
  );

const asha = await mk("asha", "video_editor", 3);
const bala = await mk("bala", "poster_designer", 4);
const chandu = await mk("chandu", "video_editor", 0);

for (let i = 1; i <= 3; i++) await task(asha, `ZZ-EFF asha ${i}`, "approved", null, true);
await task(asha, "ZZ-EFF asha late", "editing", "2020-01-01", false);
await task(bala, "ZZ-EFF bala done", "review", null, true);
await task(bala, "ZZ-EFF bala late", "pending", "2020-01-01", false);
await task(chandu, "ZZ-EFF chandu open", "editing", null, false);

const find = (r, name) => r.members.find((m) => m.name === name);

/* ---------------- hitting the target, and missing it ---------------- */
{
  const r = await eff.teamEffectiveness();
  assert.ok(r.ready, "the board is available");

  const a = find(r, "asha");
  assert.equal(a.target, 3);
  assert.equal(a.done, 3, "three moved forward today");
  assert.equal(a.hit, true, "target met");
  assert.equal(a.overdue, 1, "and one of theirs is late, which the board still says");

  const b = find(r, "bala");
  assert.equal(b.done, 1);
  assert.equal(b.hit, false, "one of four is not four");
  ok("done today is counted per person, and measured against their own target");
}

/* ---------------- nobody is judged against a target they were not given ---------------- */
{
  const r = await eff.teamEffectiveness();
  const c = find(r, "chandu");
  assert.equal(c.target, 0);
  // The point: not `false`, and not `true`. A green tick for having been
  // forgotten is worse than a blank, and a red mark is unfair.
  assert.equal(c.hit, null, "no target set means no verdict");
  assert.equal(c.open, 1, "though their work is still shown");

  assert.equal(r.totals.withTarget, 2, "only people with a target are in the denominator");
  assert.equal(r.totals.onTarget, 1, "one of the two hit it");
  assert.equal(r.totals.target, 7, "3 + 4, ignoring the person with none");
  ok("someone with no target is shown with their work and no judgement");
}

/* ---------------- today means today ---------------- */
{
  // Every one of bala's other tasks was last touched in 2020. If the count
  // ignored the date, "done today" would only ever grow.
  const r = await eff.teamEffectiveness();
  assert.equal(find(r, "bala").done, 1, "yesterday's work is not today's");

  // And the date shown is the database's, not this process's — the count uses
  // CURDATE(), and this database's clock is IST while toISOString() is UTC.
  const dbToday = String((await db.queryOne("SELECT CURDATE() AS d")).d).slice(0, 10);
  assert.equal(r.date, dbToday, "the date labels the same day it counted");
  ok("the day resets at the database's midnight, not this process's");
}

/* ---------------- who is even on it ---------------- */
{
  const r = await eff.teamEffectiveness();
  const names = r.members.map((m) => m.name);
  assert.ok(names.includes("asha") && names.includes("bala"), "the people who make the work");

  // A deactivated member is off the board — they are not failing a target,
  // they have left.
  await db.execute("UPDATE users SET is_active = 0 WHERE id = ?", [chandu]);
  const after = await eff.teamEffectiveness();
  assert.ok(!after.members.some((m) => m.name === "chandu"), "someone deactivated drops off");
  await db.execute("UPDATE users SET is_active = 1 WHERE id = ?", [chandu]);
  ok("only active people who can be assigned work appear");
}

/* ---------------- it says what it is counting ---------------- */
{
  const card = readFileSync(`${SRC}/components/admin/team-effectiveness.tsx`, "utf8");
  assert.match(card, /Resets at midnight/, "the definition sits next to the numbers");
  assert.match(card, /No target/, "and an unset target is labelled, not scored");

  const dash = readFileSync(`${SRC}/app/(app)/dashboard/page.tsx`, "utf8");
  assert.match(
    dash,
    /user\.role === "super_admin" \? <TeamEffectiveness \/> : null/,
    "super admin only — it names individuals"
  );
  ok("the board defines its own numbers and is shown to the super admin alone");
}

await clean();
await finish(pass);
