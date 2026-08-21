/**
 * What a client actually receives when a video is sent for approval:
 * the video at the top, then the caption, then the question.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const wa = await import(pathToFileURL(`${SRC}/lib/whatsapp-approvals.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

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


/* ---------------- replying to the video is enough ---------------- */
{
  /*
   * Three reels in one group, and a client who replies "ok".
   *
   * There was no answer to that. The portal could not tell which reel they
   * meant, so it asked for a code — and the code had been taken off the video
   * message, so there was nowhere left to read one. The client was told to
   * quote something they could not see, about a video they had just replied to.
   *
   * WhatsApp already carries the answer: a swipe-reply names a message, and
   * the id of the message each video went out in has been on the row since it
   * was sent. Run for real rather than grepped for, because the failure this
   * closes was a branch that existed and was never reached.
   */
  const GROUP = "ZZ_QUOTE_GROUP@g.us";
  const clean = async () => {
    await db.execute(
      "DELETE FROM whatsapp_send_log WHERE deliverable_id IN (SELECT id FROM deliverables WHERE wa_group_id = ?)",
      [GROUP]
    );
    await db.execute("DELETE FROM deliverables WHERE wa_group_id = ?", [GROUP]);
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ quote'");
  };
  await clean();
  const cid = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ quote','active')")).insertId
  );
  const add = async (code, title, msgId) =>
    Number(
      (await db.execute(
        `INSERT INTO deliverables (client_id, title, status, video_code, wa_group_id,
                                   wa_status, wa_message_id, wa_sent_at)
         VALUES (?,?,'review',?,?, 'sent', ?, NOW())`,
        [cid, title, code, GROUP, msgId]
      )).insertId
    );

  try {
    const first = await add("ZZ901", "Reel one", "ZZ_MSG_ONE");
    await add("ZZ902", "Reel two", "ZZ_MSG_TWO");
    await add("ZZ903", "Reel three", "ZZ_MSG_THREE");
    await add("ZZ904", "Reel four", "ZZ_MSG_FOUR");

    // Without a reply there is genuinely no way to tell, and saying so is right.
    const bare = await wa.recordApproval({
      videoCode: null, command: "approve", groupId: GROUP,
    });
    assert.equal(bare.ok, false, "a bare ok with three waiting cannot be guessed");
    assert.equal(bare.ambiguous, true, "and is reported as ambiguous, not as an error");

    // Replying to the first one names it outright.
    const replied = await wa.recordApproval({
      videoCode: null, command: "approve", groupId: GROUP,
      quotedMessageId: "ZZ_MSG_ONE",
      waMessageId: "ZZ_INBOUND_1",
    });
    assert.equal(replied.ok, true, "replying to the video is an answer");
    assert.equal(replied.deliverableId, first, "and it is the video they replied to");
    assert.equal(replied.videoCode, "ZZ901");

    /*
     * And a reply to the message that asked them.
     *
     * A video is three messages — the reel, its caption, and the question.
     * The question is last and is the only one that asks anything, so it is
     * the one a client replies to; its id was thrown away, so the reply
     * everybody actually makes was the one case this could not read.
     */
    const [two] = await db.query(
      "SELECT id FROM deliverables WHERE video_code = 'ZZ902'"
    );
    await db.execute(
      `INSERT INTO whatsapp_send_log (deliverable_id, video_code, group_id, attempt_no, status, wa_message_id)
       VALUES (?, 'ZZ902', ?, 1, 'sent', 'ZZ_MSG_TWO_QUESTION')`,
      [two.id, GROUP]
    );
    const onQuestion = await wa.recordApproval({
      videoCode: null, command: "approve", groupId: GROUP,
      quotedMessageId: "ZZ_MSG_TWO_QUESTION",
      waMessageId: "ZZ_INBOUND_2",
    });
    assert.equal(onQuestion.ok, true, "replying to the question is replying about the video");
    assert.equal(onQuestion.videoCode, "ZZ902", "and it is that video, not another");

    /*
     * And the same reply when the library could not serialize the quote.
     *
     * `getQuotedMessage()` has to find the original in the local store, which
     * is not guaranteed for a reply to a video — and when it fails it fails
     * to null, which reads as "they replied to nothing". The raw stanza id is
     * on the payload either way, and it is the tail of the id we stored.
     */
    const [three] = await db.query("SELECT id FROM deliverables WHERE video_code = 'ZZ903'");
    await db.execute(
      "UPDATE deliverables SET wa_message_id = 'true_120363000@g.us_3EBSTANZA903' WHERE id = ?",
      [three.id]
    );
    // Two are still waiting at this point, so nothing but the stanza id can
    // pick this one out — which is the whole claim being tested.
    const stillWaiting = await wa.recordApproval({
      videoCode: null, command: "approve", groupId: GROUP,
    });
    assert.equal(stillWaiting.ambiguous, true, "two reels are genuinely still open");

    const byStanza = await wa.recordApproval({
      videoCode: null, command: "approve", groupId: GROUP,
      quotedMessageId: null,
      quotedStanzaId: "3EBSTANZA903",
      waMessageId: "ZZ_INBOUND_3",
    });
    assert.equal(byStanza.ok, true, "a stanza id alone still names the video");
    assert.equal(byStanza.videoCode, "ZZ903");

    // The other two are untouched — an "ok" answers one reel, not the group.
    const [others] = await db.query(
      "SELECT COUNT(*) AS n FROM deliverables WHERE wa_group_id = ? AND status = 'review'",
      [GROUP]
    );
    assert.equal(Number(others.n), 1, "each reply answered its own reel and no other");
  } finally {
    await clean();
  }
  ok("a client answers by replying to the video, with three of them waiting");
}

await finish(pass);
