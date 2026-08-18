/**
 * The client knowledge base.
 *
 * One distinction carries this whole feature: a *fact* is offered to the model
 * to use or ignore, and a *rule* is not negotiable. "Never say cure" listed
 * among the business details is a detail about the client; under a heading
 * that says it is not optional, it is an instruction. Getting that wrong is
 * how a regulated client ends up with the one word they told you never to
 * write — and nothing would throw.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const k = await load("lib/knowledge.ts");
const db = await load("lib/db.ts");
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const knowledge = (o = {}) => ({
  ...k.emptyKnowledge(1),
  ...o,
});

/* ---------------- lines out of a textarea ---------------- */
{
  assert.deepEqual(k.lines("cure\nguaranteed\n\n  cheap  "), ["cure", "guaranteed", "cheap"]);
  // People paste bullets. Keeping the dash would ban the string "- cure".
  assert.deepEqual(k.lines("- cure\n• guaranteed\n* cheap"), ["cure", "guaranteed", "cheap"]);
  assert.deepEqual(k.lines(""), []);
  assert.deepEqual(k.lines(null), [], "and an unset column is not one empty rule");
  ok("a textarea becomes a list, bullets and blank lines and all");
}

/* ---------------- facts are offered; rules are not ---------------- */
{
  const full = knowledge({
    audience: "Families in Vijayawada",
    tone: "Warm, plain Telugu",
    brandColors: "#0B6E4F",
    approvedTerms: ["clients"],
    bannedTerms: ["cure", "guaranteed"],
    restrictions: ["Never promise a treatment outcome"],
    ctas: ["WhatsApp us on 98765 43210"],
    notes: "The doctor is Dr Priya",
  });

  const facts = k.renderKnowledge(full);
  const rules = k.renderRules(full);

  // The audience and the tone are background. They belong in the briefing.
  assert.match(facts, /Families in Vijayawada/);
  assert.match(facts, /Warm, plain Telugu/);
  assert.match(facts, /#0B6E4F/);
  assert.match(facts, /clients/);

  // The banned words must NOT appear in the facts block — a model reading
  // "cure" in a list of business details may well use it.
  assert.ok(!/cure|guaranteed/.test(facts), "banned words never appear as briefing material");
  assert.ok(!/Never promise/.test(facts), "and neither do the restrictions");

  // They appear in the rules block, under a heading that says so.
  assert.match(rules, /NOT OPTIONAL/, "the rules announce themselves as rules");
  assert.match(rules, /cure/);
  assert.match(rules, /guaranteed/);
  assert.match(rules, /Never promise a treatment outcome/);
  assert.match(rules, /not as a variation, not in a hashtag/i, "and close the obvious loopholes");
  ok("facts go to the briefing, rules go to the instructions, and never the reverse");
}

/* ---------------- nothing written down produces nothing ---------------- */
{
  const empty = k.emptyKnowledge(7);
  assert.equal(k.renderKnowledge(empty), null, "no facts, no block");
  assert.equal(k.renderRules(empty), null, "no rules, no block");
  assert.equal(k.isEmpty(empty), true);
  assert.equal(k.completeness(empty), 0);

  // An empty heading would invite the model to fill the blank in — which is
  // exactly the generic caption this feature exists to stop.
  assert.equal(k.renderRules(knowledge({ audience: "anyone" })), null, "an audience is not a rule");
  assert.equal(
    k.renderKnowledge(knowledge({ bannedTerms: ["cure"] })),
    null,
    "and a banned word alone is not briefing material"
  );

  assert.equal(k.completeness(knowledge({ audience: "x", tone: "y" })), 29);
  assert.equal(k.isEmpty(knowledge({ ctas: ["Call us"] })), false);
  ok("an empty knowledge base hands the model nothing at all");
}

/* ---------------- the CTA rule closes the invention loophole ---------------- */
{
  const rules = k.renderRules(knowledge({ ctas: ["WhatsApp us", "Book a slot"] }));
  assert.match(rules, /must be one of the client's own/i);
  assert.match(rules, /WhatsApp us \/ Book a slot/);
  assert.match(rules, /Do not invent a new one/i);
  ok("a client's own calls to action are a requirement, not a menu of ideas");
}

/* ---------------- and every AI path actually reads it ---------------- */
{
  // The whole value is that one edit reaches every generator. If a path stops
  // reading it, that path silently goes back to guessing the brand.
  const ctx = read("lib/client-context.ts");
  assert.match(ctx, /ctx\.knowledge = await getKnowledge/, "the shared context loads it");
  assert.match(ctx, /renderKnowledge\(ctx\.knowledge\)/, "facts fold into the briefing block");
  assert.match(ctx, /export function renderKnowledgeRules/, "and rules get their own block");

  const video = read("lib/video-ai.ts");
  assert.match(video, /knowledgeRules: ctx \? renderKnowledgeRules\(ctx\) : null/, "video captions read it");
  assert.match(video, /brief\.knowledgeRules/, "and it reaches the prompt");

  const captions = read("app/(app)/deliverables/actions.ts");
  assert.match(captions, /getKnowledge\(d\.client_id\)/, "the caption studio reads it");
  assert.match(captions, /rules: renderRules\(knowledge\)/, "and passes the rules through");

  const ai = read("lib/ai.ts");
  // Into the system prompt, not the brief — that is the fact/rule split again,
  // in the one place a mistake would be hardest to notice.
  assert.match(ai, /const system = rules \? `\$\{CAPTION_V3_SYSTEM\}/, "rules join the system prompt");
  ok("the caption studio, the video analyser and the shared context all read it");
}

/* ---------------- it round-trips through the database ---------------- */
{
  if (!(await k.knowledgeReady())) {
    console.log("  -- client_knowledge not in this database, skipping the round trip");
  } else {
    const clean = async () => {
      await db.execute("DELETE FROM clients WHERE company_name = 'ZZ knowledge'");
    };
    await clean();
    const id = Number(
      (await db.execute("INSERT INTO clients (company_name,status) VALUES ('ZZ knowledge','active')"))
        .insertId
    );

    await k.saveKnowledge(id, {
      audience: "Families in Vijayawada",
      tone: "Warm",
      bannedTerms: "cure\nguaranteed",
      ctas: "WhatsApp us",
    });
    let got = await k.getKnowledge(id);
    assert.equal(got.audience, "Families in Vijayawada");
    assert.deepEqual(got.bannedTerms, ["cure", "guaranteed"], "lines survive the round trip");

    // Saving again replaces rather than duplicating — one row per client.
    await k.saveKnowledge(id, { audience: "Only adults", bannedTerms: "cheap" });
    got = await k.getKnowledge(id);
    assert.equal(got.audience, "Only adults");
    assert.deepEqual(got.bannedTerms, ["cheap"]);
    assert.equal(got.tone, null, "a field cleared on save is cleared, not remembered");

    // A client with no row at all is empty, never an error.
    const none = await k.getKnowledge(999999);
    assert.equal(k.isEmpty(none), true);

    await clean();
    ok("one row per client, saved and read back as the text it was typed as");
  }
}

await finish(pass);
