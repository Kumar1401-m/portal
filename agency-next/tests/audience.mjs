/**
 * Follower counts, and the line that shows where they came from.
 *
 * The chart is the part that can be wrong without looking wrong. A colour is
 * wrong on sight; a line plotted from the wrong baseline is a perfectly
 * handsome line that says something false about somebody's business. So the
 * geometry is a pure function and this is its check.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const db = await load("lib/db.ts");
const { sparkline } = await load("lib/sparkline.ts");
const aud = await load("lib/audience.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const W = 168;
const H = 44;
const months = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
const mk = (vals) => months.slice(-vals.length).map((m, i) => ({ month: m, followers: vals[i] }));

/* ---------------- the line stays inside its box ---------------- */
{
  const cases = [
    ["climbing", mk([880, 905, 930, 948, 975, 1000])],
    ["falling", mk([31, 30, 30, 29, 28, 28])],
    ["dead flat", mk([500, 500, 500, 500, 500, 500])],
    ["a spike", mk([400, 410, 405, 1500, 1100, 900])],
    ["seven figures", mk([1200000, 1217000, 1234000, 1251000, 1268000, 1284309])],
    ["two points", mk([112, 120])],
    ["down to zero", mk([12, 0])],
  ];

  for (const [name, history] of cases) {
    const s = sparkline(history, W, H);
    assert.ok(s, `${name}: draws`);
    for (const p of s.points) {
      assert.ok(p.x >= 0 && p.x <= W, `${name}: x ${p.x} inside the box`);
      assert.ok(p.y >= 0 && p.y <= H, `${name}: y ${p.y} inside the box`);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${name}: no NaN in the path`);
    }
    assert.equal(s.points.length, history.length, `${name}: every month is plotted`);
    assert.ok(!/NaN|Infinity/.test(s.line + s.area), `${name}: the path is drawable`);
  }
  ok(`${cases.length} shapes of history all plot inside the box, with no NaN`);
}

/* ---------------- and it says the right thing about direction ---------------- */
{
  // Up on screen means up in the world. Getting this backwards is the whole
  // reason a chart can be handsome and wrong: SVG y grows downward.
  const rising = sparkline(mk([100, 200]), W, H);
  assert.ok(rising.points[1].y < rising.points[0].y, "more followers sits higher up the box");

  const falling = sparkline(mk([200, 100]), W, H);
  assert.ok(falling.points[1].y > falling.points[0].y, "and fewer sits lower");

  // A run of identical readings has no range to divide by. Down the middle,
  // not a division by zero and not pinned to an edge that reads as a trend.
  const flat = sparkline(mk([500, 500, 500]), W, H);
  assert.ok(flat.points.every((p) => p.y === H / 2), "a flat month is a flat line, centred");

  /*
   * Plotted on its own range, not from zero — 980 → 1,000 against a zero
   * baseline is a straight line across the top, and "did we grow" is the
   * entire question. The tile prints the number beside it, so the scale is
   * never the only thing saying how big the move was.
   */
  const small = sparkline(mk([980, 1000]), W, H);
  assert.ok(
    Math.abs(small.points[0].y - small.points[1].y) > H / 2,
    "a small real move is visible, because the line is scaled to the data"
  );
  ok("up is up, flat is flat, and a small move is not flattened to nothing");
}

/* ---------------- one point is not a line ---------------- */
{
  assert.equal(sparkline([], W, H), null, "no history draws nothing");
  assert.equal(sparkline(mk([100]), W, H), null, "and neither does a single reading");

  const tile = read("components/admin/audience-tile.tsx");
  assert.match(tile, /Growth appears once there is a second month/, "the tile says so in words");
  // Gated on the change being *known*, not on it being non-zero — a genuine
  // flat month should still say so, and an unwatched one must not claim it.
  assert.match(tile, /\{change !== null \? \(/, "the change chip renders only when it is known");
  ok("a first reading shows its number and promises the line later");
}

/* ---------------- two tiles, never one chart ---------------- */
{
  const tile = read("components/admin/audience-tile.tsx");
  /*
   * Instagram in the thousands, Facebook in the dozens. On shared axes the
   * smaller account is a flat line on the floor, and the usual fix — a second
   * y-scale — is the most misread thing in charting: two series that appear
   * to cross when they never met.
   */
  assert.ok(!/y2|secondAxis|rightAxis/i.test(tile), "there is no second y-scale");
  assert.match(tile, /platform: keyof typeof TONES/, "each tile draws exactly one platform");

  // Identity is never colour alone: the label names the platform in text.
  const page = read("app/(app)/ads/[id]/page.tsx");
  assert.match(page, /label="Instagram followers"/, "the tile is labelled, not just coloured");
  assert.match(page, /label="Facebook followers"/);

  // Text wears text tokens; the coloured mark beside it carries identity.
  assert.match(tile, /text-sm font-medium text-muted-foreground/, "the label is ink, not the series hue");
  assert.match(tile, /aria-label=/, "and the line itself is described for a screen reader");
  assert.match(tile, /<title>/, "with a per-month hover label");
  ok("each platform gets its own scale, and colour is never the only signal");
}

/* ---------------- the history is real, and cheap to keep ---------------- */
{
  const lib = read("lib/audience.ts");
  // Written on a page view rather than by a cron: the unique key makes the
  // tenth view of the day an update, not a tenth row.
  assert.match(lib, /ON DUPLICATE KEY UPDATE followers = VALUES\(followers\)/, "one row per day");
  const schema = read("lib/schema-sync.ts");
  assert.match(schema, /UNIQUE KEY uniq_audience_day \(client_id, platform, taken_on\)/, "enforced by the table");

  // A month's figure is where it finished, not its average.
  assert.match(lib, /MAX\(taken_on\) AS last_day/, "a month is counted at its close");

  // And none of it may take the page down: the ad figures are the page's job.
  assert.match(lib, /} catch \(err\) \{/, "a failed snapshot is swallowed");
  assert.match(lib, /return \[\];/, "and costs the chart, never the number");

  // Behaviour: a client with nothing configured has no audience, and asking
  // must not throw.
  const NAME = "ZZ audience none";
  await db.execute("DELETE FROM clients WHERE company_name = ?", [NAME]);
  const id = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES (?, 'active')", [NAME]))
      .insertId
  );
  assert.equal(await aud.getAudience(id), null, "no account configured, nothing claimed");
  await db.execute("DELETE FROM clients WHERE id = ?", [id]);
  ok("history is one row per day, closed monthly, and never fatal");
}

await finish(pass);
