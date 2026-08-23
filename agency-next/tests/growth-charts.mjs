/**
 * Month by month.
 *
 * The rest of the analytics board answers "how did this month go", which a
 * single month cannot answer for growth — it has nothing to be bigger than.
 * These charts put the months side by side, and the rules they follow are the
 * ones that make a chart readable rather than decorative.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const a = await import(pathToFileURL(`${SRC}/lib/analytics.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- every month in the window, present or not ---------------- */
{
  const months = await a.monthlyGrowth(null, 6);
  assert.equal(months.length, 6, "six months asked for, six returned");
  const keys = months.map((m) => m.month);
  assert.deepEqual([...keys].sort(), keys, "oldest first, so the bars read left to right");
  assert.ok(
    /^\d{4}-\d{2}$/.test(keys[0]),
    "and each is a month key the chart can label"
  );
  // A gap is an answer: a month with no work is a short bar, not a missing one.
  assert.ok(months.every((m) => typeof m.reach === "number"), "a quiet month is zero, not absent");
  ok("the window is filled in, so a quiet month shows as a gap rather than vanishing");
}

/* ---------------- reach is counted once per post ---------------- */
{
  /*
   * `post_insights` holds one row per post per day it was read. A plain SUM
   * would multiply a month's reach by however long the sync has been running,
   * which is the same trap `getPosts` already avoids.
   */
  const clean = async () => {
    await db.execute("DELETE FROM post_insights WHERE media_id LIKE 'ZZ_GROW_%'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ growth'");
  };
  await clean();
  const cid = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ growth','active')")).insertId
  );
  try {
    const month = new Date().toISOString().slice(0, 7);
    // The same post, read on three different days.
    for (const [day, reach] of [["01", 100], ["02", 150], ["03", 175]]) {
      await db.execute(
        `INSERT INTO post_insights (client_id, platform, media_id, media_type, published_at,
                                    snapshot_date, reach, likes, comments, saves, shares)
         VALUES (?, 'instagram', 'ZZ_GROW_1', 'REELS', ?, ?, ?, 2, 1, 1, 1)`,
        [cid, `${month}-01 10:00:00`, `${month}-${day}`, reach]
      );
    }
    const row = (await a.monthlyGrowth([cid], 3)).find((m) => m.month === month);
    assert.ok(row, "the month is in the window");
    assert.equal(row.posts, 1, "three readings of one post is one post");
    assert.equal(row.reach, 175, "and its newest reach, not the sum of every reading");
  } finally {
    await clean();
  }
  ok("a post read every day counts once, at its latest figure");
}

/* ---------------- the chart obeys the house rules ---------------- */
{
  const g = readFileSync(`${SRC}/app/(app)/analytics/growth.tsx`, "utf8");

  // Two measures, two charts. One frame with two y-scales is the mistake that
  // makes series appear to cross when they never met.
  assert.equal(
    (g.match(/<Columns/g) || []).length,
    2,
    "followers and reach get a chart each, never two scales on one"
  );

  // Categorical hues in fixed order, never generated. They live in the shared
  // palette now, so the board and the client's PDF cannot drift apart.
  const pal = readFileSync(`${SRC}/lib/chart-palette.ts`, "utf8");
  const mix = pal.split("export const ENGAGEMENT = [")[1].split("] as const;")[0];
  for (const hex of ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]) {
    assert.ok(mix.includes(hex), `${hex} is one of the four validated slots`);
  }
  assert.ok(!mix.includes("hsl(") && !mix.includes("Math.random"), "and none of them is computed");

  // Identity never rests on colour: every slice carries its own number.
  assert.ok(g.includes("{fmt(s.value)}"), "each segment is direct-labelled with its value");
  assert.ok(g.includes("% "), "and its share");

  // Both themes are chosen, not flipped.
  /*
   * The custom property has to live on an ancestor of the marks. It was set on
   * a hidden sibling, so nothing inherited it and every bar fell back to the
   * SVG default — solid black, on both charts.
   */
  assert.ok(
    g.includes('<div className="relative" data-bar={id}>'),
    "the colour is set on the element that contains the svg"
  );
  assert.ok(
    g.includes("var(--bar-${id}, ${tone.light})"),
    "and the fill names a real colour to fall back to, so it can never be black again"
  );
  assert.ok(g.includes('prefers-color-scheme: dark'), "dark mode has its own steps");
  assert.ok(g.includes('[data-theme="dark"]'), "including when the viewer has picked it");
  ok("two measures, two charts, four fixed hues, and a label on every slice");
}

/* ---------------- and the client PDF shows the same charts ---------------- */
{
  /*
   * A client reading "191 accounts reached" has no way of knowing whether that
   * is a good month. The bars behind it are the only thing on the document that
   * answers that, and they are the part a client actually asks about.
   */
  const rep = readFileSync(`${SRC}/app/report/[id]/report-charts.tsx`, "utf8");
  const page = readFileSync(`${SRC}/app/report/[id]/page.tsx`, "utf8");
  assert.ok(page.includes("<ReportCharts months={growth} />"), "the report renders them");
  assert.ok(page.includes("monthlyGrowth([clientId])"), "from that client's own months");

  /*
   * Browsers strip fills when printing to save ink, so a bar chart on paper
   * comes out as a row of empty rectangles without this.
   */
  assert.ok(rep.includes("printColorAdjust"), "and the fills survive the print dialog");

  // No hover on paper: nobody can point at a printed bar, so the values are
  // written down instead.
  assert.ok(!rep.includes("use client"), "the printed charts cost the report no JavaScript");
  assert.ok(!rep.includes("onMouseEnter"), "and carry labels rather than tooltips");

  // One palette, both documents — or a like is one colour on the board and
  // another in the client's copy of the same month.
  const pal = readFileSync(`${SRC}/lib/chart-palette.ts`, "utf8");
  assert.ok(pal.includes("#2a78d6") && pal.includes("#eda100"), "the palette lives in one file");
  const growthSrc = readFileSync(`${SRC}/app/(app)/analytics/growth.tsx`, "utf8");
  for (const src of [rep, growthSrc]) {
    assert.ok(src.includes('from "@/lib/chart-palette"'), "and both charts read it");
    assert.ok(!/#2a78d6/.test(src), "neither keeps a copy of its own");
  }
  ok("the client's PDF carries the same charts, in the same colours, without JavaScript");
}

await finish(pass);
