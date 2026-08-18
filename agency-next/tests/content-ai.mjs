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

  for (const fn of ["contentStrategy", "contentIdeas", "generateScript", "thumbnailConcepts", "seoPack"]) {
    assert.match(src, new RegExp(`export async function ${fn}`), `${fn} exists`);
  }
  // Every one of them goes through `generate`, which is what attaches the brief.
  assert.equal(
    (src.match(/await generate\(/g) || []).length,
    6,
    "all five tools plus the section rewrite go through the one gate"
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

  // The one exception, and it is assembly rather than invention: a model that
  // fills the sections but forgets the whole gets the whole built from them.
  assert.match(src, /if \(!script\.full\)/, "a missing `full` is assembled from the sections it returned");
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
await finish(pass);
