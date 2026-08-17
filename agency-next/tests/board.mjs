/**
 * The board people work from.
 *
 * Today's Tasks used to be filtered to "due today or overdue", so a quiet day
 * showed one row while the month held thirty — and the thirty were only
 * findable on a different board. It now holds everything, ordered so the day's
 * work is still what page one opens on.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const db = await load("lib/db.ts");
const d = await load("lib/deliverables.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const TAG = "ZZ board client";
const MONTH = new Date().toISOString().slice(0, 7);
const clean = async () => {
  await db.execute(
    "DELETE FROM deliverables WHERE client_id IN (SELECT id FROM clients WHERE company_name LIKE ?)",
    [`${TAG}%`]
  );
  await db.execute("DELETE FROM clients WHERE company_name LIKE ?", [`${TAG}%`]);
};
await clean();

const clientId = Number(
  (await db.execute("INSERT INTO clients (company_name, status) VALUES (?, 'active')", [TAG]))
    .insertId
);
const mk = (title, status, due) =>
  db.execute(
    `INSERT INTO deliverables (client_id, title, status, due_date, month_key, service, instagram_status)
     VALUES (?, ?, ?, ?, ?, 'video_editing', 'none')`,
    [clientId, title, status, due, MONTH]
  );

const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

await mk("ZZ old and done", "posted", "2020-01-01"); // oldest date, finished
await mk("ZZ overdue", "editing", yesterday);
await mk("ZZ due today", "pending", today);
await mk("ZZ next week", "pending", nextWeek);

/* ---------------- everything, with the work still to do first ---------------- */
{
  const rows = await d.getDeliverables({ openFirst: true, clientId });
  const titles = rows.map((r) => r.title);
  assert.equal(rows.length, 4, "the board holds every task, finished ones included");
  assert.deepEqual(
    titles,
    ["ZZ overdue", "ZZ due today", "ZZ next week", "ZZ old and done"],
    `open work first and oldest first within it, got: ${titles.join(", ")}`
  );
  ok("open work leads, oldest first — so page one is the day's work");

  // Without the flag the old order stands, which is what the Tasks board uses.
  const plain = await d.getDeliverables({ clientId });
  assert.equal(plain[0].title, "ZZ old and done", "a 2020 date sorts first when nothing reorders it");
  ok("the flag is opt-in — the Tasks board's own order is untouched");
}

/* ---------------- typing finds it ---------------- */
{
  const byTitle = await d.getDeliverables({ q: "overdue", clientId });
  assert.deepEqual(byTitle.map((r) => r.title), ["ZZ overdue"], "a title matches");

  // The client's name is the first column on the board, so it is the first
  // thing anyone types — and it used not to match anything at all.
  const byClient = await d.getDeliverables({ q: "board client" });
  assert.ok(byClient.length >= 4, `searching the company name finds its work, got ${byClient.length}`);
  assert.ok(byClient.every((r) => r.company_name === TAG));
  ok("search covers the client's name, the title and the caption");
}

/* ---------------- Today is no longer only today ---------------- */
{
  const today = read("app/(app)/today/page.tsx");
  assert.ok(!/today: true/.test(today), "the due-today-only filter is gone");
  assert.match(today, /openFirst: true/, "and the ordering replaces it");
  assert.match(
    today,
    /\{all\.length\} task\{all\.length === 1 \? "" : "s"\}/,
    "the heading counts every task"
  );
  assert.match(today, /due today or overdue, first/, "while still saying how much is actually due");
  ok("Today's Tasks shows the whole board and says how much of it is due");

  /*
   * And a brief nobody has written is on it.
   *
   * It used not to be: `pending` was filtered out because those tasks lived on
   * the content desk, and putting a whole generated month here buried the four
   * things actually in flight. Then the desk was removed and that filter was
   * left behind — so a month generated on the 1st was hidden here and had
   * nowhere else to be, and the day board came up empty.
   */
  assert.equal(
    (today.match(/status !== "pending"/g) || []).length,
    0,
    "pending work is not filtered off the board"
  );
  assert.match(
    today,
    /const all = board\.filter\(\(d\) => !isFinished\(d\.status, d\.posting_status\)\)/,
    "the only thing that leaves the board is finished work"
  );
  // The count beside it links to Approvals → Content ready, which is pending
  // *with copy in it*. Counting bare pending would promise rows that tab has
  // not got.
  assert.match(
    today,
    /d\.status === "pending" && Boolean\(\(d\.description \?\? ""\)\.trim\(\)\)/,
    "and the chip counts what its own link will show"
  );
}

/* ---------------- a generated month is visible the day it is made ---------------- */
{
  // Behaviour, not source: four tasks exactly as generateMonthTasks writes
  // them — pending, nothing written, no footage — plus one being worked on.
  const c = await load("lib/constants.ts");
  const fresh = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES (?, 'active')", [
      `${TAG} fresh`,
    ])).insertId
  );
  const add = (title, status) =>
    db.execute(
      `INSERT INTO deliverables (client_id, title, status, due_date, month_key, service, instagram_status)
       VALUES (?, ?, ?, CURDATE(), ?, 'video_editing', 'none')`,
      [fresh, title, status, MONTH]
    );
  for (const t of ["ZZ Video 1", "ZZ Video 2", "ZZ Video 3"]) await add(t, "pending");
  await add("ZZ being edited", "editing");

  const board = await d.getDeliverables({ openFirst: true, clientId: fresh });
  const shown = board.filter((r) => !c.isFinished(r.status, r.posting_status));
  assert.equal(
    shown.length,
    4,
    `a month generated today is on the day board, got ${shown.length}: ${shown.map((r) => r.title).join(", ")}`
  );

  await db.execute("DELETE FROM deliverables WHERE client_id = ?", [fresh]);
  await db.execute("DELETE FROM clients WHERE id = ?", [fresh]);
  ok("the day a month is generated, its tasks are on the day board");
}

/* ---------------- no sideways scrollbar on a laptop ---------------- */
{
  /*
   * Not a breakpoint. Breakpoints were three guesses in a row.
   *
   * Columns were folded at 1536, then at 1280, and the scrollbar came back on
   * the width the guess did not cover — each time hiding the right-hand
   * columns, Actions among them, which are the parts of a row you click.
   *
   * `table-fixed` on a `w-full` table is a guarantee rather than an estimate:
   * the table is exactly as wide as its container at every size, so the
   * `overflow-x-auto` wrapper has nothing to scroll. The folds below stay
   * because they buy the remaining columns room, but they are no longer what
   * stands between the board and a sideways scroll.
   */
  const table = read("components/ui/table.tsx");
  assert.match(table, /dense &&.*\[&_td\]:px-2/s, "the boards get tighter cells");
  assert.match(table, /dense &&\s*"table-fixed/, "and can never exceed their container");
  assert.match(table, /\[&_td\]:overflow-hidden/, "a long value clips instead of widening the table");
  /*
   * And the headings, which were missed the first time. Only the values were
   * clipped, so at a narrow width "ORGANIZATION" ran straight through
   * "CREATIVE TYPE" and the two words sat on top of each other — a heading
   * overflowing is worse than a value doing it, since it is the thing naming
   * what it has collided with.
   */
  assert.match(table, /\[&_th\]:overflow-hidden/, "and a heading clips rather than colliding");
  assert.match(table, /\[&_th\]:text-ellipsis/, "with an ellipsis, so a clipped word looks clipped");
  assert.match(table, /w-full overflow-x-auto/, "the wrapper is still there, with nothing to do");

  for (const file of ["app/(app)/today/page.tsx", "app/(app)/deliverables/page.tsx"]) {
    const src = read(file);
    assert.match(src, /<Table dense>/, `${file} uses them`);

    // Header and cell fold together, or the table shears — every value lands
    // under the wrong heading, which is worse than a scrollbar.
    assert.equal(
      (src.match(/2xl:table-cell/g) || []).length,
      4,
      `${file}: Caption and Remarks fold as header-and-cell pairs`
    );
    assert.equal(
      (src.match(/[^2]xl:table-cell/g) || []).length,
      4,
      `${file}: Shoot and Video do too`
    );

    /*
     * And table-fixed shares the width equally unless told otherwise, which
     * would give a client's name the same room as a column of dashes. The
     * narrow columns are pinned so the readable ones keep what is left.
     */
    for (const w of ["w-10", "w-28", "w-32", "w-20", "w-16", "w-40"]) {
      assert.ok(src.includes(w), `${file}: ${w} is set on the column that needs it`);
    }

    /*
     * The client's name takes the remainder, and it is the only unpinned
     * column — which is what makes "the remainder" mean anything. A second
     * unpinned column would split it.
     */
    assert.ok(src.includes("<th>Client name</th>"), `${file}: names the client column`);
    assert.equal(
      (src.match(/<th>/g) || []).length,
      1,
      `${file}: exactly one column is left to take the space`
    );
  }
  ok("a dense board is exactly as wide as its container, at any screen size");
}

await clean();
await finish(pass);
