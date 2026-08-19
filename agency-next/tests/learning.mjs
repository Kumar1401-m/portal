/**
 * The arrow that closes the loop.
 *
 *   data → decision → automation → action → result → LEARNING → next decision
 *
 * Everything here decides what an agency makes next, so the failure that
 * matters is a confident number from too little evidence: "myths reels are
 * your best format" off two posts is how a month gets spent on a guess. The
 * arithmetic is checked here, and so is the refusal to speak too early.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const db = await load("lib/db.ts");
const L = await load("lib/learning.ts");
const kinds = await load("lib/content-kinds.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute(
    "DELETE FROM post_insights WHERE client_id IN (SELECT id FROM clients WHERE company_name = 'ZZ loop client')"
  );
  await db.execute(
    "DELETE FROM deliverables WHERE client_id IN (SELECT id FROM clients WHERE company_name = 'ZZ loop client')"
  );
  await db.execute("DELETE FROM clients WHERE company_name = 'ZZ loop client'");
};
await clean();

/* ---------------- the formats are a fixed, closed list ---------------- */
{
  // The keys are written into `deliverables.content_type` and read back months
  // later. A key that changes spelling loses every result recorded under it.
  assert.deepEqual(
    kinds.CONTENT_TYPES.map((t) => t.key),
    ["education", "ad", "lead_magnet", "graphic", "rating", "clone", "funny", "rapid_fire", "myths"]
  );
  assert.deepEqual(
    kinds.POSTER_KINDS.map((k) => k.key),
    ["offer", "festival", "testimonial", "tip", "announcement", "hiring", "before_after", "price_list"]
  );

  // Reels and posters share one column, so their keys must not collide — a
  // poster kind called "education" would be counted as reels.
  assert.equal(
    new Set(kinds.ALL_FORMAT_KEYS).size,
    kinds.ALL_FORMAT_KEYS.length,
    "every format key is unique across both lists"
  );
  // The column is varchar(60).
  for (const k of kinds.ALL_FORMAT_KEYS) assert.ok(k.length <= 60 && /^[a-z_]+$/.test(k), k);

  assert.equal(kinds.formatLabelFor("myths"), "Myths vs facts");
  assert.equal(kinds.formatLabelFor("offer"), "Offer / discount");
  assert.equal(kinds.formatLabelFor("nonsense"), "nonsense", "an unknown key is shown as itself");
  assert.equal(kinds.posterKind("nonsense").key, "offer", "and resolves to the default");
  ok("nine reel formats and eight poster kinds, all distinct, all recordable");
}

/* ---------------- what a format earned, measured ---------------- */
{
  const clientId = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ loop client','active')"))
      .insertId
  );

  /** One published post of `format`, with a given engagement rate. */
  let n = 0;
  const post = async (format, rate, reach = 1000, daysAgo = 10) => {
    n++;
    const del = format
      ? Number(
          (await db.execute(
            `INSERT INTO deliverables (client_id, title, status, content_type, month_key)
             VALUES (?,?,'posted',?,DATE_FORMAT(CURDATE(),'%Y-%m'))`,
            [clientId, `ZZ loop ${n}`, format]
          )).insertId
        )
      : null;
    await db.execute(
      `INSERT INTO post_insights
         (client_id, deliverable_id, platform, media_id, media_type, published_at, snapshot_date,
          reach, likes, comments, saves, shares, total_interactions, engagement_rate)
       VALUES (?,?,'instagram',?,'REELS', DATE_SUB(NOW(), INTERVAL ? DAY), CURDATE(),
               ?,0,0,0,0,?,?)`,
      [clientId, del, `zz-loop-${n}`, daysAgo, reach, Math.round((rate / 100) * reach), rate]
    );
  };

  // Three myths posts well above, three funny posts well below, and two
  // education posts in the middle. Plus one post with no format on it at all,
  // which is what most of a real account's history looks like.
  for (const r of [6, 6, 6]) await post("myths", r);
  for (const r of [1, 1, 1]) await post("funny", r);
  for (const r of [3, 3]) await post("education", r);
  await post(null, 3);

  const l = await L.learned(clientId);
  assert.equal(l.total, 9, "every published post is counted in the baseline");
  assert.equal(l.measured, 8, "but only the ones with a format are attributed");

  const by = (k) => l.formats.find((f) => f.key === k);
  assert.equal(by("myths").posts, 3);
  assert.equal(by("myths").avgEngagement, 6);
  assert.equal(by("funny").avgEngagement, 1);

  // The baseline is EVERY post, including the unattributed one — "better than
  // average" has to mean better than what this account normally does, not
  // better than the average of the posts we happened to label.
  const expected = (6 + 6 + 6 + 1 + 1 + 1 + 3 + 3 + 3) / 9;
  assert.ok(Math.abs(l.baseline - expected) < 0.001, `baseline is ${expected}, got ${l.baseline}`);
  assert.ok(Math.abs(by("myths").lift - 6 / expected) < 0.001, "lift is the format over the account");
  assert.ok(by("myths").lift > 1 && by("funny").lift < 1);

  // Best first, because the first row is the one that gets read.
  assert.equal(l.formats[0].key, "myths");
  assert.equal(l.formats[l.formats.length - 1].key, "funny");
  ok("each format is measured against the account's own average, best first");

  /* ---------------- and it refuses to speak too early ---------------- */
  {
    // Two posts is not a pattern, however good they are.
    await post("rating", 9);
    await post("rating", 9);
    const l2 = await L.learned(clientId);
    const rating = l2.formats.find((f) => f.key === "rating");
    assert.equal(rating.posts, 2);
    assert.equal(rating.proven, false, `${L.MIN_POSTS} posts are needed before a verdict`);

    const lines = L.learnedLines(l2);
    assert.ok(
      !lines.some((s) => /rating/i.test(s)),
      "an unproven format is not named as the strongest, even sitting at the top of the table"
    );

    await post("rating", 9);
    const l3 = await L.learned(clientId);
    assert.equal(l3.formats.find((f) => f.key === "rating").proven, true, "the third post proves it");
    ok("a format with fewer than three posts gets no verdict, whatever its numbers");
  }

  /* ---------------- the sentences the studio is given ---------------- */
  {
    const l4 = await L.learned(clientId);
    const lines = L.learnedLines(l4);
    assert.ok(lines.length, "there is something to say");
    assert.ok(lines.some((s) => /strongest format/i.test(s)), "the best one is named");
    assert.ok(lines.some((s) => /weakest/i.test(s)), "and so is the worst");
    // Every claim carries the evidence it rests on.
    assert.ok(lines.some((s) => /across \d+ posts/i.test(s)), "with the number of posts behind it");
    assert.ok(lines.some((s) => /Never tried/i.test(s)), "and what has not been tried at all");

    // What the loop suggests next.
    const next = L.nextFormat(l4);
    assert.ok(next, "there is always a next move");
    assert.ok(kinds.ALL_FORMAT_KEYS.includes(next.key), "and it is a real format key");
    assert.match(next.why, /\d/, "with a reason that has a number in it");
    ok("the studio is handed plain sentences, each carrying its own evidence");
  }

  /* ---------------- an untried format is the answer when nothing is proven ---------------- */
  {
    const fresh = Number(
      (await db.execute(
        "INSERT INTO clients (company_name, status) VALUES ('ZZ loop client','active')"
      )).insertId
    );
    const empty = await L.learned(fresh);
    assert.equal(empty.formats.length, 0);
    assert.deepEqual(L.learnedLines(empty), [], "nothing measured, nothing claimed");

    const next = L.nextFormat(empty);
    assert.ok(next, "and still a starting point");
    assert.match(next.why, /not a recommendation/i, "labelled as a guess, because it is one");
    ok("a client with no history is given a starting point, not a claim");
  }
}

/* ---------------- the decision is actually written down ---------------- */
{
  // Without this the loop has nothing to read back: the task would say
  // "Instagram Reel", which is a taxonomy and not a decision.
  const ai = read("lib/content-ai.ts");
  assert.match(ai, /content_type/, "idea → task records the format");
  assert.match(ai, /contentType\(input\.idea\.type\)\.key/, "as a known key, never raw model output");

  const poster = read("app/(app)/poster/actions.ts");
  assert.match(poster, /UPDATE deliverables SET content_type = \?/, "and so does a poster draft");
  assert.match(poster, /posterKind\(kind\)\.key/, "with the same guard");

  // The read side only trusts keys the portal issues — `content_type` is an
  // inherited column and may hold anything from an earlier life.
  const learning = read("lib/learning.ts");
  assert.match(learning, /ALL_FORMAT_KEYS\.includes/, "unknown values in the column are ignored");
  // One row per post, not one per daily snapshot.
  assert.match(learning, /MAX\(snapshot_date\)/, "newest snapshot only");

  // And the loop feeds back into what gets written next.
  assert.match(ai, /WHAT WE HAVE LEARNED FROM WHAT WE MADE/, "the brief carries the lessons");
  assert.match(ai, /lessons/, "which every tool reads through the one gate");
  ok("the decision is recorded, read back by known keys, and fed into the next brief");
}

await clean();
await finish(pass);
