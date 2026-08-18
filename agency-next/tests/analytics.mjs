/**
 * Published performance.
 *
 * The whole board is built on four small pieces of arithmetic, and every one
 * of them has a wrong answer that looks perfectly reasonable on screen:
 * dividing by followers instead of reach, ranking by reach instead of rate,
 * letting one lucky post become "post on Tuesdays", totalling where an average
 * was meant. None of those throw. They just quietly tell a client the wrong
 * thing, which is why they are tested rather than eyeballed.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const a = await load("lib/analytics.ts");
const db = await load("lib/db.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/** A post, with only the fields the arithmetic reads. */
const post = (o = {}) => ({
  media_id: o.media_id ?? String(Math.random()),
  permalink: null,
  media_type: o.media_type ?? "IMAGE",
  caption: o.caption ?? null,
  // `in`, not `??` — a test that deliberately passes null wants null, and
  // `??` would hand it the default and quietly test nothing.
  posted_at: "posted_at" in o ? o.posted_at : "2026-08-04 10:00:00",
  reach: o.reach ?? 1000,
  likes: o.likes ?? 0,
  comments: o.comments ?? 0,
  saves: o.saves ?? 0,
  shares: o.shares ?? 0,
  views: o.views ?? 0,
  client_id: o.client_id ?? 1,
});

/* ---------------- engagement is measured against who saw it ---------------- */
{
  const p = post({ reach: 1000, likes: 80, comments: 10, saves: 8, shares: 2 });
  assert.equal(a.engagementRate(p), 10, "100 interactions of 1000 reached is 10%");
  assert.equal(a.interactions(p), 100);

  // Not against followers. A growing account would otherwise look like it was
  // getting worse every month it gained people.
  assert.equal(a.engagementRate({ ...p, reach: 2000 }), 5, "the same post, twice the reach");

  // Null, never zero: a post Meta has not reported on has no rate, and 0%
  // reads as a failure it did not have.
  assert.equal(a.engagementRate(post({ reach: 0, likes: 4 })), null, "no reach, no rate");
  ok("engagement is a share of reach, and unknown reach has no rate");
}

/* ---------------- the ranking is by rate, with a floor ---------------- */
{
  const tiny = post({ media_id: "tiny", reach: 11, likes: 4 });          // 36%
  const big = post({ media_id: "big", reach: 5000, likes: 400 });        // 8%
  const mid = post({ media_id: "mid", reach: 900, likes: 180 });         // 20%

  const top = a.rank([tiny, big, mid]);
  assert.deepEqual(top.map((p) => p.media_id), ["mid", "big"], "rate order, tiny excluded");

  // The floor is what stops a post seen by eleven people topping the month.
  assert.ok(!top.some((p) => p.media_id === "tiny"), "a post below the reach floor cannot win");
  // And it is a floor, not a filter on the whole board — lower it and it is back.
  assert.equal(a.rank([tiny], 5, 10)[0]?.media_id, "tiny", "the floor is the only thing excluding it");
  ok("best posts are ranked by engagement rate above a reach floor");
}

/* ---------------- slots are averaged, and need more than one post ---------------- */
{
  // Monday: eight posts, all mediocre. Friday: two, both strong. A total would
  // hand it to Monday for having been busy.
  const monday = Array.from({ length: 8 }, (_, i) =>
    post({ media_id: `m${i}`, posted_at: "2026-08-03 09:00:00", reach: 1000, likes: 20 })
  );
  const friday = [
    post({ media_id: "f1", posted_at: "2026-08-07 18:00:00", reach: 1000, likes: 200 }),
    post({ media_id: "f2", posted_at: "2026-08-14 18:00:00", reach: 1000, likes: 220 }),
  ];
  const once = post({ media_id: "x", posted_at: "2026-08-05 03:00:00", reach: 1000, likes: 900 });

  const days = a.slots([...monday, ...friday, once], "weekday");
  assert.equal(a.WEEKDAYS[Number(days[0].key)], "Friday", "the better day wins, not the busier one");
  assert.equal(days.length, 2, "and the day with one post is not offered as advice");
  assert.equal(days.find((d) => a.WEEKDAYS[Number(d.key)] === "Monday").posts, 8);

  // A post with no timestamp cannot be placed in a slot and must not become one.
  assert.equal(a.slots([post({ posted_at: null }), post({ posted_at: null })], "weekday").length, 0);
  ok("best day is an average, and one post is never a pattern");
}

/* ---------------- totals, and the labels people read ---------------- */
{
  const t = a.sum([
    post({ reach: 100, likes: 5, saves: 1 }),
    post({ reach: 250, likes: 10, shares: 2, comments: 3 }),
  ]);
  assert.deepEqual(
    { posts: t.posts, reach: t.reach, likes: t.likes, saves: t.saves, shares: t.shares },
    { posts: 2, reach: 350, likes: 15, saves: 1, shares: 2 }
  );

  assert.equal(a.formatLabel("REELS"), "Reel");
  assert.equal(a.formatLabel("VIDEO"), "Reel", "an older video is the same thing to a client");
  assert.equal(a.formatLabel("CAROUSEL_ALBUM"), "Carousel");
  assert.equal(a.formatLabel("IMAGE"), "Post");
  assert.equal(a.formatLabel(""), "Post", "and an unset type is not a blank column");

  assert.equal(a.hourLabel("0"), "12 AM", "midnight is not 0 AM");
  assert.equal(a.hourLabel("12"), "12 PM", "and noon is not 0 PM");
  assert.equal(a.hourLabel("15"), "3 PM");
  ok("totals add up and the labels are the words a person uses");
}

/* ---------------- one post is one post, however often it was read ---------------- */
{
  /*
   * `post_insights` was already in this schema, and it keeps one row per post
   * *per day* — so a reel read every morning for a fortnight is fourteen rows.
   * Summing them multiplies a client's month by however long the sync has
   * been running, and every figure on the board and in the report they receive
   * would be wrong in the flattering direction. That is worth a real database.
   */
  const clean = async () => {
    await db.execute("DELETE FROM post_insights WHERE media_id LIKE 'ZZ_INS_%'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ insights'");
  };
  await clean();

  const clientId = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ insights','active')"))
      .insertId
  );

  const snap = (mediaId, day, reach, likes, published) =>
    db.execute(
      `INSERT INTO post_insights (client_id, platform, media_id, media_type, permalink, caption,
         published_at, snapshot_date, reach, likes, comments, saves, shares,
         total_interactions, engagement_rate)
       VALUES (?,'instagram',?,'REELS',?,'ZZ caption',?,?,?,?,0,0,0,?,?)`,
      [clientId, mediaId, `https://x/${mediaId}`, published, day, reach, likes, likes,
       ((likes / reach) * 100).toFixed(2)]
    );

  // One reel, read on three mornings as its reach climbed. One photo, read once.
  await snap("ZZ_INS_1", "2026-03-05", 4000, 300, "2026-03-04 18:00:00");
  await snap("ZZ_INS_1", "2026-03-06", 4200, 310, "2026-03-04 18:00:00");
  await snap("ZZ_INS_1", "2026-03-07", 4400, 320, "2026-03-04 18:00:00");
  await snap("ZZ_INS_2", "2026-03-12", 1000, 50, "2026-03-11 09:00:00");

  const posts = await a.getPosts("2026-03-01", "2026-03-31", { clientId });
  assert.equal(posts.length, 2, "two posts, not four snapshots");

  const t = a.sum(posts);
  // 4400 + 1000. Summing every row would say 13,600 — three times the truth.
  assert.equal(t.reach, 5400, "and the newest reading of each, not all of them added");
  assert.equal(t.likes, 370, "same for every other figure on the row");

  const rows = a.byClient(posts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totals.reach, 5400, "the per-client roll-up counts each post once");

  // Scope is honoured: a crm with no clients sees nothing, not everything.
  assert.equal((await a.getPosts("2026-03-01", "2026-03-31", { clientIds: [] })).length, 0);
  assert.equal((await a.getPosts("2026-03-01", "2026-03-31", { clientIds: [clientId] })).length, 2);
  // And the range is on when it was published, not when it was read.
  assert.equal((await a.getPosts("2026-03-08", "2026-03-31", { clientId })).length, 1);

  await clean();
  ok("a post read every day is still one post in every total");
}

await finish(pass);
