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

const SRC = process.env.PORTAL_SRC;
const ROOT = `${SRC}/../..`;

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
    "if (parsed.command === 'none' && String(msg.body || '').trim())",
    "and the model is only asked about what it could not read"
  );
  // So a typed "ok" never depends on a model, a key, or the portal being up.
  ok("a typed OK is still read by the parser, with no model involved");
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

  // Every failure — no key, bad JSON, a timeout — has to come back as "none"
  // rather than an error, because the caller's fallback is to do nothing and
  // that is the correct outcome.
  for (const reason of ["no model", "too long", "empty", "unparsable", "error"]) {
    has(route, `"${reason}"`, `a ${reason} failure answers none rather than throwing`);
  }
  has(route, 'intent: "none", confidence: 0', "with no confidence attached to it");
  ok("every way this can fail comes back as 'not understood'");
}

/* ---------------- and a voice note is not cut off ---------------- */
{
  const route = readFileSync(`${SRC}/app/api/whatsapp/transcribe/route.ts`, "utf8");

  // The old budget was 400 tokens, which a minute of speech overruns — and an
  // overrun comes back empty, not short, so it reads as "the client said
  // nothing" rather than "we cut them off".
  has(route, "maxOutputTokens: 1200", "the transcript has room");
  has(route, "finishReason: cand?.finishReason", "and an empty one says why in the log");
  has(
    route,
    "do not translate",
    "the words stay in the client's own language — the intent step reads them there"
  );
  ok("a voice note is transcribed whole, and a truncated one is not silent");
}

await finish(pass);
