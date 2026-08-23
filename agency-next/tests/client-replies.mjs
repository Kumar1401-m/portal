/**
 * What a client says, and what the bot does about it.
 *
 * Two failures from one group, on one morning.
 *
 * A client wrote four numbered points about what the next videos should look
 * like. The parser found no command, a model read it as a change request, no
 * video was named — and the bot answered with a list of four codes and "reply
 * with the one you mean". To the client, the agency had stopped listening and
 * started filling in a form.
 *
 * Then they asked where a video was, and were given the Instagram link for a
 * reel that had gone to their Facebook Page as well: half the truth about
 * their own post, because half was all the assistant had been handed.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;
let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- a paragraph is not an answer ---------------- */
{
  const router = readFileSync(`${SRC}/../../whatsapp-service/src/lib/message-router.js`, "utf8");

  assert.ok(
    router.includes("parsed = { ...guessed, inferred: true }"),
    "a command the model inferred is marked as inferred"
  );
  assert.ok(
    router.includes("if (parsed.inferred) {"),
    "and the which-video question checks that before asking"
  );
  assert.ok(
    router.includes("'inferred-ambiguous'"),
    "an inferred command with nothing to attach it to is left to the assistant"
  );

  /*
   * The guard that was already there and was not enough: it caps the length of
   * a message that may be read as an approval, but a change had no such cap —
   * which is the door this message came through.
   */
  assert.ok(
    router.includes("String(msg.body).length > 300"),
    "the approval length guard is still in place"
  );
  ok("a four-point message about future work is not answered with a code list");
}

/* ---------------- and the link is to wherever it went ---------------- */
{
  const ai = readFileSync(`${SRC}/lib/whatsapp-ai.ts`, "utf8");
  assert.ok(ai.includes("facebook_post_id"), "the Facebook post is read from the row");
  assert.ok(
    ai.includes("facebookLink: facebookPermalink(r.facebook_post_id)"),
    "and turned into a link the assistant can offer"
  );
  assert.ok(
    ai.includes('from "./facebook"'),
    "using the shared permalink builder, not a second copy of the URL shape"
  );
  ok("a reel on Instagram and Facebook can be answered with both");
}

await finish(pass);
