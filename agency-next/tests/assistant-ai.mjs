/**
 * What the WhatsApp assistant knows, and how it survives the model failing.
 *
 * The reply itself is a model's words and cannot be asserted on. Everything
 * that decides whether those words are *right* can be: which facts it is
 * given, in whose clock, what it is told never to say, and what happens on
 * each of the three ways the call fails.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const db = await load("lib/db.ts");
const ai = await load("lib/whatsapp-ai.ts");
const posting = await load("lib/posting.ts");
const src = readFileSync(`${SRC}/lib/whatsapp-ai.ts`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const TAG = "ZZ ai client";
const OTHER = "ZZ ai other";
const MONTH = new Date().toISOString().slice(0, 7);
const clean = async () => {
  await db.execute("DELETE FROM whatsapp_messages WHERE group_id LIKE 'zz-ai-%'");
  await db.execute("DELETE FROM invoices WHERE invoice_no LIKE 'ZZ-AI-%'");
  await db.execute(
    "DELETE FROM deliverables WHERE client_id IN (SELECT id FROM clients WHERE company_name IN (?,?))",
    [TAG, OTHER]
  );
  await db.execute("DELETE FROM clients WHERE company_name IN (?,?)", [TAG, OTHER]);
};
await clean();

const mine = Number(
  (await db.execute(
    `INSERT INTO clients (company_name, status, contact_person, monthly_deliverables, monthly_posters)
     VALUES (?, 'active', 'Ravi', 8, 4)`,
    [TAG]
  )).insertId
);
const theirs = Number(
  (await db.execute("INSERT INTO clients (company_name, status) VALUES (?, 'active')", [OTHER])).insertId
);

// A 5pm IST slot, as the app stores it: 11:30 UTC.
const mk = async (clientId, title, status, extra = "") =>
  db.execute(
    `INSERT INTO deliverables (client_id, title, status, month_key, instagram_status ${extra ? "," + Object.keys(JSON.parse(extra)).join(",") : ""})
     VALUES (?, ?, ?, ?, 'none' ${extra ? "," + Object.values(JSON.parse(extra)).map((v) => (v === null ? "NULL" : `'${v}'`)).join(",") : ""})`,
    [clientId, title, status, MONTH]
  );

await mk(mine, "Diwali reel", "review", JSON.stringify({ scheduled_at: "2026-08-14 11:30:00", due_date: "2026-08-14" }));
await mk(mine, "Founder story", "waiting_for_raw", JSON.stringify({ due_date: "2026-08-20" }));
await mk(mine, "Testimonial", "posted", JSON.stringify({ posted_at: "2026-08-08 11:32:00" }));
await mk(theirs, "Someone else's reel", "review");

await db.execute(
  `INSERT INTO invoices (invoice_no, client_id, amount, total, status, issue_date, period_month, created_by)
   VALUES ('ZZ-AI-1', ?, 25000, 25000, 'sent', CURDATE(), ?, 1)`,
  [mine, MONTH]
);

/* ---------------- the facts are one client's, and complete ---------------- */
{
  const f = await ai.clientFacts(mine);
  assert.equal(f.companyName, TAG);
  const titles = f.items.map((i) => i.title);
  assert.ok(!titles.includes("Someone else's reel"), "another client's work is never in the prompt");
  assert.equal(f.plan.videosPerMonth, 8, "the package answers 'how many do I get'");
  assert.equal(f.plan.postersPerMonth, 4);
  assert.equal(f.plan.plannedThisMonth, 3);
  assert.deepEqual(f.awaitingFootage, ["Founder story"], "what we are waiting on from them");
  assert.equal(f.invoices.length, 1, "their own unpaid invoice");
  assert.equal(f.invoices[0].number, "ZZ-AI-1");
  assert.equal(f.invoices[0].amount, 25000);
  ok("the snapshot covers plan, footage and money — all of it this client's own");

  const other = await ai.clientFacts(theirs);
  assert.equal(other.invoices.length, 0, "and one client's invoice never appears in another's");
  assert.equal(other.items.length, 1);
  ok("nothing crosses from one client to another");
}

/* ---------------- in the client's clock, not the database's ---------------- */
{
  // The bug this exists to stop: 5pm IST is stored 11:30 UTC, and a client
  // told "11:30" would turn up for the wrong thing.
  assert.equal(posting.prettyLocal("2026-08-14 11:30:00"), "14 Aug 2026, 5:00 pm");
  assert.equal(posting.prettyLocal(null), null);

  assert.match(src, /goes out \$\{at\(i\.scheduledAt\)\}/, "the schedule is converted");
  assert.match(src, /posted \$\{at\(i\.postedAt\)\}/, "and so is the posting time");
  assert.match(src, /const at = \(v: string \| null\) => prettyLocal\(v\)/);
  ok("times reach the client in their own clock, not the UTC they are stored in");
}

/* ---------------- it can follow a conversation ---------------- */
{
  const g = "zz-ai-group@g.us";
  const say = (who, dir, text, minute) =>
    db.execute(
      `INSERT INTO whatsapp_messages (group_id, client_id, sender_name, direction, message, message_time)
       VALUES (?,?,?,?,?, ?)`,
      [g, mine, who, dir, text, `2026-08-11 10:0${minute}:00`]
    );
  await say("Ravi", "in", "when is the diwali reel going out?", 1);
  await say("Assistant", "out", "It goes out on 14 Aug at 5:00 pm.", 2);
  await say("Ravi", "in", "and the other one?", 3);

  const turns = await ai.recentTurns(g);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].text, "when is the diwali reel going out?", "oldest first");
  assert.equal(turns[1].who, "Us", "our own replies are labelled as ours");
  assert.equal(turns[2].who, "Ravi");
  ok("the assistant sees the conversation, so a follow-up is answerable");

  const empty = await ai.recentTurns("zz-ai-nobody@g.us");
  assert.deepEqual(empty, [], "a group with no history is not an error");
  ok("a brand-new group starts from nothing without failing");
}

/* ---------------- told to think, and what never to say ---------------- */
{
  assert.match(src, /THINK IT THROUGH BEFORE YOU WRITE/);
  assert.match(src, /Read the CONVERSATION/, "and to use the conversation when resolving 'the other one'");
  assert.match(src, /Never invent or estimate any figure that is not there/,
    "money it does not have is never guessed");
  assert.match(src, /no quote for new work/);
  assert.match(src, /may be stated exactly/, "but their own invoice is theirs to be told");
  assert.match(src, /including when it is off-topic, repeated, unclear/, "every question gets a courteous answer");
  ok("the prompt demands reasoning, and forbids inventing anything it was not given");
}

/* ---------------- the two ways it fails, and two answers ---------------- */
{
  /*
   * The token cap covers the thinking as well as the reply.
   *
   * Reasoning tokens are spent out of the same budget, so a cap sized for the
   * answer alone spends the lot working it out and returns half a sentence —
   * which is exactly what a client once received: "…(if you were asking about
   * V103" and nothing more. The provider changed; the trap did not.
   */
  assert.ok(src.includes("maxTokens: 3000"), "room for the thinking as well as the answer");
  assert.ok(src.includes('attempt(env.gemini.model, "medium")'), "and it is told to think before it writes");

  /*
   * Trying again only when trying again could work.
   *
   * A refused key or a malformed request fails identically on the smaller
   * model, and spending a second call to prove it makes the client wait twice
   * as long for the same holding line.
   */
  assert.match(src, /if \(!first\.retriable\) return null;/,
    "a permanent failure is not retried on a second model");
  assert.match(src, /const second = await attempt\(env.gemini.fastModel, "low"\)/,
    "and a retriable one falls to the fast model rather than giving up");
  assert.match(src, /console\.warn\(`\[whatsapp-ai\] \$\{env.gemini.model\}/,
    "a refusal is logged rather than silently becoming a holding line");
  ok("a bad minute and a bad key get different answers");

  // With no key at all there is no call to make, and no crash either.
  const facts = await ai.clientFacts(mine);
  const reply = await ai.composeReply(facts, "hi", "Ravi", []);
  assert.ok(reply === null || typeof reply === "string", "composeReply always resolves");
  ok("and with the model switched off entirely it returns cleanly for the holding line");
}

await clean();
await finish(pass);
