/**
 * What a client actually receives when a video is sent for approval:
 * the video at the top, then the caption, then the question.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const wa = await import(pathToFileURL(`${SRC}/lib/whatsapp-approvals.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

const build = wa.buildApprovalMessages;

/* The video leads, and carries almost nothing. */
{
  const caption = "Every great space begins with a strong plan.\n\n#interiors #design";
  const m = build("Modular kitchen walkthrough", caption);

  assert.match(m.mediaCaption, /^📹 \*Video Ready\*/, "the video message leads");
  assert.match(m.mediaCaption, /_Modular kitchen walkthrough_/, "labelled with its title");
  assert.ok(!m.mediaCaption.includes(caption), "the post caption does NOT ride with the video");
  assert.ok(
    m.mediaCaption.length < 120,
    `the video's own text stays short so the preview stays big, got ${m.mediaCaption.length}`
  );
  assert.ok(!/OK\* to approve/.test(m.mediaCaption), "and no reply instructions on it");
  ok("the video is the first message and carries only its title");
}

/* Then the caption, whole, on its own. */
{
  const caption = "Line one\nLine two\n\n📞 040-1234\n#tag1 #tag2";
  const m = build("A title", caption);

  assert.equal(m.followUps.length, 2, "caption, then question");
  assert.equal(m.followUps[0], `*Caption*\n\n${caption}`,
    "the caption is its own message, reproduced exactly");
  ok("the caption follows as its own message, byte for byte");
}

/* Then the question. */
{
  const m = build("t", "c");
  const ask = m.followUps[m.followUps.length - 1];
  assert.match(ask, /review the video and the caption/);
  // Asked, not ordered. Every message to a client is a request they may
  // decline, and "Please review and reply" was an instruction with a "please"
  // in front of it.
  assert.match(ask, /could you please/i, "the ask is phrased as a request");
  assert.match(ask, /Thank you/i, "and it thanks them for doing it");
  assert.match(ask, /\*OK\* to approve/);
  assert.match(ask, /\*CHANGE\*/);
  ok("the question comes last, on its own");
}

/* A long caption is never cut — it has a whole message to itself. */
{
  const long = "x".repeat(1500);
  const m = build("Long one", long);
  assert.ok(m.followUps[0].includes(long), "sent complete, not truncated");
  assert.ok(!m.followUps[0].includes("…"), "and no ellipsis");
  assert.ok(m.followUps[0].length < 4096, "still inside a WhatsApp text message");
  ok("a 1500-character caption goes out whole");
}

/* No caption yet: no empty caption message, and no promise of one. */
{
  const m = build("Untitled reel", "");
  assert.equal(m.followUps.length, 1, "just the question");
  assert.ok(!m.followUps[0].includes("and the caption"), "does not mention a caption there isn't");
  assert.match(m.followUps[0], /could you please review it and reply/i);
  ok("with no caption, nothing empty is sent and the question adjusts");
}

/*
 * The instructions must match what the parser actually accepts.
 *
 * These two live in different services and cannot import each other, so the
 * only thing stopping them drifting is a test that reads both. Telling a
 * client to reply OK while the parser has stopped accepting it is a failure
 * nobody would see until an approval quietly did nothing.
 */
{
  const { parseCommand } = await import(
    pathToFileURL(`${SRC}/../../whatsapp-service/src/lib/command-parser.js`).href
  );
  const ask = build("t", "c").followUps[1];

  assert.ok(ask.includes("*OK* to approve"), "we ask for OK");
  assert.equal(parseCommand("OK").command, "approve", "and OK is what the parser approves on");

  assert.ok(ask.includes("*CHANGE*"), "we ask for CHANGE");
  assert.equal(parseCommand("CHANGE make it shorter").command, "change");

  assert.ok(ask.includes("voice note"), "we say a voice note works");
  ok("every reply we ask for is one the parser understands");
}

console.log(`\n${pass} checks passed.`);
