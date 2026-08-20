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
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

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
  // The formula is still printed beside the numbers, now with the range spelled
  // out — "over the whole range" is what was missing when somebody read 3 a
  // day, 1 delivered, and 1%.
  assert.match(page, /Efficiency is deliveries ÷ capacity/,
    "the formula is printed next to the numbers");
  assert.match(page, /requireUser\(SUPER_ADMIN_ROLES\)/, "super admin only — it names people");

  const filter = readFileSync(`${SRC}/app/(app)/team/date-filter.tsx`, "utf8");
  assert.match(filter, /name="from"/);
  assert.match(filter, /name="to"/);
  assert.match(filter, /method="GET"/, "the range is a URL, so a report can be shared");
  ok("the report has a date range, and no column it cannot stand behind");
}

await clean();
/* ---------------- the denominator is the range, and it is on screen ---------------- */
{
  /*
   * The bug this pins down: a designer set to 3 a day, with one delivery,
   * showed "1%". The maths was right — the page defaults to month-to-date, so
   * on the 18th the capacity is 3 × 18 = 54 and 1 ÷ 54 is 1.85% — but the row
   * displayed "3" and divided by 54, so the number could not be checked from
   * the row it sat on. Two things were wrong, and neither was the formula.
   */
  const days = eff.daysBetween("2026-08-01", "2026-08-18");
  assert.equal(days, 18, "month-to-date on the 18th is eighteen days");

  const capacity = 3 * days;
  assert.equal(capacity, 54, "a target of 3 a day is 54 over that range");

  // 1 ÷ 54 is 1.85%, and it floors to 1%. That figure is correct and stays —
  // rounding it up to 2% would be the first step towards printing "100%" for
  // 99.6%, which the block above exists to prevent.
  assert.equal(Math.floor((1 / capacity) * 100), 1, "1 of 54 really is 1%");

  const src = read("lib/effectiveness.ts");
  assert.match(src, /Math\.floor\(\(done \/ capacity\) \* 100\)/, "still floored");

  // So the fix is the row, not the formula: the range capacity is a column of
  // its own now, and 1 of 54 is visible rather than something only a tooltip
  // knew. A percentage nobody can check from the row it sits on is a
  // percentage people argue with.
  const page = read("app/(app)/team/page.tsx");
  assert.match(page, /Capacity in \{data\.days\} day/, "the denominator has its own heading");
  assert.match(page, /\{m\.capacity\}/, "and every row shows it");
  assert.match(page, /over the whole\s*\n?\s*range/, "the note says which period is being divided by");
  assert.match(page, /Narrow the dates above to a\s*\n?\s*single day/, "and how to see one day against one day");

  // Three rows of the same table have to have the same number of cells, or the
  // totals line up under the wrong headings.
  const cells = (block, tag) => (block.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
  const head = page.match(/<THead>[\s\S]*?<\/THead>/)[0];
  const body = page.match(/<TBody>[\s\S]*?<\/TBody>/)[0];
  const foot = page.match(/<tfoot[\s\S]*?<\/tfoot>/)[0];
  assert.equal(cells(head, "th"), cells(body, "TD"), "header and body agree");
  assert.equal(cells(head, "th"), cells(foot, "td"), "and so does the totals row");
  ok("efficiency shows what it divided by, and rounds rather than floors");
}

/* ---------------- today, on the clock that stamped the rows ---------------- */
{
  /*
   * The report read 0% for somebody who had uploaded two videos that day.
   *
   * `updated_at` is stamped by MySQL, and this database runs on Indian time
   * while the server rendering the page runs on UTC. Defaulting the range from
   * the server's clock meant that from half past six every evening the report
   * asked for a date the database had already left — so an evening's work
   * counted for nobody, every evening, and nothing on the page said why.
   */
  const today = await eff.reportToday();
  const dbToday = (await db.queryOne("SELECT DATE_FORMAT(CURDATE(),'%Y-%m-%d') AS d")).d;
  assert.equal(today, dbToday, "the default range is built from the database's own date");

  const page = read("app/(app)/team/page.tsx");
  assert.match(page, /const defaultTo = await reportToday\(\)/, "the page asks the database");
  // The old default, which is the whole bug: Date.UTC on the render server.
  assert.ok(!/Date\.UTC\(/.test(page), "and no longer builds the range from its own UTC clock");
  ok("the report's idea of today matches the clock that stamps the work");
}

// The block above this one ends with a clean(), which takes the client with
// it. These need their own.
const cid = Number(
  (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ-EFF client','active')"))
    .insertId
);

/* ---------------- the exact complaint: 2 uploads, capacity 1, not 0% ------------- */
{
  const uid = await mk("evening", "super_admin", 1);
  const today = await eff.reportToday();
  // Late enough that the server's UTC date is still yesterday.
  await db.execute(
    `INSERT INTO deliverables
       (client_id, title, status, month_key, assigned_to, instagram_status, updated_at)
     VALUES (?, 'ZZ-EFF evening 0', 'caption_ready', ?, ?, 'none', ?),
            (?, 'ZZ-EFF evening 1', 'caption_ready', ?, ?, 'none', ?)`,
    [cid, month, uid, `${today} 23:30:00`, cid, month, uid, `${today} 23:30:00`]
  );

  const r = await eff.teamEfficiency(today, today);
  const me = r.members.find((m) => m.id === uid);
  assert.equal(me.deliveries, 2, "both videos counted");
  assert.equal(me.capacity, 1, "against one day at one a day");
  assert.equal(me.efficiency, 200, "which is 200%, not 0");
  ok("two videos uploaded today against a capacity of one reads 200%");
}

/* ---------------- work with nobody's name on it is said out loud ---------------- */
{
  const today = await eff.reportToday();
  await db.execute(
    `INSERT INTO deliverables
       (client_id, title, status, month_key, assigned_to, instagram_status, updated_at)
     VALUES (?, 'ZZ-EFF orphan 0', 'caption_ready', ?, NULL, 'none', ?)`,
    [cid, month, `${today} 10:00:00`]
  );

  const r = await eff.teamEfficiency(today, today);
  assert.equal(r.totals.unassigned, 1, "the unassigned delivery is counted");
  assert.ok(
    !r.members.some((m) => m.name === "orphan"),
    "it belongs to nobody, so it is in no one's row"
  );

  // And the page says so, rather than leaving a low percentage unexplained.
  const page = read("app/(app)/team/page.tsx");
  assert.match(page, /totals\.unassigned > 0/, "the page shows the warning when there is one");
  ok("work nobody was assigned is reported, instead of quietly making everyone look slow");
}

/* ---------------- the upload counts for whoever did it ---------------- */
{
  // "every upload chesthe valle count ravali" — the person who uploads gets
  // the count, even when the task belongs to somebody else. Assignment is a
  // plan; the upload is a fact about who did the work.
  const owner = await mk("owner", "video_editor", 1);
  const uploader = await mk("uploader", "admin", 1);
  const today = await eff.reportToday();

  const id = Number(
    (await db.execute(
      `INSERT INTO deliverables
         (client_id, title, status, month_key, assigned_to, uploaded_by, instagram_status, updated_at)
       VALUES (?, 'ZZ-EFF credited 0', 'caption_ready', ?, ?, ?, 'none', ?)`,
      [cid, month, owner, uploader, `${today} 09:00:00`]
    )).insertId
  );

  const r = await eff.teamEfficiency(today, today);
  assert.equal(r.members.find((m) => m.id === uploader).deliveries, 1, "the uploader is counted");
  assert.equal(r.members.find((m) => m.id === owner).deliveries, 0, "not the assignee");

  // And the task is still theirs — crediting somebody must not move work off
  // another person's plate.
  const row = await db.queryOne("SELECT assigned_to FROM deliverables WHERE id = ?", [id]);
  assert.equal(Number(row.assigned_to), owner, "the assignee is untouched");
  ok("the upload counts for whoever uploaded it, without taking the task off its owner");
}

{
  // Everything nobody uploaded still counts for its assignee — a poster, or a
  // task moved along by hand.
  const solo = await mk("solo", "poster_designer", 1);
  const today = await eff.reportToday();
  await db.execute(
    `INSERT INTO deliverables
       (client_id, title, status, month_key, assigned_to, uploaded_by, instagram_status, updated_at)
     VALUES (?, 'ZZ-EFF credited 1', 'approved', ?, ?, NULL, 'none', ?)`,
    [cid, month, solo, `${today} 09:00:00`]
  );
  const r = await eff.teamEfficiency(today, today);
  assert.equal(r.members.find((m) => m.id === solo).deliveries, 1, "counted for the assignee");
  ok("work with no upload behind it still counts for the person it is assigned to");
}

/* ---------------- so the pile stops growing ---------------- */
{
  // The root of it: uploading a video never put anybody's name on the task, so
  // a one-person team scored zero for everything they did.
  const up = read("app/(app)/deliverables/upload-actions.ts");
  assert.match(up, /SET uploaded_by = \? WHERE id = \?/, "uploading records who uploaded");
  assert.match(
    up,
    /SET assigned_to = \? WHERE id = \? AND assigned_to IS NULL/,
    "and claims the task only when nobody owns it"
  );
  ok("uploading a video records the uploader, and claims the task only if it is unowned");
}

await clean();
await finish(pass);
