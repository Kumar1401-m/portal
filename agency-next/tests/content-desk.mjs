/**
 * The content desk — its own board, and the message a client actually reads.
 *
 * Two things this has to get right, because both are irreversible once a
 * client has seen them: a brief must never go out cut short, and a batch must
 * never be marked "sent" when WhatsApp did not take it.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const content = await load("lib/content.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const piece = (title, body, dueDate = "2026-08-20") => ({ title, dueDate, body });

/* ---------------- one brief reads as itself ---------------- */
{
  const msgs = content.buildContentMessages("Acme", "Ravi", [piece("Launch reel", "Buy our thing.")]);
  assert.equal(msgs.length, 2, "the copy, then the ask — never bundled");
  assert.match(msgs[0], /Hello Ravi,/, "addressed to the person, not the company");
  assert.match(msgs[0], /Buy our thing\./);
  assert.ok(!/\*1\. /.test(msgs[0]), "a single piece is not numbered — there is nothing to number");
  assert.match(msgs[1], /\*OK\*/, "the ask says how to answer");
  assert.ok(!/with the number/.test(msgs[1]), "and does not ask for a number that was never given");

  // No contact name on file: the company is a better greeting than "Hello ,".
  const noName = content.buildContentMessages("Acme", null, [piece("A", "b")]);
  assert.match(noName[0], /Hello Acme,/);
  assert.match(noName[0], /Hello Acme,/);
  ok("a single brief is sent as itself, addressed to whoever reads it");
}

/* ---------------- a month is numbered, so a reply can point at one ---------------- */
{
  const pieces = [piece("One", "aaa"), piece("Two", "bbb"), piece("Three", "ccc")];
  const msgs = content.buildContentMessages("Acme", "Ravi", pieces);
  assert.match(msgs[0], /3 pieces in all/, "the client is told how much they are being asked to read");
  for (const [i, p] of pieces.entries()) {
    assert.ok(msgs.join("\n").includes(`*${i + 1}. ${p.title}*`), `${p.title} is numbered`);
  }
  assert.match(msgs.at(-1), /with the number/, "and asked to say which one");
  ok("a batch is numbered, and the ask asks for the number");
}

/* ---------------- and no brief is ever cut ---------------- */
{
  // Thirty long briefs is far past what one WhatsApp message takes. They must
  // all still arrive, whole: a client approving copy they were not shown is
  // the one outcome this flow cannot have.
  const long = Array.from({ length: 30 }, (_, i) => piece(`Piece ${i + 1}`, "x".repeat(400)));
  const msgs = content.buildContentMessages("Acme", "Ravi", long);
  assert.ok(msgs.length > 2, "so it is split across messages");
  for (const m of msgs) {
    assert.ok(m.length <= 4096, `every message fits WhatsApp's limit — got ${m.length}`);
  }
  const joined = msgs.join("\n");
  for (const p of long) {
    assert.ok(joined.includes(p.body), `${p.title} arrived whole`);
  }
  assert.ok(!/…|\.\.\./.test(joined), "nothing was elided");

  // A single brief longer than the packing limit still goes, in one piece.
  const huge = content.buildContentMessages("Acme", null, [piece("Epic", "y".repeat(3800))]);
  assert.ok(huge.join("\n").includes("y".repeat(3800)), "even one longer than the pack size");
  ok("thirty briefs arrive whole, split across messages, none truncated");
}

/* ---------------- sending is what moves the status, not the button ---------------- */
{
  const src = readFileSync(`${SRC}/lib/content.ts`, "utf8");

  // The other order leaves a client's whole month sitting in "waiting for
  // their approval" when WhatsApp was simply down — and nobody chases an
  // approval they believe was already requested.
  const sendAt = src.indexOf("sendTextToGroup(group.group_id");
  const markAt = src.indexOf("SET status = 'content_review'");
  assert.ok(sendAt > 0 && markAt > sendAt, "the status moves after the message goes, never before");

  assert.match(
    src,
    /const written = rows\.filter\(\(r\) => \(r\.description \?\? ""\)\.trim\(\)\)/,
    "only briefs that have been written are sent"
  );
  assert.match(
    src,
    /const sentIds = written\.map/,
    "and only those are marked sent — an unwritten one is not quietly advanced"
  );
  assert.match(src, /status = 'pending'/, "a piece already with the client cannot be sent twice");
  assert.match(
    src,
    /\$\{i\} of \$\{messages\.length\} messages went through/,
    "a half-sent batch says so, because the recovery is different"
  );
  ok("nothing is marked sent that was not sent");
}

/* ---------------- the board is off Today's Tasks ---------------- */
{
  const today = readFileSync(`${SRC}/app/(app)/today/page.tsx`, "utf8");
  assert.match(
    today,
    /const all = board\.filter\(\(d\) => d\.status !== "pending"\)/,
    "unwritten briefs are not on the day board"
  );
  // But sent-to-the-client is: that is the one content state waiting on
  // somebody, which is what the board is for.
  assert.match(today, /d\.status === "content_review"/, "content with the client stays");
  assert.match(today, /href="\/content"/, "with the way to the desk");

  // The tabs count the rows the table shows. Counting the filtered-out briefs
  // would put 34 above a board holding 4.
  assert.ok(!/getServiceCounts\(/.test(today), "the tab counts are not the unfiltered ones");
  assert.match(today, /for \(const d of all\) counts\[serviceOf\(d\)\]\+\+/, "they are counted from `all`");

  const nav = readFileSync(`${SRC}/components/admin/nav-config.ts`, "utf8");
  assert.match(nav, /label: "Content", href: "\/content"/, "and it has its own nav entry");
  ok("writing content left the day board and got a screen of its own");
}

/* ---------------- and the super admin can answer for the client ---------------- */
{
  const actions = readFileSync(`${SRC}/app/(app)/content/actions.ts`, "utf8");

  // Clients answer in the group, in their own words. Nothing about "all good"
  // presses a button, so somebody records it — and that somebody is the super
  // admin, which is the same rule sending follows.
  assert.match(
    actions,
    /export async function recordContentDecisionAction/,
    "there is a way to record what the client said"
  );
  assert.match(
    actions,
    /user\.role !== "super_admin" && user\.role !== "crm"[\s\S]{0,160}approve content on the client's behalf/,
    "reserved to the super admin and the client's own crm"
  );
  // Through the same action the task page uses, so an approval recorded here
  // is not a second, subtly different kind of approval.
  assert.match(actions, /await changeStatusAction\(\{ ok: false \}, one\)/, "via the one status path");
  assert.match(
    actions,
    /decision === "changes_requested" && !reason/,
    "and a change cannot be recorded without saying what to change"
  );

  // Sending is the same act as the two approval gates and follows the same rule.
  assert.match(
    actions,
    /Only a super admin can send content to a client/,
    "sending is a super admin's too"
  );
  // Fifteen tasks, one designer, one alert.
  assert.match(actions, /const byPerson = new Map/, "a batch handed over notifies each person once");
  ok("the super admin records the client's answer, through the same gate as everywhere else");
}

/* ---------------- content is cut by property, not just by client ---------------- */
{
  // A client with six properties does not have one month of content — they
  // have six, and they read and answer about one at a time.
  const msgs = content.buildContentMessages("Acme", "Ravi", [
    piece("Walkthrough", "aaa"),
    piece("Price drop", "bbb"),
  ].map((p) => ({ ...p, property: "Green Meadows" })));
  assert.match(msgs[0], /Content for your approval — Green Meadows/, "the batch is named by it");
  assert.ok(
    !/· Green Meadows/.test(msgs.join(" ")),
    "and not repeated on every line, since the whole message is about it"
  );

  // A mixed batch names each piece instead, so an answer can point at one.
  const mixed = content.buildContentMessages("Acme", "Ravi", [
    { ...piece("Walkthrough", "aaa"), property: "Green Meadows" },
    { ...piece("Offer", "bbb"), property: "Lake View" },
  ]);
  assert.ok(!/approval — /.test(mixed[0]), "no single property to name in the heading");
  assert.match(mixed.join(" "), /· Green Meadows/);
  assert.match(mixed.join(" "), /· Lake View/);

  // Content belonging to no property is not forced into one.
  const plain = content.buildContentMessages("Acme", null, [piece("Festival post", "ccc")]);
  assert.ok(!/—/.test(plain[0].split(/\r?\n/)[0]), "an unnamed batch keeps the plain heading");
  ok("a batch is named by its property, and a mixed one names each piece");
}

/* ---------------- and the board splits the same way ---------------- */
{
  // Literal source checks rather than regexes: every line below contains
  // `?`, `$` or `{`, and an escaping slip in the pattern would quietly make
  // the assertion pass against nothing.
  const has = (src, needle, why) => assert.ok(src.includes(needle), why);

  const lib = readFileSync(`${SRC}/lib/content.ts`, "utf8");
  has(lib, 'const name = (r.campaign ?? "").trim()', "property is the campaign column");
  has(
    lib,
    "const key = `${r.client_id}::${name}`",
    "grouped within a client, so two clients' identical property names stay apart"
  );
  has(lib, "g[bucket].push(r);", "the client keeps its whole month");
  has(lib, "p[bucket].push(r);", "and the property holds the same rows");

  const card = readFileSync(`${SRC}/app/(app)/content/client-card.tsx`, "utf8");
  has(card, "function PropertySection", "each property is a section of its own");
  has(card, "<SendBar group={group} rows={property.ready}", "with its own send");
  has(
    card,
    "group.properties.length > 1 && group.ready.length > 0",
    "and a send-everything only where there is more than one property to gather"
  );
  has(card, 'fd.set("campaign", property)', "the property is written where the copy is");

  const actions = readFileSync(`${SRC}/app/(app)/content/actions.ts`, "utf8");
  has(
    actions,
    'fd.has("campaign") ? String(fd.get("campaign") ?? "").trim() : null',
    "and a form that omits it cannot silently clear it"
  );
  ok("the board, the send and the message all cut on the same property");
}

await finish(pass);
