/**
 * What a phone can read.
 *
 * Measured on a real 390px viewport rather than guessed at, and two findings
 * from that run are pinned here so they cannot come back:
 *
 *   1. A card holding a nine-column table was 924px wide on a 390px screen,
 *      because a grid child defaults to `min-width: auto` — so the page itself
 *      scrolled sideways, header and all, instead of the table scrolling
 *      inside its own box.
 *
 *   2. Folding a column away on small screens means hiding the heading, the
 *      cell AND the totals cell on the same breakpoint. Hiding one and not the
 *      others is worse than not folding at all: every column after it lines up
 *      under the wrong heading, so the numbers are wrong rather than missing.
 *
 * The second is the one a person cannot see in review — the table looks fine
 * on a laptop and lies on a phone — so it is checked here for every table that
 * folds anything.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = process.env.PORTAL_SRC;
const read = (rel) => readFileSync(path.join(SRC, rel), "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/** Every .tsx under src, so a new page cannot quietly skip the check. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}
const FILES = walk(SRC);

/** The breakpoint a cell reappears at, or "shown" when it never folds. */
const foldOf = (tag) => {
  const m = tag.match(/(sm|md|lg|xl|2xl):table-cell/);
  return m ? m[1] : "shown";
};

/**
 * The cells of one row, in order.
 *
 * `colSpan` cells are the empty-state row ("Nothing recorded for this month")
 * and are not a column, so they are skipped.
 */
const cellsOf = (block, tags) =>
  // The lookahead matters: without it `<th` also matches the opening `<thead>`,
  // and every table appears to have one heading more than it has.
  (block.match(new RegExp(`<(?:${tags.join("|")})(?=[\\s/>])[^>]*>`, "g")) || [])
    .filter((t) => !/colSpan/.test(t))
    .map(foldOf);

/* ---------------- a table folds its columns, not half of them ---------------- */
{
  let checked = 0;
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    if (!/(sm|md|lg|xl):table-cell/.test(src)) continue; // folds nothing

    const head = (src.match(/<(THead|thead)[\s\S]*?<\/(THead|thead)>/) || [""])[0];
    const foot = (src.match(/<tfoot[\s\S]*?<\/tfoot>/) || [""])[0];
    if (!head) continue;

    const headCells = cellsOf(head, ["th", "Th"]);
    if (!headCells.length) continue;
    checked++;

    const name = path.relative(SRC, file).replace(/\\/g, "/");

    /*
     * The totals row is the one that has to match exactly. A body row can
     * legitimately differ in count where a page renders several row shapes,
     * but a tfoot is always one row under one head.
     */
    if (foot) {
      const footCells = cellsOf(foot, ["td"]);
      assert.equal(
        footCells.length,
        headCells.length,
        `${name}: the totals row has ${footCells.length} cells under ${headCells.length} headings`
      );
      assert.deepEqual(
        footCells,
        headCells,
        `${name}: the totals row folds on different breakpoints from the headings — ` +
          `head [${headCells.join(",")}] vs foot [${footCells.join(",")}]`
      );
    }
  }
  assert.ok(checked >= 4, `only ${checked} folding tables found — did the parser stop matching?`);
  ok(`${checked} tables fold their headings and totals on the same breakpoints`);
}

/* ---------------- a card may shrink below its content ---------------- */
{
  const card = read("components/ui/card.tsx");
  /*
   * Without this a card holding a wide table sizes to the table, the page
   * scrolls sideways, and the layout is adrift on every phone — measured at
   * 868px of content on a 390px screen before the fix.
   */
  assert.match(card, /"min-w-0"/, "Card carries min-w-0");
  assert.match(card, /min-width: auto/, "and says why, because it looks like a no-op");

  const table = read("components/ui/table.tsx");
  assert.match(table, /overflow-x-auto/, "and the scrolling belongs to the table");
  ok("a card can shrink below its content, so the page never scrolls sideways");
}

/* ---------------- the boards a phone actually opens ---------------- */
{
  /*
   * These are the screens the team uses standing up: their own work, the day's
   * tasks, the poster queue. Each has to fold something, or it is a twelve
   * column table on a 390px screen.
   */
  for (const [file, must] of [
    ["app/(app)/my-work/page.tsx", /hidden md:table-cell/],
    ["app/(app)/deliverables/page.tsx", /hidden w-10 text-right sm:table-cell/],
    ["app/(app)/team/page.tsx", /hidden md:table-cell/],
    ["app/(app)/clients/page.tsx", /hidden md:table-cell/],
    ["components/admin/production-summary.tsx", /hide="hidden md:table-cell"/],
  ]) {
    assert.match(read(file), must, `${file} folds columns on small screens`);
  }

  // And what it folds comes back somewhere, rather than being lost — every one
  // of these restacks the hidden facts under the row's first cell.
  for (const file of [
    "app/(app)/my-work/page.tsx",
    "app/(app)/team/page.tsx",
    "app/(app)/clients/page.tsx",
    "components/admin/production-summary.tsx",
  ]) {
    assert.match(
      read(file),
      /(md:hidden|sm:hidden|lg:hidden)/,
      `${file} restacks what it hid, rather than dropping it`
    );
  }
  ok("the boards a phone opens fold their narrow columns and restack the facts");
}

await finish(pass);
