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
    "DELETE FROM deliverables WHERE client_id IN (SELECT id FROM clients WHERE company_name = ?)",
    [TAG]
  );
  await db.execute("DELETE FROM clients WHERE company_name = ?", [TAG]);
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
  const rows = await d.getDeliverables({ openFirst: true, client: clientId });
  const titles = rows.map((r) => r.title);
  assert.equal(rows.length, 4, "the board holds every task, finished ones included");
  assert.deepEqual(
    titles,
    ["ZZ overdue", "ZZ due today", "ZZ next week", "ZZ old and done"],
    `open work first and oldest first within it, got: ${titles.join(", ")}`
  );
  ok("open work leads, oldest first — so page one is the day's work");

  // Without the flag the old order stands, which is what the Tasks board uses.
  const plain = await d.getDeliverables({ client: clientId });
  assert.equal(plain[0].title, "ZZ old and done", "a 2020 date sorts first when nothing reorders it");
  ok("the flag is opt-in — the Tasks board's own order is untouched");
}

/* ---------------- typing finds it ---------------- */
{
  const byTitle = await d.getDeliverables({ q: "overdue", client: clientId });
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
}

/* ---------------- no sideways scrollbar on a laptop ---------------- */
{
  /*
   * Measured, not assumed: at 1366 the twelve columns overflowed by 75px and
   * at 1280 by 161px, and the columns a scrollbar hides are the right-hand
   * ones — Shoot, Video and Actions, the parts of a row you click.
   */
  const table = read("components/ui/table.tsx");
  assert.match(table, /dense &&.*\[&_td\]:px-2/s, "the boards get tighter cells");

  for (const file of ["app/(app)/today/page.tsx", "app/(app)/deliverables/page.tsx"]) {
    const src = read(file);
    assert.match(src, /<Table dense>/, `${file} uses them`);
    // The two text-heavy columns fold away below a wide screen; everything
    // you act on stays.
    assert.match(src, /<th className="hidden 2xl:table-cell">Caption<\/th>/);
    assert.match(src, /<th className="hidden 2xl:table-cell">Remarks<\/th>/);
    assert.equal(
      (src.match(/2xl:table-cell/g) || []).length,
      4,
      `${file}: both headers and both cells fold together, or the columns shear`
    );
    assert.ok(!/>Shoot<[\s\S]{0,40}hidden/.test(src), "the link columns are never hidden");
  }
  ok("the wide columns fold below 1536px, so nothing scrolls sideways on a laptop");
}

await clean();
await finish(pass);
