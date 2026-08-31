/**
 * A client who answers in their own language, or out loud.
 *
 * The command parser knows "ok", "approve", "change" — which is what a client
 * *types*, because it is what we asked them to type. It is not what a client
 * *says*: a voice note comes back transcribed in Telugu or Hindi, and none of
 * those words are in it. Those replies were logged and then ignored, which
 * from the client's side is us not answering.
 *
 * The rule this has to keep: praise is not permission. "chala bagundi" says
 * the work is good; it does not say to publish it.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const ROOT = `${SRC}/../..`;

const ai = await import(pathToFileURL(`${process.env.PORTAL_SRC}/lib/whatsapp-ai.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

/* ---------------- the literal parser still goes first ---------------- */
{
  const router = readFileSync(`${ROOT}/whatsapp-service/src/lib/message-router.js`, "utf8");

  const parseAt = router.indexOf("let parsed = parseCommand(msg.body)");
  const intentAt = router.indexOf("const guessed = await this.readIntent(msg)");
  assert.ok(parseAt > 0 && intentAt > parseAt, "the deterministic parser runs first");
  has(
    router,
    "if (parsed.command === 'none' && String(msg.body || '').trim() && !emojiOnly(msg.body))",
    "and the model is only asked about what it could not read"
  );
  // So a typed "ok" never depends on a model, a key, or the portal being up.
  ok("a typed OK is still read by the parser, with no model involved");
}

/* ---------------- being spoken to is answered, always ---------------- */
{
  const gate = (over = {}) =>
    ai.shouldAutoReply({
      direction: "in",
      parsedCommand: "none",
      groupId: "g-addressed",
      message: "When is the reel going out?",
      now: 1_000_000,
      ...over,
    });

  // The cooldown and the acknowledgement filter exist to keep the assistant
  // out of a conversation between the client's own people. Both misfire the
  // moment somebody is plainly talking to us — and a client who tags us and
  // gets nothing back has been ignored, which is the impression the cooldown
  // was there to prevent.
  ai.markReplied("g-addressed", 1_000_000);
  assert.equal(gate().reply, false, "an ordinary message waits for the cooldown");
  assert.equal(gate({ addressed: true }).reply, true, "one aimed at us does not");

  assert.equal(gate({ message: "thanks" }).reply, false, "a thank-you to the room is not ours");
  assert.equal(
    gate({ message: "thanks", addressed: true }).reply,
    true,
    "the same words said to us are"
  );

  // What must still never be answered.
  assert.equal(gate({ direction: "out", addressed: true }).reply, false, "our own messages");
  assert.equal(
    gate({ parsedCommand: "approve", addressed: true }).reply,
    false,
    "an approval, which has its own handler"
  );
  /*
   * An essay is answered now, and that is the change.
   *
   * It used to be silence: too long to send to the model, so nothing was sent
   * to the client either. The two people most likely to write nine hundred
   * characters are the one with a complicated request and the one who is
   * annoyed, and both were the ones getting ignored.
   *
   * It is still not sent to the model — an answer drawn confidently from the
   * wrong half of a long message is worse than none — so it is marked `hold`,
   * which is the courteous acknowledgement plus a notification to the team.
   */
  const essay = gate({ message: "x".repeat(900), addressed: true });
  assert.equal(essay.reply, true, "an essay is acknowledged rather than ignored");
  assert.equal(essay.kind, "hold", "but never guessed at");
  ok("tagging us or replying to us gets an answer, cooldown or not");
}

/* ---------------- an emoji gets an emoji ---------------- */
{
  for (const t of ["🙏", "❤️", "🔥🔥🔥", "👨‍👩‍👧", "😊 !"]) {
    assert.ok(ai.isEmojiOnly(t), `${t} is emoji only`);
  }
  // The one thing that must not happen: a real message read as a smiley and
  // answered with one.
  //
  // The keycaps are the interesting case. "1️⃣" is built from the digit 1, so
  // the letter-or-digit guard sends it down the ordinary answer path — which
  // is where it belongs: a client answering a numbered list of content with
  // "1️⃣" has told us which piece they mean, and "😊 Thank you!" would be the
  // wrong reply to it.
  for (const t of ["ok", "5", "#3", "1️⃣", "nice 👍", "", "  ", "change 🙏"]) {
    assert.ok(!ai.isEmojiOnly(t), `${JSON.stringify(t)} is a real message`);
  }

  const g = ai.shouldAutoReply({
    direction: "in",
    parsedCommand: "none",
    groupId: "g-emoji",
    message: "🙏",
    now: 2_000_000,
  });
  assert.equal(g.reply, true, "an emoji is answered");
  assert.equal(g.kind, "emoji", "and marked as needing an emoji, not a paragraph");

  // Warm, short, and never a question — a client who sent a heart is not
  // opening a conversation, and "anything else?" makes it an obligation.
  const r = ai.emojiReply("❤️", "Ravi Kumar");
  assert.match(r, /Ravi/, "by first name");
  assert.ok(!/\?/.test(r), "and asks nothing back");
  assert.ok(r.length < 90, "one line");
  assert.match(ai.emojiReply("🙏", null), /Thank you!/, "and works with no name on file");
  ok("an emoji is answered in kind, briefly, and never mistaken for a question");
}

/* ---------------- a voice note we could not hear is still answered ---------------- */
{
  const r = ai.unheardVoiceReply("Priya");
  assert.match(r, /Priya/);
  assert.match(r, /once more|type it here/i, "it asks for it again, and offers the easier way");
  assert.ok(!/\bfail|error|invalid\b/i.test(r), "in the client's terms, not ours");

  const route = readFileSync(`${SRC}/app/api/whatsapp/message/route.ts`, "utf8");
  // Neither of these has anything for a model to do — one has no words, the
  // other nothing to look up — so both answer without spending a call.
  has(route, "const quick = input.voiceUnreadable", "an unheard voice note answers directly");
  has(route, 'gate.kind === "emoji"', "and so does an emoji");
  has(route, "addressed: body.addressed === true", "the signal reaches the gate");

  const router = readFileSync(`${ROOT}/whatsapp-service/src/lib/message-router.js`, "utf8");
  has(
    router,
    "addressed: Boolean(msg.mentionedUs || msg.repliedToUs || msg.isVoice)",
    "tagged, replied to, or spoken to"
  );
  has(
    router,
    "voiceUnreadable: Boolean(msg.isVoice && msg.transcribed !== true)",
    "and a placeholder is never answered as if it were the client's words"
  );

  const client = readFileSync(`${ROOT}/whatsapp-service/src/lib/whatsapp-client.js`, "utf8");
  has(client, "repliedToUs = Boolean(quoted?.fromMe)", "a reply to us is read off the quoted message");
  has(client, "mentionedUs = Boolean(", "and a tag off the mentions");
  ok("a voice note that could not be made out is asked for again, not ignored");
}

/* ---------------- and an approval is the guarded one ---------------- */
{
  const router = readFileSync(`${ROOT}/whatsapp-service/src/lib/message-router.js`, "utf8");

  // Not symmetric on purpose: a missed approval costs one more message, a
  // wrong one puts a post on a client's page they did not agree to.
  has(
    router,
    "const floor = d.intent === 'approve' ? 0.8 : 0.6;",
    "approval needs more confidence than a change does"
  );
  has(
    router,
    "if (d.intent === 'approve' && String(msg.body).length > 300)",
    "and a long message is a conversation, not an answer"
  );
  has(router, "if (!d?.ok || !d.intent || d.intent === 'none') return null;", "none means none");

  // Shaped exactly like the parser's own result, so nothing downstream has a
  // second path that could drift.
  for (const k of ["command:", "videoCode:", "comment:", "link:"]) {
    has(router, k, `the guess is shaped like a parse (${k})`);
  }
  ok("an approval read by the model is held to a higher bar than a change");
}

/* ---------------- the model is told what approval is not ---------------- */
{
  const route = readFileSync(`${SRC}/app/api/whatsapp/intent/route.ts`, "utf8");

  has(route, "Praise is not permission", "the distinction is stated outright");
  has(route, "If you are unsure, choose none.", "and uncertainty resolves to doing nothing");
  has(route, "Telugu, Hindi, Tamil, Kannada, English", "the languages clients actually use");
  has(route, "transliterated", "including romanised, which is how most of it arrives");

  /*
   * Every failure — no key, a rate limit, a timeout — comes back as "none"
   * rather than as an error, because the caller's fallback is to do nothing
   * and doing nothing is the correct outcome. A classifier that is down must
   * never look like a client saying no.
   */
  for (const reason of ["no model", "too long", "unavailable"]) {
    has(route, `"${reason}"`, `a ${reason} failure answers none rather than throwing`);
  }
  has(route, 'intent: "none", confidence: 0', "with no confidence attached to it");

  /*
   * "unparsable" is gone as a category, and that is the improvement.
   *
   * The reply is now decoded against a strict schema, so it cannot come back
   * as prose, a code fence or a missing key — there is nothing left to repair,
   * and every repair was a guess about what the model meant on the path that
   * decides whether a client just approved their video.
   */
  has(route, 'schemaName: "intent"', "the reply is decoded against a schema");
  has(route, "enum: INTENTS", "and an intent outside the list cannot be emitted");
  has(route, 'console.warn("[whatsapp] intent unavailable:', "the real reason is logged, not a category");
  ok("every way this can fail comes back as 'not understood'");
}

/* ---------------- and a voice note is not cut off ---------------- */
{
  const route = readFileSync(`${SRC}/app/api/whatsapp/transcribe/route.ts`, "utf8");

  /*
   * The token budget that used to truncate a voice note is gone entirely.
   *
   * It was a general-purpose model asked to transcribe, so the transcript came
   * out of an output budget shared with its own reasoning — and an overrun came
   * back empty rather than short, which read as "the client said nothing"
   * rather than "we cut them off". A transcription endpoint has no such
   * budget: it returns the whole of what it heard, or an error saying why.
   */
  has(route, "transcribeBlob(", "the transcript comes from a transcription model");
  assert.ok(!/maxOutputTokens/.test(route), "with no output budget left to truncate it");
  has(route, 'console.warn("[whatsapp] transcription came back empty")', "and an empty one says so in the log");
  has(
    route,
    "Do not answer it, summarise it or comment on it.",
    "the words stay in the client's own language — the intent step reads them there"
  );
  ok("a voice note is transcribed whole, and a silent one is not mistaken for a failure");
}

/* ---------------- a change asked for by voice lands on the task ---------------- */
{
  const wa = readFileSync(`${SRC}/lib/whatsapp-approvals.ts`, "utf8");

  // It set reject_reason, logged an activity row, and stopped. The feedback
  // thread is what the task page and the designer’s queue actually show, so a
  // change asked for in the group appeared in a banner and was missing from
  // the conversation the team reads — while the same change typed in the
  // portal appeared in both.
  has(wa, "INSERT INTO feedback (deliverable_id, author_id, author_role, message)", "it is written into the thread");
  has(wa, 'if (input.command !== "approve") {', "for a change or a rejection, not an approval");

  // A voice note is transcribed in the client’s own language and the note is
  // our English reading of it. The person redoing the work should see both:
  // the client’s own words are what settle an argument about what was asked.
  has(wa, "note && said && note !== said", "both the words and the reading of them");

  // And the maker is told. Changes went to notifyAdmins alone, so the one
  // person who has to make them found out when somebody forwarded it.
  has(wa, 'if (input.command === "change" && d.assigned_to)', "whoever has the task is told");
  has(wa, "d.assigned_to, c.company_name", "which the lookup now reads");
  ok("a change requested on WhatsApp reaches the person who has to make it");
}

await finish(pass);
