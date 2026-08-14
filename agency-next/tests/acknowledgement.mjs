/**
 * What a client reads back when they say "ok".
 *
 * These are the only messages the agency sends without a person having read
 * them first, and they land in the client's own group. A number-agreement slip
 * here — "we'll rework all 2 pieces and send it back" — is the agency's
 * writing, in front of the client, for ever.
 *
 * The acknowledgement lives in the WhatsApp service rather than the portal, so
 * it is lifted out and run rather than imported.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.SRC ?? process.env.PORTAL_SRC;
const router = readFileSync(`${SRC}/../../whatsapp-service/src/lib/message-router.js`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* The method, extracted and given a sender that just collects. */
const body = router.slice(
  router.indexOf("async acknowledge"),
  router.indexOf("\n  }", router.indexOf("async acknowledge")) + 4
);
const make = new Function(
  "return " + body.replace("async acknowledge(", "async function(").replace(/this\./g, "self.")
);
const say = async (command, data) => {
  const out = [];
  const self = { replySafely: async (_g, t) => out.push(t) };
  const ack = new Function("self", "return " + body.replace("async acknowledge(", "async function(").replace(/this\./g, "self."))(self);
  await ack("g", command, "V245", data);
  return out[0];
};
assert.ok(typeof make === "function", "the acknowledgement could be lifted out");

/* ---------------- the noun and its pronoun agree ---------------- */
{
  const one = await say("approve", { kind: "content", count: 1 });
  const two = await say("approve", { kind: "content", count: 2 });
  const many = await say("approve", { kind: "content", count: 12 });

  assert.match(one, /The content is approved/, "one piece is singular throughout");
  // "all 2" is not something anybody says.
  assert.match(two, /Both pieces are approved/, "two is 'both', never 'all 2'");
  assert.ok(!/all 2/i.test(two), "and definitely not 'all 2'");
  assert.match(many, /All 12 pieces are approved/, "more than two is counted");

  // The bug this replaces: plural noun, singular pronoun, in one sentence.
  const change2 = await say("change", { kind: "content", count: 2 });
  assert.ok(!/pieces[\s\S]*\bit\b/.test(change2), "a plural is never referred to as 'it'");
  assert.match(change2, /rework them and send them back/, "plural all the way through");

  const change1 = await say("change", { kind: "content", count: 1 });
  assert.ok(!/\bthem\b/.test(change1), "and a single piece is never 'them'");
  ok("singular and plural agree in every content reply");
}

/* ---------------- and a missing title does not leave a gap ---------- */
{
  const titled = await say("approve", { title: "Diwali reel" });
  const untitled = await say("approve", {});

  assert.match(titled, /_Diwali reel_ is approved/, "the title is used when there is one");
  // Split apart, this came out as "Thank you! it is approved".
  assert.ok(!/! it is/.test(untitled), "and its absence does not produce a lower-case 'it is'");
  assert.match(untitled, /That is approved/, "it becomes a subject that reads as one");

  // The video message stopped showing a code, so echoing one back names
  // something the client has never seen.
  for (const t of [titled, untitled]) {
    assert.ok(!/V245/.test(t), "no code is quoted back at the client");
  }
  ok("a video with no title still reads as a sentence");
}

/* ---------------- content and video promise different things -------- */
{
  const content = await say("approve", { kind: "content", count: 1 });
  const video = await say("approve", { title: "Diwali reel" });

  // Nothing has been made yet when copy is approved.
  assert.ok(!/scheduled for posting/.test(content), "approved copy is not promised a posting slot");
  assert.match(content, /we'll get started on it/, "it promises the work instead");
  assert.match(video, /scheduled for posting/, "an approved video is promised the slot");
  ok("each says what actually happens next");
}

/* ---------------- and all of them stay courteous ---------------- */
{
  const all = [];
  for (const cmd of ["approve", "change", "reject"]) {
    all.push(await say(cmd, { kind: "content", count: 1 }));
    all.push(await say(cmd, { kind: "content", count: 3 }));
    all.push(await say(cmd, { title: "Diwali reel" }));
    all.push(await say(cmd, {}));
  }

  for (const t of all) {
    assert.ok(t && t.length > 20, "every case produces a real sentence");
    // The same bar the portal's own client messages are held to.
    assert.ok(!/\bASAP\b|as soon as possible/i.test(t), `no hurrying: ${t}`);
    assert.ok(!/\byou (must|need to|have to|should)\b/i.test(t), `no instructing: ${t}`);
    assert.ok(!/undefined|null|NaN/.test(t), `nothing leaked: ${t}`);
    // Reads as a full sentence, not a stamp: "Approved" on its own was the
    // old shape and it read like a receipt printer.
    assert.ok(!/^\s*✅ Thank you! \*?V?\d/.test(t), `does not open with a code: ${t}`);
  }

  // A rejection is the one that must not sound like a complaint back.
  const rejected = await say("reject", { title: "Diwali reel" });
  assert.match(rejected, /Understood/, "a rejection is accepted, not argued with");
  assert.match(rejected, /follow up with you/, "and promises a person");
  ok("every acknowledgement is a courteous, complete sentence");
}

await finish(pass);
