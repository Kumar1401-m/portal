/**
 * Competitors, comments and the business advisor.
 *
 * These three reach outside the portal, which is where a system like this
 * starts inventing things. So what is tested is mostly what they refuse to do:
 * claim a trending feed nobody has, file a complaint as praise because a batch
 * came back in a different order, quote a profit margin from a portal that
 * records no hours, or post a reply to a client's account.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const comp = await load("lib/competitors.ts");
const kinds = await load("lib/comment-kinds.ts");
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- posting frequency is real arithmetic ---------------- */
{
  const day = (n) => new Date(Date.UTC(2026, 7, n)).toISOString();
  // Eight posts across fourteen days is four a week.
  const posts = [1, 3, 5, 7, 9, 11, 13, 15].map((d) => ({
    caption: "x", likes: 10, comments: 1, type: "REELS", timestamp: day(d),
  }));
  assert.equal(comp.postsPerWeek(posts), 4, "eight posts over a fortnight is four a week");

  // Too few to say anything, and a set with no usable timestamps.
  assert.equal(comp.postsPerWeek(posts.slice(0, 2)), null, "two posts is not a frequency");
  assert.equal(comp.postsPerWeek([{ timestamp: null }, { timestamp: null }, { timestamp: null }]), null);
  ok("posting frequency is computed from timestamps, or not claimed at all");
}

/* ---------------- a rival's rate is not the client's rate ---------------- */
{
  const c = {
    id: 1, clientId: 1, handle: "rival", label: null,
    followers: 10000, mediaCount: 200,
    posts: [
      { caption: "a", likes: 400, comments: 100, type: "REELS", timestamp: "2026-08-01T00:00:00Z" },
      { caption: "b", likes: 600, comments: 100, type: "REELS", timestamp: "2026-08-05T00:00:00Z" },
      { caption: "c", likes: 500, comments: 100, type: "REELS", timestamp: "2026-08-09T00:00:00Z" },
    ],
    checkedAt: "2026-08-18 10:00:00", lastError: null,
  };
  const cmp = comp.compareOne(c);
  assert.equal(cmp.avgEngagement, 600, "average likes plus comments per post");
  // Against followers, because a rival's reach is not public — a different
  // measure from the client's own, and the UI has to say so.
  assert.equal(cmp.ratePerFollower, 6);
  assert.match(read("app/(app)/clients/[id]/studio/outside.tsx"), /not directly comparable/i,
    "and the page warns that the two rates are not the same measure");

  // A rival that could not be read carries its error rather than reading as
  // a competitor who posts nothing.
  const broken = comp.compareOne({ ...c, posts: [], followers: null, lastError: "personal account" });
  assert.equal(broken.error, "personal account");
  assert.equal(broken.avgEngagement, null, "and shows no invented zero");
  ok("a rival's numbers are labelled for what they are, and a failure says so");
}

/* ---------------- no trending feed is invented ---------------- */
{
  const src = read("lib/competitors.ts");
  // The comment wraps across lines with a leading " * ", so the assertion has
  // to tolerate that rather than assume the sentence is on one line.
  assert.match(src, /no access to a\s+\*?\s*trending-topics feed/i, "the module says plainly there is none");
  // "Trends" here means a real content gap against real rivals.
  assert.match(src, /export async function findGaps/);
  assert.match(src, /Never suggest 'post more'/i, "and a gap is a piece of content, not advice to try harder");

  const engines = read("lib/ai-engines.ts");
  assert.match(engines, /no trending feed exists to read/i, "the engine list is honest about it too");

  // Business discovery, not scraping. The distinction matters legally and it
  // decides which accounts can be read at all.
  assert.match(src, /business_discovery\.username/);
  assert.match(src, /public Business and Creator accounts/i, "and the limitation is explained to the user");
  ok("trends are competitor gaps, and no trending feed is pretended into existence");
}

/* ---------------- comments are matched by id, never by position ---------------- */
{
  const src = read("lib/sentiment.ts");
  // The failure this prevents: a batch of forty comments comes back in a
  // different order and somebody's complaint is filed as praise.
  assert.match(src, /const known = new Set\(rows\.map/);
  assert.match(src, /if \(!known\.has\(id\) \|\| !isKind\(kind\)\) continue;/,
    "an id we did not send, or a kind that is not a kind, is dropped");
  assert.match(src, /never by position/i);

  // The six kinds, with the two that need a person kept out of the sentiment
  // bar chart they would otherwise vanish into.
  assert.deepEqual(kinds.NEEDS_A_PERSON, ["lead", "complaint", "question"]);
  assert.equal(kinds.isKind("lead"), true);
  assert.equal(kinds.isKind("angry"), false, "an invented kind never reaches the column");
  assert.equal(kinds.KIND_LABEL.lead, "Wants to buy", "and it is named for what it is worth");
  ok("a misaligned batch cannot file one person's comment as another's");
}

/* ---------------- it drafts replies; it never sends them ---------------- */
{
  const src = read("lib/sentiment.ts");
  assert.match(src, /nothing is ever posted to a client's account/i);
  // Nothing anywhere writes a comment back to Meta.
  assert.ok(!/\/comments['"`]?,\s*\{[\s\S]{0,200}method:\s*['"]POST/i.test(src), "no POST to the comments endpoint");
  assert.ok(!/method: "POST"/.test(src), "this module only ever reads from Meta");

  const ui = read("app/(app)/clients/[id]/studio/outside.tsx");
  assert.match(ui, /Replies are drafts to copy/i, "and the page says so where the drafts are");
  ok("suggested replies are drafts a person copies, never something the portal sends");
}

/* ---------------- the advisor refuses to invent a margin ---------------- */
{
  const src = read("lib/business-advisor.ts");
  // The portal records no hours. A profit margin built on an invented rate
  // would be the most dangerous number in the system — it looks like
  // accounting.
  assert.match(src, /records no hours/i);
  assert.match(src, /never state a profit margin/i, "the prompt forbids it");
  assert.match(src, /fee per delivered task/i, "and names the proxy it uses instead");

  const ui = read("app/(app)/ai/advisor.tsx");
  assert.match(ui, /a proxy\s*\n?\s*for effort, not a profit margin/i, "the caveat travels with the number");

  // Dividing a fee by zero delivered tasks would rank a client who got nothing
  // as infinitely profitable.
  assert.match(src, /delivered > 0 && fee > 0 \? Math\.round\(fee \/ delivered\) : null/);

  // The book is admins only, wherever it is reached from.
  const actions = read("app/(app)/ai/actions.ts");
  assert.match(actions, /adviseAction[\s\S]{0,200}requireUser\(ADMIN_ROLES\)/,
    "a crm cannot open the agency's book");
  ok("the advisor uses a labelled proxy and never claims a margin it cannot know");
}

await finish(pass);
