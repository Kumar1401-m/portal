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

/* ---------------- effectiveness is a percentage of the target ---------------- */
{
  const r = await eff.teamEffectiveness();

  // The whole ask: three of three is 100%.
  assert.equal(find(r, "asha").percent, 100, "3 done against a target of 3 is 100%");
  assert.equal(find(r, "bala").percent, 25, "1 against 4 is 25%");
  assert.equal(find(r, "chandu").percent, null, "and no target is no percentage");

  // Team: 4 done by people with targets, against 7 asked for.
  assert.equal(r.totals.doneWithTarget, 4);
  assert.equal(r.totals.target, 7);
  assert.equal(r.totals.percent, 57, "4 of 7 rounds to 57%");
  ok("effectiveness is done ÷ target, per person and for the team");
}

/* ---------------- beating a target is not the same as meeting it ---------------- */
{
  // Capping at 100 would make four-of-three look identical to three-of-three,
  // which is the one comparison a target exists to make.
  const asha = Number(
    (await db.queryOne("SELECT id FROM users WHERE email = 'zz-eff-asha@example.com'")).id
  );
  await task(asha, "ZZ-EFF asha extra", "approved", null, true);
  const r = await eff.teamEffectiveness();
  assert.equal(find(r, "asha").done, 4);
  assert.equal(find(r, "asha").percent, 133, "4 of 3 is 133%, not 100%");
  assert.equal(find(r, "asha").hit, true);
  await db.execute("DELETE FROM deliverables WHERE title = 'ZZ-EFF asha extra'");
  ok("over-achievement is shown as it happened, not rounded down to the target");
}

/* ---------------- an untargeted person cannot inflate the team ---------------- */
{
  // chandu has no target. Work of theirs must not count towards a total built
  // from other people's targets, or the number climbs because somebody was
  // forgotten.
  const chanduId = Number(
    (await db.queryOne("SELECT id FROM users WHERE email = 'zz-eff-chandu@example.com'")).id
  );
  const before = (await eff.teamEffectiveness()).totals;
  await task(chanduId, "ZZ-EFF chandu done", "approved", null, true);
  const after = (await eff.teamEffectiveness()).totals;

  assert.equal(after.percent, before.percent, "the team percentage does not move");
  assert.equal(after.doneWithTarget, before.doneWithTarget, "nor the numerator");
  assert.equal(after.done, before.done + 1, "though the raw count does");
  await db.execute("DELETE FROM deliverables WHERE title = 'ZZ-EFF chandu done'");
  ok("work by someone with no target is counted, but never scored against targets");
}

/* ---------------- it says what it is counting, on its own page ---------------- */
{
  const page = readFileSync(`${SRC}/app/(app)/team/page.tsx`, "utf8");
  assert.match(page, /Resets at midnight/, "the definition sits next to the numbers");
  assert.match(page, /No target set/, "and an unset target is labelled, not scored");
  assert.match(page, /requireUser\(SUPER_ADMIN_ROLES\)/, "super admin only — it names individuals");
  assert.match(page, /Team effectiveness/, "and it is the page's own subject");

  // Days met, never a weekly target invented by multiplying the daily one.
  assert.match(page, /\{m\.hitDays\}\/\{HISTORY_DAYS\} days/, "the week is shown as days met");
  assert.ok(!/daily_target \* 7|target \* 7/.test(page), "no fabricated weekly target");

  const nav = readFileSync(`${SRC}/components/admin/nav-config.ts`, "utf8");
  assert.match(nav, /href: "\/team".*roles: SUPER_ADMIN/, "it has its own nav entry");

  const dash = readFileSync(`${SRC}/app/(app)/dashboard/page.tsx`, "utf8");
  assert.ok(!/TeamEffectiveness/.test(dash), "and is no longer a card on the dashboard");
  ok("the board is its own page, super admin only, and defines its own numbers");
}

await clean();
await finish(pass);
