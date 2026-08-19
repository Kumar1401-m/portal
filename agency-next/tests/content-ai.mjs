/**
 * The content studio's brief.
 *
 * Five tools sit on one brief, and the brief is the only thing separating them
 * from a free chatbot. So what is tested is not the generated text — that is
 * the model's — but the three things the portal is responsible for:
 *
 *   that the brief actually carries what already worked for THIS account,
 *   that it refuses to claim a pattern it cannot see,
 *   and that the client's rules reach every tool as rules.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const content = await load("lib/content-ai.ts");
const knowledge = await load("lib/knowledge.ts");
const db = await load("lib/db.ts");
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const clean = async () => {
  await db.execute("DELETE FROM post_insights WHERE media_id LIKE 'ZZS_%'");
  await db.execute("DELETE FROM clients WHERE company_name = 'ZZ studio'");
};
await clean();

const clientId = Number(
  (await db.execute(
    "INSERT INTO clients (company_name,status,business_type) VALUES ('ZZ studio','active','Physiotherapy clinic')"
  )).insertId
);

const post = (mid, published, type, reach, likes) =>
  db.execute(
    `INSERT INTO post_insights (client_id,platform,media_id,media_type,permalink,caption,published_at,
       snapshot_date,reach,likes,comments,saves,shares,total_interactions,engagement_rate)
     VALUES (?,'instagram',?,?,?,?,?,CURDATE(),?,?,0,0,0,?,?)`,
    [clientId, mid, type, `https://x/${mid}`, `ZZ ${mid} caption`, published, reach, likes, likes,
     ((likes / reach) * 100).toFixed(2)]
  );

/* ---------------- a thin account is told it is thin ---------------- */
{
  // Three posts. True, and no basis for "reels work best for you".
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + " 18:00:00";
  await post("ZZS_a", day(5), "REELS", 1000, 50);
  await post("ZZS_b", day(9), "IMAGE", 400, 10);
  await post("ZZS_c", day(14), "REELS", 1200, 70);

  const thin = await content.buildBrief(clientId);
  assert.equal(thin.grounded, false, "three posts is not a pattern");
  assert.deepEqual(thin.performance, [], "so nothing is claimed about what works");
  ok("an account without enough history is not handed a story about itself");
}

/* ---------------- a real history produces real findings ---------------- */
{
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + " 18:00:00";
  // Reels reach far further than photos here, and there are enough of both.
  for (let i = 0; i < 6; i++) await post(`ZZS_r${i}`, day(3 + i * 4), "REELS", 3000, 200);
  for (let i = 0; i < 4; i++) await post(`ZZS_p${i}`, day(5 + i * 4), "IMAGE", 500, 20);

  const b = await content.buildBrief(clientId);
  assert.equal(b.grounded, true, "ten posts is enough to speak");
  const joined = b.performance.join(" ");

  assert.match(joined, /Reels reach [\d.]+× further than posts/i, "the format gap is stated as a ratio");
  assert.match(joined, /average reach/i, "with the figures behind it");
  assert.match(joined, /strongest day/i, "the best day is named");
  assert.match(joined, /best posts lately/i, "and the posts that actually did well are quoted");

  // The client's own name and business reach the brief — this is what stops
  // the output being advice that would fit any account.
  assert.match(b.context, /ZZ studio/);
  assert.match(b.context, /Physiotherapy clinic/);
  assert.equal(b.client, "ZZ studio");
  ok("a real history becomes plain sentences about what this account is rewarded for");
}

/* ---------------- the client's rules reach the brief as rules ---------------- */
{
  await knowledge.saveKnowledge(clientId, {
    audience: "Families in Vijayawada",
    bannedTerms: "cure\nguaranteed",
    ctas: "WhatsApp us on 98765 43210",
  });

  const b = await content.buildBrief(clientId);
  assert.ok(b.rules, "the rules block is built");
  assert.match(b.rules, /NOT OPTIONAL/);
  assert.match(b.rules, /cure/);

  // And never as briefing material, where a model would treat "cure" as a
  // word this clinic uses.
  assert.ok(!/cure|guaranteed/.test(b.context), "banned words stay out of the briefing block");
  assert.match(b.context, /Families in Vijayawada/, "while the audience is briefing material");
  ok("the fact/rule split survives into the studio's brief");
}

/* ---------------- every tool is handed the rules, twice ---------------- */
{
  const src = read("lib/content-ai.ts");

  // One place builds the prompt, so no tool can be added that forgets.
  assert.match(src, /function briefBlock/, "one shared block builder");
  assert.match(src, /b\.rules \?\? ""/, "which includes the rules");
  // Repeated at the end, because in a long prompt the instructions nearest the
  // output contract are the ones actually obeyed.
  assert.match(src, /re-read the client's rules above\. They are not optional/i);

  for (const fn of ["contentStrategy", "contentIdeas", "generateScript", "thumbnailConcepts", "seoPack", "posterContent"]) {
    assert.match(src, new RegExp(`export async function ${fn}`), `${fn} exists`);
  }

  /*
   * The invariant, not a count: every tool reaches the model through
   * `generate`, which is what attaches the brief and the rules. A tool added
   * later that calls `callJSON` itself would silently write for a client it
   * knows nothing about — so what is asserted is that nothing bypasses the
   * gate, and the number of tools is free to grow.
   */
  const gateCalls = (src.match(/await generate\(/g) || []).length;
  const directCalls = (src.match(/callJSON\(/g) || []).length;
  assert.ok(gateCalls >= 6, `every tool goes through the gate (${gateCalls} calls)`);
  assert.equal(directCalls, 1, "and callJSON is reached from exactly one place — inside `generate`");
  assert.match(
    src.slice(src.indexOf("async function generate("), src.indexOf("const asStr")),
    /callJSON\(system, user\)/,
    "which is that one place"
  );
  ok("no tool can be added that forgets the brief or the rules");
}

/* ---------------- nothing invents a fallback ---------------- */
{
  const src = read("lib/content-ai.ts");
  // A generated script nobody asked for is worse than an empty panel, because
  // it gets used. Every tool returns null when the model gives nothing.
  for (const marker of [
    "if (!data) return null;",
    "if (!data || !Array.isArray(data.ideas)) return null;",
    "if (!data || !Array.isArray(data.concepts)) return null;",
  ]) {
    assert.ok(src.includes(marker), `refuses rather than invents: ${marker}`);
  }
  assert.ok(!/fallback(Script|Idea|Strategy)/i.test(src), "there is no invented fallback anywhere");

  // The one exception, and it is assembly rather than invention: the whole
  // script is always rebuilt from the five sections, so what gets copied is
  // exactly what is displayed above it — a model returning a `full` that
  // disagrees with its own sections cannot put a third version on the clipboard.
  assert.match(
    src,
    /s\.full = \[s\.hook, s\.body, s\.cta\]\.filter\(Boolean\)\.join/,
    "`full` is assembled from the three sections rather than trusted"
  );
  ok("a silent model produces an empty panel, never a plausible script");
}

/* ---------------- an idea can leave the panel ---------------- */
{
  const src = read("lib/content-ai.ts");
  assert.match(src, /export async function ideaToTask/, "an idea can become a task");
  assert.match(src, /INSERT INTO deliverables/);
  // The reason travels with it — whoever picks the task up in a fortnight
  // needs to know why it was chosen.
  assert.match(src, /input\.idea\.why/, "the reason is written into the task");
  assert.match(src, /input\.idea\.hook/, "and so is the hook");

  const idea = {
    topic: "ZZ knee pain in winter",
    hook: "Your knee hurts more in December. Here is why.",
    format: "Reel",
    audience: "30-55",
    cta: "WhatsApp us",
    why: "Reels reach 6× further for this account",
    potential: "high",
  };
  const taskId = await content.ideaToTask({ clientId, idea, createdBy: 1 });
  assert.ok(taskId > 0, "the task is created");

  const row = await db.queryOne(
    "SELECT title, description, content_hook, content_category, status FROM deliverables WHERE id = ?",
    [taskId]
  );
  assert.equal(row.title, idea.topic);
  assert.equal(row.status, "pending", "it lands as ordinary planned work, not as something special");
  assert.match(row.description, /6× further/, "the reason is on the task");
  assert.match(row.content_hook, /December/);
  assert.equal(row.content_category, "Instagram Reel", "the format becomes the category");

  await db.execute("DELETE FROM deliverables WHERE id = ?", [taskId]);
  ok("an idea becomes a real task carrying the reason it was chosen");
}

await clean();
/* ---------------- a 60-second ask is 60 seconds of script ---------------- */
{
  const kinds = await load("lib/content-kinds.ts");

  // The complaint this exists to answer: ask for 60 seconds, get 30.
  for (const secs of [15, 30, 40, 60, 90, 180]) {
    const plan = kinds.scriptPlan(secs);
    assert.equal(plan[0].from, 0, `${secs}s starts at zero`);
    assert.equal(plan[plan.length - 1].to, secs, `${secs}s ends exactly at ${secs}`);

    // No gaps and no overlaps — the sections are a timeline, not five boxes.
    for (let i = 1; i < plan.length; i++) {
      assert.equal(plan[i].from, plan[i - 1].to, `${secs}s: section ${i} starts where the last ended`);
    }

    // The hook never falls below three seconds. Under that there is no hook,
    // there is a first word.
    assert.ok(plan[0].to - plan[0].from >= 3, `${secs}s hook is at least 3 seconds`);

    // The body is the longest part, because it is what a viewer stays for.
    const body = plan.find((p) => p.key === "body");
    assert.ok(
      plan.every((p) => p.key === "body" || p.to - p.from <= body.to - body.from),
      `${secs}s: the body is the longest section`
    );

    // And the words asked for actually fill the time.
    const words = plan.reduce((t, p) => t + p.targetWords, 0);
    assert.ok(
      words >= secs * kinds.WORDS_PER_SECOND * 0.9,
      `${secs}s asks for ${words} words, enough to fill it`
    );
  }

  // Twice the seconds is roughly twice the words — the bug was that a 60s ask
  // produced a 30s script, so the two lengths must not come out the same.
  const w = (n) => kinds.scriptPlan(n).reduce((t, p) => t + p.targetWords, 0);
  assert.ok(w(60) > w(30) * 1.8, `60s asks for far more than 30s (${w(60)} vs ${w(30)})`);
  ok("the clock adds up: no gaps, a real hook, and twice the seconds is twice the words");
}

/* ---------------- three sections, and a CTA that asks for something ---------------- */
{
  const kinds = await load("lib/content-kinds.ts");

  // An intro and a worked example were two more places for a short reel to
  // lose its viewer — on a 30-second cut the intro is the hook again and the
  // example is the body again.
  for (const secs of [15, 30, 60, 90]) {
    const plan = kinds.scriptPlan(secs);
    assert.deepEqual(
      plan.map((p) => p.key),
      ["hook", "body", "cta"],
      `${secs}s has three sections, in order`
    );

    const body = plan.find((p) => p.key === "body");
    const cta = plan.find((p) => p.key === "cta");
    const hook = plan.find((p) => p.key === "hook");

    // The body is still the longest — it is the only part somebody stays for.
    assert.ok(
      body.to - body.from > cta.to - cta.from && body.to - body.from > hook.to - hook.from,
      `${secs}s: the body is the longest section`
    );

    // The CTA now does real work, so it gets real time. Taking a percentage in
    // order and giving the remainder to the last section left it on one second
    // at fifteen — too short to ask for a save, let alone a comment.
    assert.ok(cta.to - cta.from >= 4, `${secs}s: the CTA has at least 4 seconds (got ${cta.to - cta.from})`);
    assert.ok(hook.to - hook.from >= 3, `${secs}s: the hook still has at least 3`);
    assert.equal(plan[plan.length - 1].to, secs, `${secs}s still ends exactly at ${secs}`);
  }

  // The vocabulary a CTA draws from. A script asks for ONE of these.
  assert.deepEqual(kinds.ENGAGEMENT_ASKS, ["save", "share", "comment", "follow"]);

  const src = read("lib/content-ai.ts");
  assert.match(src, /exactly three parts: HOOK, BODY, CALL TO ACTION/i, "the model is told the shape");
  assert.match(src, /No introduction and no separate examples section/i);
  assert.match(src, /an example belongs inside the body/i, "the example did not vanish, it moved");

  // One ask, not four. "Like, share, save, comment and follow" is the ending
  // every account runs, and it is why none of them get any of it.
  assert.match(src, /one ask, and only one/i);
  assert.match(src, /and nothing else/i);
  assert.match(src, /Why this one: \$\{kind\.askWhy\}/, "the reason comes from the format, not the model");
  assert.match(src, /An ask without a reason is skipped/i);
  assert.doesNotMatch(src, /Ask for two or three/i, "the four-ask ending is gone");
  ok("three sections, and one ask the format has earned");
}

/* ---------------- the format decides the shape, the clock and the ask ---------------- */
{
  const kinds = await load("lib/content-kinds.ts");
  const types = kinds.CONTENT_TYPES;

  // The nine the agency actually makes: the work, then the borrowed formats.
  assert.deepEqual(
    types.map((t) => t.key),
    ["education", "ad", "lead_magnet", "graphic", "rating", "clone", "funny", "rapid_fire", "myths"]
  );
  assert.equal(new Set(types.map((t) => t.key)).size, types.length, "keys are distinct");
  assert.equal(kinds.contentType("education").key, "education");
  // An unknown key must never throw — it arrives from a form post.
  assert.equal(kinds.contentType("nonsense").key, "education", "unknown falls back to the default");
  assert.equal(kinds.contentType(undefined).key, "education");
  assert.equal(kinds.contentType(null).key, "education");

  for (const t of types) {
    assert.ok(t.label && t.what && t.shape && t.askWhy, `${t.key} is described`);
    // Every format ends by asking for exactly one thing, and it is either one
    // of the four or the client's own action. "All of them" is not an option.
    assert.ok(
      [...kinds.ENGAGEMENT_ASKS, "direct"].includes(t.ask),
      `${t.key} asks for one nameable thing (got ${t.ask})`
    );
  }

  // The ad is the one that must not ask for engagement: a paid second spent on
  // a save is a second not spent on the enquiry being paid for.
  assert.equal(types.find((t) => t.key === "ad").ask, "direct");
  // And a joke is not a lesson — nobody saves a punchline, they send it on.
  assert.equal(types.find((t) => t.key === "funny").ask, "share");
  assert.equal(types.find((t) => t.key === "education").ask, "save");
  assert.equal(types.find((t) => t.key === "lead_magnet").ask, "comment");

  // Not every format ends the same, or the picker changes nothing that matters.
  assert.ok(new Set(types.map((t) => t.ask)).size >= 4, "the asks genuinely differ by format");
  assert.ok(new Set(types.map((t) => t.ctaShare)).size >= 3, "and so does the time the ending gets");

  // Whatever the format, the clock still has to add up.
  for (const t of types) {
    for (const secs of [15, 30, 60, 90, 180]) {
      const plan = kinds.scriptPlan(secs, t.key);
      const [hook, body, cta] = plan;
      assert.deepEqual(plan.map((p) => p.key), ["hook", "body", "cta"], `${t.key} @${secs}s`);
      assert.equal(hook.from, 0, `${t.key} @${secs}s starts at zero`);
      assert.equal(cta.to, secs, `${t.key} @${secs}s ends exactly at ${secs}`);
      assert.equal(body.from, hook.to, `${t.key} @${secs}s: no gap after the hook`);
      assert.equal(cta.from, body.to, `${t.key} @${secs}s: no gap before the ending`);
      assert.ok(hook.to - hook.from >= 3, `${t.key} @${secs}s: the hook keeps its 3 seconds`);
      assert.ok(cta.to - cta.from >= 4, `${t.key} @${secs}s: the ending keeps its 4`);
      assert.ok(
        body.to - body.from > cta.to - cta.from,
        `${t.key} @${secs}s: the body is still the longest part`
      );
    }
  }

  // The ad closes and needs room to; the joke ends on the punchline.
  const secondsOf = (key, secs) => {
    const cta = kinds.scriptPlan(secs, key).find((p) => p.key === "cta");
    return cta.to - cta.from;
  };
  assert.ok(secondsOf("ad", 60) > secondsOf("funny", 60), "an ad's ending gets more of the clock than a joke's");

  // On-screen text is read, not spoken, and slower. Holding a graphic reel to a
  // talking script's word count fills the cards with sentences nobody can read.
  assert.ok(
    kinds.wordFloor(60, "graphic") < kinds.wordFloor(60, "education"),
    "a graphic reel is not held to a spoken word count"
  );
  assert.equal(kinds.wordFloor(60), kinds.wordFloor(60, "education"), "the default is the education reel");

  const src = read("lib/content-ai.ts");
  assert.match(src, /THIS ONE IS A \$\{kind\.label\.toUpperCase\(\)\}/, "the model is told which format it is writing");
  assert.match(src, /Build the body like this: \$\{kind\.shape\}/, "and how that format is built");
  assert.match(src, /This is an ad\./i, "an ad is told not to ask for engagement");
  ok("nine formats, each with its own shape, its own clock and one ask");
}

/* ---------------- the floor is checked, not merely requested ---------------- */
{
  const kinds = await load("lib/content-kinds.ts");
  assert.equal(kinds.countWords("one two three"), 3);
  assert.equal(kinds.countWords("  spaced   out \n lines "), 3, "whitespace of any kind");
  assert.equal(kinds.countWords(""), 0);
  assert.equal(kinds.countWords(null), 0);

  // 60 seconds at 2.5 words a second is 150; the floor allows a little under.
  assert.equal(kinds.wordFloor(60), 128);
  assert.ok(kinds.wordFloor(60) > kinds.wordFloor(30), "and scales with the ask");

  const src = read("lib/content-ai.ts");
  // The old prompt asked for a length and never looked. This is the fix.
  assert.match(src, /LENGTH IS A REQUIREMENT, NOT A GUIDE/);
  assert.match(src, /if \(script\.short\)/, "a short draft is measured and asked again");
  assert.match(src, /Your previous draft was \$\{script\.totalWords\} words/, "naming the shortfall");
  // And a retry that comes back worse must not replace the first draft.
  assert.match(src, /if \(grown\.totalWords > script\.totalWords\) script = grown;/);
  ok("a short script is detected and rewritten, not shipped short");
}

/* ---------------- a poster headline is read from across a room ---------------- */
{
  const src = read("lib/content-ai.ts");
  const ai = await load("lib/content-ai.ts");

  /*
   * What the copy used to come back as: "Save big on your next loan with our
   * exclusive festive offer" — nine words, three of them adjectives, and not
   * one fact. Three rules replaced it, and all three are checkable.
   */

  // 1. Short, and counted rather than requested. Eight words was a sentence
  //    pretending to be a headline.
  assert.equal(ai.POSTER_HEADLINE_WORDS, 6, "six words, not eight");
  assert.match(src, /THE LIMITS, and they are limits rather than guidance/);
  assert.match(src, /if \(out\.long\)/, "a long headline is measured and asked again");
  assert.match(
    src,
    /if \(shorter\.headline && shorter\.headlineWords < out\.headlineWords\) out = shorter;/,
    "and a retry that comes back longer does not replace the first"
  );

  // 2. One concrete thing, in the headline. An adjective standing where a fact
  //    should be is the poster saying it has nothing to say.
  assert.match(src, /EVERY POSTER CARRIES ONE CONCRETE THING/);
  assert.match(src, /never invent a number/i, "and it may not make one up to satisfy the rule");

  // 3. The words that mean nothing, refused by name.
  for (const word of ["exclusive", "amazing", "save big", "unlock", "don't miss"]) {
    assert.ok(
      src.includes(`"${word}"`),
      `"${word}" is not on the banned list, and it was in a real draft`
    );
  }
  assert.match(src, /No exclamation marks/);

  // Three headlines, deliberately different, because the first line a model
  // writes is the obvious one and the obvious one is on everybody's poster.
  assert.match(src, /Give three headlines, not one/);
  assert.match(src, /alt_headlines/);

  // And in the language the poster will actually be read in — a shop window
  // here is Telugu far more often than English.
  assert.match(src, /LANGUAGE_RULE\[language\] \?\? LANGUAGE_RULE\.English/);
  const panel = read("app/(app)/clients/[id]/studio/posters.tsx");
  assert.match(panel, /SCRIPT_LANGUAGES\.map/, "and the panel lets somebody choose it");
  assert.match(panel, /countWords\(h\)/, "the count follows a headline that gets swapped");
  ok("a poster headline: six words, one fact, no filler, three to choose from");
}

await finish(pass);
