/**
 * "The automation isn't working."
 *
 * It usually was. Eight conditions decide whether a task enters the publish
 * queue, and a task failing any of them is not returned — no error, no log
 * line, nothing on any screen. The run then reports `considered: 0` and looks
 * perfectly healthy, because from its own point of view it is: there was
 * nothing to do.
 *
 * So the portal could tell you the publisher was running, and could tell you
 * nothing had gone out, and could not connect the two. The only symptom was a
 * client noticing their feed had gone quiet.
 *
 * `publishBlockers` asks the queue's own questions across everything at once
 * and answers in the words somebody would use about it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);
const ig = await import(pathToFileURL(`${SRC}/lib/instagram.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZwhy%'");
  await db.execute("DELETE FROM clients WHERE company_name LIKE 'ZZ why%'");
};
await clean();

/* A client that is fully set up, so each task can break exactly one rule. */
const goodClient = (
  await db.execute(
    `INSERT INTO clients (company_name, status, auto_publish, ig_user_id, placeholder_values)
     VALUES ('ZZ why good', 'active', 1, '17841400000000000', '{"country":"India"}')`
  )
).insertId;

// And one that is not, for the two client-level reasons.
const offClient = (
  await db.execute(
    `INSERT INTO clients (company_name, status, auto_publish, ig_user_id)
     VALUES ('ZZ why off', 'active', 0, '17841400000000000')`
  )
).insertId;

/*
 * `in` rather than `??`, and that is not a style choice: `null ?? default`
 * returns the default, so the "no posting time" fixture quietly got a posting
 * time and the test failed against working code. An override has to be able to
 * mean null.
 */
const pick = (over, key, fallback) => (key in over ? over[key] : fallback);

const task = async (clientId, title, over = {}) =>
  (
    await db.execute(
      `INSERT INTO deliverables
         (client_id, title, status, instagram_status, content_category, due_date,
          scheduled_at, edited_link, post_attempts, month_key)
       VALUES (?, ?, 'approved', ?, ?, '2026-09-10', ?, ?, ?, '2026-09')`,
      [
        clientId,
        title,
        pick(over, "instagram_status", "scheduled"),
        pick(over, "content_category", "Instagram Reel"),
        pick(over, "scheduled_at", "2026-09-10 18:30:00"),
        pick(over, "edited_link", "https://example.com/a.mp4"),
        pick(over, "post_attempts", 0),
      ]
    )
  ).insertId;

/* ------------------------------------------------------------------ *
 * Each rule the queue filters on becomes a reason somebody can act on
 * ------------------------------------------------------------------ */
{
  await task(goodClient, "ZZwhy no time", { scheduled_at: null });
  await task(goodClient, "ZZwhy no file", { edited_link: "" });
  await task(goodClient, "ZZwhy spent", { post_attempts: 9 });
  await task(goodClient, "ZZwhy not a reel", { content_category: "Blog post" });
  await task(offClient, "ZZwhy client off");

  const found = await ig.publishBlockers();
  const by = Object.fromEntries(found.map((b) => [b.key, b]));

  assert.ok(by.no_time, "a task with no posting time is named");
  assert.ok(by.no_file, "so is one with no finished file");
  assert.ok(by.attempts_used, "so is one that has used every attempt");
  assert.ok(by.not_auto_kind, "and one that was never going to post by itself");
  assert.ok(by.auto_publish_off, "and a client with auto-publishing switched off");

  /*
   * Every one carries a fix, not just a diagnosis. "No posting time set" is
   * the same sentence the task page already shows and is no use on its own —
   * the point of this screen is that somebody can act from it.
   */
  for (const b of found) {
    assert.ok(b.fix && b.fix.length > 20, `${b.key} says what to do about it`);
    assert.ok(b.examples.length > 0, `${b.key} names the work it is talking about`);
    assert.ok(b.examples[0].id > 0, "with an id, so the row is one click away");
  }

  // Biggest problem first — the list is meant to be worked down.
  const counts = found.map((b) => b.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), "ordered by how much work is stuck");
  ok("every queue condition becomes a named reason, with a fix and an example");
}

/* ------------------------------------------------------------------ *
 * One reason per task
 * ------------------------------------------------------------------ */
{
  /*
   * A task with no file *and* no time is one problem — "it is not finished" —
   * and counting it under both would make the list add up to more work than
   * exists, which is how a screen like this stops being trusted.
   */
  await task(goodClient, "ZZwhy broken twice", { scheduled_at: null, edited_link: "" });

  const found = await ig.publishBlockers();
  const total = found.reduce((n, b) => n + b.count, 0);

  /*
   * Counted against every task the blocker query looks at, not only this
   * test's own rows.
   *
   * `publishBlockers` scans the whole board by design, so other fixtures in
   * the suite land in the same totals. Comparing a global count to a local one
   * passed when this file ran alone and failed the moment the suite ran
   * together — which is a broken test, not a broken feature.
   */
  const rows = await db.query(
    `SELECT COUNT(*) AS n
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned'
        AND d.instagram_status IN ('scheduled', 'not_posted', 'failed')
        AND d.status IN ('approved', 'scheduled', 'caption_ready', 'completed')`
  );
  assert.ok(
    total <= Number(rows[0].n),
    `no task is counted twice (${total} reasons across ${rows[0].n} candidate tasks)`
  );
  ok("a task appears once, under the first thing worth fixing about it");
}

/* ------------------------------------------------------------------ *
 * A healthy setup says so
 * ------------------------------------------------------------------ */
{
  await clean();
  const found = await ig.publishBlockers();
  assert.deepEqual(found, [], "nothing stuck means an empty list, not a made-up reason");

  /*
   * And the page says it in words. "No blockers" rendered as a blank area
   * looks like a screen that failed to load, which is the thing this whole
   * feature exists to stop.
   */
  const page = read("app/(app)/automations/page.tsx");
  assert.ok(page.includes("Nothing is stuck"), "the page says so rather than showing a blank");
  assert.ok(page.includes("Why work is not going out"), "under a heading that names the question");
  ok("a healthy pipeline is stated, not left as an empty space");
}

/* ------------------------------------------------------------------ *
 * It cannot take the page down
 * ------------------------------------------------------------------ */
{
  /*
   * This is a diagnostic. A diagnostic that breaks the page it diagnoses is
   * worse than no diagnostic — and this one runs on the screen somebody opens
   * precisely when things are already going wrong.
   */
  const page = read("app/(app)/automations/page.tsx");
  assert.ok(page.includes("publishBlockers().catch(() => [])"), "a failure here shows nothing");

  const src = read("lib/instagram.ts");
  const fn = src.slice(src.indexOf("export async function publishBlockers"));
  assert.ok(fn.includes(".catch(() => [])"), "and the query itself cannot throw");
  assert.ok(fn.includes("LIMIT 300"), "and is bounded, however much work exists");
  ok("the diagnostic is incapable of breaking the page it is on");
}

/* ------------------------------------------------------------------ *
 * A closed window is not a broken schedule
 * ------------------------------------------------------------------ */
{
  /*
   * Seen on a real one: a Freskos reel seventeen hours past its 6pm Sydney
   * slot, the publishing schedule healthy in the logs, and the missed-posts
   * board saying **"Nothing collected it — check the publishing schedule is
   * running"**.
   *
   * Nothing was wrong with the schedule and nothing was wrong with the row.
   * The window had closed, which is a decision the publisher makes on purpose
   * — a reel going out at three in the morning reaches nobody. But
   * `missedReason` never checked the window, so every such post fell through
   * to the last line and blamed the cron, sending somebody to look at the one
   * thing that was working.
   */
  const q = read("lib/queries.ts");
  const fn = q.slice(q.indexOf("function missedReason("), q.indexOf("Videos whose posting slot"));

  assert.ok(fn.includes("missedItsWindow("), "the window is checked");
  assert.ok(
    fn.indexOf("missedItsWindow(") < fn.indexOf("Nothing collected it"),
    "and checked before the schedule is blamed"
  );
  assert.ok(fn.includes("postingTimeLabel("), "the message names the window it missed");
  assert.ok(/move the date, or use Post now/.test(fn), "and says what to do — it will not go on its own");

  // The schedule message survives for the case it is actually about: a post
  // still inside its window that nothing has collected.
  assert.ok(fn.includes("Nothing collected it"), "the schedule message is kept for its real case");
  ok("a post past its window says so, instead of sending somebody to check a healthy cron");
}

await finish(pass);
