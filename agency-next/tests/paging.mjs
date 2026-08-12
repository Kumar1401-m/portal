/**
 * Eight tasks a page, on both boards, with the rest one click away.
 *
 * The Tasks board printed every row it had. Thirty of them made a page you
 * scrolled past the window to read, and the count in the heading matched
 * nothing on screen — so the ones below the fold read as missing.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const BOARDS = [
  ["Tasks", "app/(app)/deliverables/page.tsx", "/deliverables", "all"],
  ["Today's Tasks", "app/(app)/today/page.tsx", "/today", "all"],
];

/* ---------------- both boards page, and page the same way ---------------- */
for (const [name, file, basePath, total] of BOARDS) {
  const src = read(file);
  assert.match(src, /const PAGE_SIZE = 8;/, `${name} shows 8 a page`);
  assert.match(
    src,
    new RegExp(`Math\\.ceil\\(${total}\\.length / PAGE_SIZE\\)`),
    `${name} counts its pages from every row, not the page it is on`
  );
  assert.match(
    src,
    /const page = Math\.min\(Math\.max\(1, Math\.trunc\(Number\(sp\.page\)\) \|\| 1\), totalPages\)/,
    `${name} clamps ?page=, so a stale link lands on a real page`
  );
  assert.match(
    src,
    new RegExp(`const rows = ${total}\\.slice\\(\\(page - 1\\) \\* PAGE_SIZE, page \\* PAGE_SIZE\\)`),
    `${name} shows one slice`
  );
  assert.match(src, new RegExp(`<Pager[\\s\\S]{0,220}basePath="${basePath}"`), `${name} renders the pager`);
  assert.match(
    src,
    /\(page - 1\) \* PAGE_SIZE \+ i \+ 1/,
    `${name} numbers rows across pages — row 9 is the ninth task, not the first of page two`
  );
  ok(`${name}: 8 a page, numbered straight through, with Next to the rest`);
}

/* ---------------- the count in the heading is the real one ---------------- */
{
  const tasks = read("app/(app)/deliverables/page.tsx");
  assert.match(
    tasks,
    /\{all\.length\} task\{all\.length === 1 \? "" : "s"\}/,
    "the heading counts everything, which is how you know there is a page 2"
  );
  assert.match(tasks, /\{all\.length === 0 \? \(/, "and the empty state asks about everything, not this page");
  ok("the heading reports the whole set, not the slice on screen");
}

/* ---------------- the filter bar is gone from both ---------------- */
{
  for (const [name, file] of BOARDS) {
    const src = read(file);
    assert.ok(!/TaskFilters/.test(src), `${name} no longer carries the filter bar`);
    assert.ok(!/ColumnFilter\b/.test(src), `${name} has no funnels in the headings either`);
    assert.match(src, /<ServiceTabs/, `${name} keeps the service tabs, which is how the board is narrowed`);
  }
  ok("neither board carries the filter row; the tabs remain");

  // Removing it left three fetches with nothing reading them.
  const tasks = read("app/(app)/deliverables/page.tsx");
  assert.ok(!/getClientsMini/.test(tasks), "the client list is not fetched for a bar that is gone");
  assert.ok(!/getUsedCategories/.test(tasks), "nor the category list");
  assert.match(tasks, /getCategoryMap\(\)/, "but the edit modal still gets its categories");
  ok("the queries that fed the bar went with it, and the one still needed stayed");
}

await finish(pass);
