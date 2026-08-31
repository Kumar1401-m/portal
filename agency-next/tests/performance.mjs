/**
 * "What will this post do?" — and the far more important "we cannot say yet".
 *
 * The ask was a trained prediction model. A model needs examples, and a model
 * fitted to three posts produces a confident number with no information in it,
 * on a client's account, with nothing about the output to say so. A wrong
 * answer that looks exactly like a right one is the worst thing this portal
 * can do, so the floor comes first and the arithmetic second.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const perf = await import(pathToFileURL(`${SRC}/lib/performance.ts`).href);
const learn = await import(pathToFileURL(`${SRC}/lib/learning.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute("DELETE FROM post_insights WHERE media_id LIKE 'ZZ_PF_%'");
  await db.execute("DELETE FROM deliverables WHERE title LIKE 'ZZ perf%'");
  await db.execute("DELETE FROM clients WHERE company_name = 'ZZ perf'");
};

await clean();
const cid = Number(
  (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ perf','active')")).insertId
);

const post = async (n, { format, reach, face = null }) => {
  const did = Number(
    (await db.execute(
      `INSERT INTO deliverables (client_id, title, status, content_type, content_category,
                                 language, video_duration, caption, hashtags, posted_at)
       VALUES (?, ?, 'posted', ?, 'Instagram Reel', 'English', 42,
               'Come and see us — DM to book.', '#a #b #c', '2026-08-11 17:00:00')`,
      [cid, `ZZ perf ${n}`, format]
    )).insertId
  );
  if (face !== null) {
    await db.execute(
      "INSERT INTO video_analysis (deliverable_id, state, has_face) VALUES (?, 'done', ?)",
      [did, face ? 1 : 0]
    );
  }
  await db.execute(
    `INSERT INTO post_insights (client_id, deliverable_id, platform, media_id, media_type,
                                published_at, snapshot_date, reach, likes, comments, saves, shares)
     VALUES (?, ?, 'instagram', ?, 'REELS', '2026-08-11 17:00:00', CURDATE(), ?, 1, 0, 0, 0)`,
    [cid, did, `ZZ_PF_${n}`, reach]
  );
  return did;
};

try {
  /* ---------------- it refuses to guess ---------------- */
  {
    await post(1, { format: "myths", reach: 100 });
    const p = await perf.expectedPerformance(cid, { format: "myths", category: null, hasFace: null, language: null, weekday: null });
    assert.equal(p.expected, null, "one post predicts nothing");
    assert.match(p.note, /Only 1 published post/, "and says so plainly rather than returning zero");
    assert.equal(p.signals.length, 0, "no group is reported from a single post");
    ok("with almost no history it declines to answer, and explains why");
  }

  /* ---------------- and once there is history, it uses theirs ---------------- */
  {
    await post(2, { format: "myths", reach: 300, face: true });
    await post(3, { format: "myths", reach: 200, face: true });
    await post(4, { format: "rapid", reach: 50, face: false });

    const p = await perf.expectedPerformance(cid, {
      format: "myths", category: null, hasFace: true, language: null, weekday: null,
    });
    assert.equal(p.sample, 4, "every post with numbers is in the sample");
    assert.equal(p.baselineReach, 150, "the baseline is their own middle post");

    const fmt = p.signals.find((s) => s.label.includes("myths"));
    assert.ok(fmt, "the format is reported as a signal");
    assert.equal(fmt.posts, 3, "with the count behind it");
    assert.equal(fmt.medianReach, 200, "and its own median, not the roster's");
    assert.equal(fmt.proven, true, `three posts meets the floor of ${learn.MIN_POSTS}`);
    assert.ok(fmt.vsBaseline > 0, "compared against this client and nobody else");

    // Two posts is not a pattern, however striking the number.
    const face = p.signals.find((s) => s.label.includes("on camera"));
    assert.ok(face, "the on-camera group is reported");
    assert.equal(face.proven, false, "but not as proven, on two posts");

    assert.ok(p.expected, "and a range is offered");
    assert.ok(
      p.expected.low < p.expected.high && p.expected.low > 0,
      "as a range rather than a single number — a median over a handful is a middle, not a forecast"
    );
    ok("it answers from this client's own history, and marks what is proven");
  }

  /* ---------------- an unproven signal never leads ---------------- */
  {
    /*
     * The trap: a two-post group can show the biggest percentage precisely
     * because it has two posts in it. Letting that set the range would make
     * the least reliable evidence the loudest thing on the page.
     */
    const src = (await import("node:fs")).readFileSync(`${SRC}/lib/performance.ts`, "utf8");
    assert.ok(
      src.includes("signals.find((s) => s.proven)"),
      "the range is led by the strongest PROVEN signal, not the strongest one"
    );
    ok("the loudest number does not get to lead unless it is earned");
  }

  /* ---------------- the features are read, not copied ---------------- */
  {
    const did = await post(5, { format: "myths", reach: 120, face: true });
    const f = await perf.featuresFor(did);
    assert.equal(f.format, "myths");
    assert.equal(f.durationSec, 42, "duration comes from the row that already had it");
    assert.equal(f.hashtagCount, 3, "hashtags are counted, not stored again");
    assert.equal(f.hasCta, true, "a caption that asks for something is marked as asking");
    assert.equal(f.hasFace, true, "and what the AI saw is carried through");
    assert.equal(f.weekday, 2, "the day it went out, from its own timestamp");
    assert.equal(f.hour, 17, "and the hour");
    ok("every feature is assembled from where it already lives");
  }
} finally {
  await clean();
}

await finish(pass);
