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

/* ---------------- posters go round the same loop ---------------- */
{
  const ai = await load("lib/content-ai.ts");
  const clientId = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ loop client','active')"))
      .insertId
  );

  const id = await ai.posterToTask({
    clientId,
    idea: {
      topic: "ZZ Sankranti greeting",
      kind: "festival",
      kindLabel: "Festival greeting",
      headline: "Bring prosperity home",
      visual: "Rangoli and a sugarcane border",
      occasion: "Makar Sankranti",
      why: "Their strongest month last year",
    },
    brief: "HEADLINE: Bring prosperity home",
    createdBy: 1,
  });
  assert.ok(id > 0, "the poster becomes a real task");

  const row = await db.queryOne(
    "SELECT title, service, content_category, content_type, status, description FROM deliverables WHERE id = ?",
    [id]
  );
  // It has to land in the designer's queue like any other poster, or the
  // hand-off built for posters does not pick it up.
  assert.equal(row.service, "poster_designing", "it is poster work");
  assert.equal(row.content_category, "Poster");
  assert.equal(row.status, "pending", "ordinary planned work, not something special");
  assert.equal(row.content_type, "festival", "and the kind is recorded, for the loop to read back");
  assert.match(row.description, /HEADLINE/, "the brief travels with it");
  assert.match(row.description, /VISUAL: Rangoli/, "and so does what to draw");

  // An unknown kind must never be stored: it would be recorded and then
  // ignored by every read, which looks exactly like a kind that never works.
  const junk = await ai.posterToTask({
    clientId,
    idea: { topic: "ZZ junk", kind: "nonsense", kindLabel: "", headline: "", visual: "", occasion: "", why: "" },
    createdBy: 1,
  });
  const j = await db.queryOne("SELECT content_type FROM deliverables WHERE id = ?", [junk]);
  assert.ok(
    kinds.ALL_FORMAT_KEYS.includes(j.content_type),
    `stored "${j.content_type}", which no read will ever match`
  );

  // And the poster kinds are measured by exactly the same code as the reels.
  await db.execute(
    `INSERT INTO post_insights
       (client_id, deliverable_id, platform, media_id, media_type, published_at, snapshot_date,
        reach, likes, comments, saves, shares, total_interactions, engagement_rate)
     VALUES (?,?,'instagram',?,'IMAGE', NOW(), CURDATE(), 1000,0,0,0,0,50,5)`,
    [clientId, id, "zz-poster-1"]
  );
  const l = await L.learned(clientId);
  assert.ok(
    l.formats.some((f) => f.key === "festival"),
    "a poster's result is read back beside the reels"
  );
  assert.equal(l.formats.find((f) => f.key === "festival").label, "Festival greeting");

  await db.execute("DELETE FROM post_insights WHERE media_id = 'zz-poster-1'");
  ok("a poster idea becomes a task, keeps its kind, and comes back through the same loop");
}

/* ---------------- a poster is not described in video words ---------------- */
{
  const { posterStageLabel, editorStatusLabel } = await load("lib/constants.ts");

  /*
   * The complaint this answers: the client report was unreadable, and the
   * worst of it was a poster sitting with its designer showing "Awaiting raw"
   * — raw footage, for something nobody is filming. The poster hand-off sets
   * `waiting_for_raw` when the brief goes to the designer, so that one status
   * has to read differently depending on what the work is.
   */
  assert.equal(editorStatusLabel("waiting_for_raw"), "Awaiting raw", "still right for a video");
  assert.equal(posterStageLabel("waiting_for_raw"), "With the designer", "and right for a poster");
  assert.equal(posterStageLabel("caption_ready"), "Designed — with the admin");
  assert.equal(posterStageLabel("review"), "With the client");
  assert.equal(posterStageLabel("pending"), "Yet to start");
  assert.equal(posterStageLabel("nonsense"), "Yet to start", "an unknown status is not a crash");

  // No poster word may mention shooting, editing or raw footage.
  for (const s of ["pending", "waiting_for_raw", "raw_uploaded", "editing", "caption_ready", "review"]) {
    const said = posterStageLabel(s).toLowerCase();
    for (const wrong of ["raw", "shoot", "footage", "edit"]) {
      assert.ok(!said.includes(wrong), `poster status "${s}" says "${said}", which mentions ${wrong}`);
    }
  }

  const report = read("app/(app)/reports/[id]/page.tsx");
  assert.match(report, /const isPoster = serviceOf\(t\) === "poster_designing"/, "the row knows what it is");

  /*
   * Shoot and Edited are separate columns — merging them into one "Files"
   * column saved a column and cost the thing the column is for, since
   * "has the footage come in" and "is the edit done" are asked by different
   * people on different days.
   *
   * What a poster must never get is a shoot link, because nobody films one.
   */
  assert.match(report, />\s*Shoot\s*<\/th>/, "a Shoot column");
  assert.match(report, />\s*Edited\s*<\/th>/, "and an Edited column beside it");
  assert.match(
    report,
    /isPoster \? \(\s*<span className="text-xs text-muted-foreground">n\/a<\/span>/,
    "a poster is told the shoot does not apply, never offered one"
  );
  assert.match(report, /isPoster \? posterStageLabel/, "the stage is said in the right words");

  // Every row has to have as many cells as there are headings.
  const head = report.match(/<thead[\s\S]*?<\/thead>/)[0];
  const headings = (head.match(/<th[\s>]/g) || []).length;
  assert.equal(headings, 12, "twelve columns");
  const widths = [...head.matchAll(/width: "(\d+)%"/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, headings, "every column has a width");
  assert.equal(
    widths.reduce((a, b) => a + b, 0),
    100,
    `the percentages add to ${widths.reduce((a, b) => a + b, 0)}, not 100`
  );
  assert.match(report, new RegExp(`colSpan=\\{${headings}\\}`), "the empty state spans them all");

  // The board the designers themselves live on had the same problem.
  assert.match(read("app/(app)/poster/page.tsx"), /posterStageLabel\(p\.status\)/);
  ok("a poster is never asked for a shoot, and never told it is awaiting raw footage");
}

/* ---------------- one status, one colour, everywhere ---------------- */
{
  const { contentStatusTone, editorStatusTone } = await load("lib/constants.ts");

  /*
   * The report painted every pill one of two colours — green when finished,
   * amber for everything else — so "Changes requested" and "Editing" were the
   * same shade. Somebody has rejected the work and it has to be done again,
   * against the work going along normally: the two states it matters most to
   * tell apart were the two that matched.
   */
  const report = read("app/(app)/reports/[id]/page.tsx");
  assert.ok(!/bg-amber-500/.test(report), "no page-local amber pill");
  assert.ok(!/bg-green-600/.test(report), "nor a page-local green one");
  assert.match(report, /tone=\{contentStatusTone\(t\.status\)\}/, "the tone comes from the status");
  assert.match(report, /tone=\{editorStatusTone\(t\.status\)\}/);

  // Anything needing somebody to act is red, and never the grey that reads as
  // "nothing has happened yet".
  for (const bad of ["changes_requested", "rejected"]) {
    assert.equal(contentStatusTone(bad), "danger", `${bad} is red on the content track`);
    assert.equal(editorStatusTone(bad), "danger", `${bad} is red on the work track`);
  }
  // And the states that must not look alike, do not.
  const apart = [
    ["approved", "changes_requested"],
    ["editing", "changes_requested"],
    ["editing", "approved"],
    ["waiting_for_raw", "editing"],
    ["pending", "approved"],
  ];
  for (const [a, b] of apart) {
    assert.notEqual(
      editorStatusTone(a),
      editorStatusTone(b),
      `"${a}" and "${b}" are the same colour, which is how one gets read as the other`
    );
  }
  ok("a change request is red, work in progress is not, and no two outcomes share a colour");
}

await clean();
await finish(pass);
