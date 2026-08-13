/**
 * Team efficiency: delivered, against what could have been delivered.
 *
 *     efficiency = deliveries ÷ (days in range × capacity per day)
 *
 * The arithmetic is checked against the figures on the report this was built
 * to match, so a change to the formula fails here rather than in front of
 * whoever is being measured by it.
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

const mk = async (name, role, capacity) =>
  Number(
    (await db.execute(
      `INSERT INTO users (name, email, password_hash, role, is_active, daily_target)
       VALUES (?, ?, 'x', ?, 1, ?)`,
      [name, `zz-eff-${name}@example.com`, role, capacity]
    )).insertId
  );

/** `n` delivered tasks for `uid`, all stamped on `day`. */
const deliver = async (uid, day, n, tag) => {
  for (let i = 0; i < n; i++) {
    await db.execute(
      `INSERT INTO deliverables
         (client_id, title, status, month_key, assigned_to, instagram_status, updated_at)
       VALUES (?, ?, 'approved', ?, ?, 'none', ?)`,
      [clientId, `ZZ-EFF ${tag} ${i}`, month, uid, `${day} 12:00:00`]
    );
  }
};

/* ---------------- the range is the multiplier ---------------- */
{
  assert.equal(eff.daysBetween("2026-08-01", "2026-08-11"), 11, "both ends counted");
  assert.equal(eff.daysBetween("2026-08-01", "2026-08-01"), 1, "a single day is one day");
  assert.equal(eff.daysBetween("2026-08-11", "2026-08-01"), 0, "backwards is nothing to report");
  assert.equal(eff.daysBetween("nonsense", "2026-08-01"), 0);
  ok("the number of days in the range is what capacity is multiplied by");
}

/* ---------------- the report's own numbers ---------------- */
{
  // Straight off the design this replaces. Eleven days, 01–11 August.
  const from = "2026-08-01";
  const to = "2026-08-11";

  const dariya = await mk("dariya", "video_editor", 8); // 147 → 167%
  const siva = await mk("siva", "video_editor", 8); //     33 → 37%
  const naga = await mk("naga", "video_editor", 8); //     86 → 97%
  const hadassa = await mk("hadassa", "poster_designer", 50); // 34 → 6%

  await deliver(dariya, "2026-08-05", 147, "dariya");
  await deliver(siva, "2026-08-05", 33, "siva");
  await deliver(naga, "2026-08-05", 86, "naga");
  await deliver(hadassa, "2026-08-05", 34, "hadassa");

  const r = await eff.teamEfficiency(from, to);
  assert.equal(r.days, 11);
  const find = (n) => r.members.find((m) => m.name === n);

  assert.equal(find("dariya").efficiency, 167, "147 ÷ (11 × 8) is 167%");
  assert.equal(find("siva").efficiency, 37, "33 ÷ 88 is 37%");
  assert.equal(find("naga").efficiency, 97, "86 ÷ 88 is 97%");
  assert.equal(find("hadassa").efficiency, 6, "34 ÷ (11 × 50) is 6%");
  assert.equal(find("dariya").capacity, 88, "capacity is per-day × days");
  ok("every figure matches the report this was built from");

  // Over capacity is shown as it happened. Capping at 100 would make 167%
  // indistinguishable from 100% — the one comparison a capacity is for.
  assert.ok(find("dariya").efficiency > 100, "beyond capacity is not clamped");
  ok("beyond capacity reads as beyond capacity");

  /*
   * Floored, never rounded.
   *
   * Both of these round *up* across a line that matters: 33/88 is 37.5 and
   * 86/88 is 97.7, and rounding would print 38 and 98. The second is the
   * dangerous one — at 99.6% rounding says 100%, which reads as "cleared
   * capacity" about somebody who did not. A figure people are measured by
   * should never round in their favour past the line.
   */
  assert.notEqual(find("siva").efficiency, 38, "37.5% is 37, not 38");
  assert.notEqual(find("naga").efficiency, 98, "97.7% is 97, not 98");

  const nearly = await mk("nearly", "video_editor", 1);
  await deliver(nearly, "2026-08-05", 10, "nearly"); // 10 of 11 = 90.9%
  const again = await eff.teamEfficiency(from, to);
  assert.equal(
    again.members.find((m) => m.name === "nearly").efficiency,
    90,
    "90.9% is 90 — short of capacity stays visibly short of it"
  );
  ok("percentages are floored, so nothing rounds up to look like capacity was met");
}

/* ---------------- deliveries are counted inside the range only ---------------- */
{
  const outside = await mk("outside", "video_editor", 1);
  await deliver(outside, "2026-08-05", 3, "in");
  await deliver(outside, "2026-07-05", 9, "before");
  await deliver(outside, "2026-09-05", 9, "after");

  const r = await eff.teamEfficiency("2026-08-01", "2026-08-11");
  const m = r.members.find((x) => x.name === "outside");
  assert.equal(m.deliveries, 3, "work either side of the range is not in it");
  assert.equal(m.efficiency, 27, "3 ÷ 11 is 27%");

  const wider = await eff.teamEfficiency("2026-07-01", "2026-09-30");
  assert.equal(
    wider.members.find((x) => x.name === "outside").deliveries,
    21,
    "and a wider range picks all of it up"
  );
  ok("a delivery counts on the day it moved, inside the range asked for");
}

/* ---------------- nobody is scored against a capacity they lack ---------------- */
{
  const nocap = await mk("nocap", "video_editor", 0);
  await deliver(nocap, "2026-08-05", 5, "nocap");

  const r = await eff.teamEfficiency("2026-08-01", "2026-08-11");
  const m = r.members.find((x) => x.name === "nocap");
  assert.equal(m.capacityPerDay, 0);
  assert.equal(m.capacity, 0);
  // Not 0%. A red zero for someone nobody set a capacity for is a claim about
  // them that the data does not support.
  assert.equal(m.efficiency, null, "no capacity means no percentage");
  assert.equal(m.deliveries, 5, "their work is still counted and shown");

  // And their deliveries must not lift the team figure, which is built from
  // other people's capacities.
  assert.ok(
    r.totals.deliveriesMeasured < r.totals.deliveries,
    "the team numerator excludes them"
  );
  const expected = Math.floor((r.totals.deliveriesMeasured / r.totals.capacity) * 100);
  assert.equal(r.totals.efficiency, expected, "the team figure is measured over measured");
  ok("someone without a capacity is listed, never scored, and never inflates the team");
}

/* ---------------- the page shows what it can defend ---------------- */
{
  const page = readFileSync(`${SRC}/app/(app)/team/page.tsx`, "utf8");

  // Removed on purpose: the portal tracks no attendance, so a figure under
  // any of these headings would be invented — and an invented denominator
  // makes every percentage on the page quietly wrong.
  for (const gone of ["Leaves", "Holidays", "Working Days"]) {
    assert.ok(!new RegExp(`>${gone}<`).test(page), `${gone} is not a column`);
  }
  for (const kept of ["Employee", "Role", "Deliveries", "Capacity / day", "Efficiency"]) {
    assert.ok(page.includes(kept), `${kept} is`);
  }
  assert.match(page, /Efficiency is deliveries ÷ \(days in range × capacity per day\)/,
    "and the formula is printed next to the numbers");
  assert.match(page, /requireUser\(SUPER_ADMIN_ROLES\)/, "super admin only — it names people");

  const filter = readFileSync(`${SRC}/app/(app)/team/date-filter.tsx`, "utf8");
  assert.match(filter, /name="from"/);
  assert.match(filter, /name="to"/);
  assert.match(filter, /method="GET"/, "the range is a URL, so a report can be shared");
  ok("the report has a date range, and no column it cannot stand behind");
}

await clean();
await finish(pass);
