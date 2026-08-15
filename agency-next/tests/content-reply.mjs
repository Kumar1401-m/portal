/**
 * A client answering about the content they were sent.
 *
 * The month's copy went out, the client replied "ok", and the group was told
 * there was nothing waiting for approval in it. From their side that is the
 * portal ignoring an answer it had just asked for — twice, since "change
 * content" got the same reply.
 *
 * The cause: the whole reply path was keyed on a video code. A code is
 * allocated when a *finished video* is sent for approval; content is sent as
 * text, has no code, and never touches `wa_status`. So the resolver looked at
 * videos, found none, and refused.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";

const SRC = process.env.PORTAL_SRC;
const wa = readFileSync(`${SRC}/lib/whatsapp-approvals.ts`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

/* ---------------- content is looked for, and looked for first ---------- */
{
  has(wa, "export async function contentAwaitingInGroup", "content waiting in a group can be found");
  has(wa, "d.status = 'content_review'", "which is what being asked means for content");

  // Checked before the video path: a client who has just been sent the month's
  // copy and replies "ok" is answering that, not a video from last week. A
  // video always carries a code they can name if they mean that one.
  const contentAt = wa.indexOf("const content = await recordContentVerdict({");
  const videoAt = wa.indexOf("const resolved = await resolveVideoForGroup(input.groupId);");
  assert.ok(contentAt > 0 && videoAt > contentAt, "content is resolved before video");

  // And the video path is untouched, so an approval by code still behaves
  // exactly as it did.
  has(wa, "const d = await findByVideoCode(videoCode);", "the video path is unchanged");
  ok("a reply is matched against the content the client was actually sent");
}

/* ---------------- a batch is answered as a batch ---------------- */
{
  // Content goes out as fifteen numbered pieces under one "reply OK to
  // approve", so the answer is about all of them. Resolving it to a single
  // piece would be the wrong question; asking which one they meant would be
  // answering a question nobody asked.
  has(wa, "LIMIT 50", "every piece waiting is gathered");
  has(wa, "WHERE id IN (${ids.join(\",\")})", "and all of them move together");
  assert.ok(
    !/ambiguous[\s\S]{0,200}content/.test(wa),
    "a batch is never called ambiguous"
  );
  ok("one reply answers every piece it was about");
}

/* ---------------- and it lands where the work continues ---------------- */
{
  // The same two gates the portal already has — this is the client pressing
  // them from WhatsApp rather than the super admin pressing them on the board.
  has(wa, '? "waiting_for_raw"', "approved content opens the content gate");
  has(wa, ': input.command === "change" ? "pending"', "a change goes back to the content desk");

  // Not `changes_requested`: that status belongs to finished work, and the
  // content desk only looks at pending and content_review — a brief sent
  // there would be invisible to the person who has to rewrite it.
  const contentBlock = wa.slice(wa.indexOf("export async function recordContentVerdict"));
  const assignment = contentBlock.slice(
    contentBlock.indexOf("const nextStatus ="),
    contentBlock.indexOf(";", contentBlock.indexOf("const nextStatus ="))
  );
  assert.ok(
    !assignment.includes("changes_requested"),
    "a rewrite is never parked where nobody writes briefs"
  );
  // It is still recorded as a change on `approval_status`, which is where that
  // word belongs — the row's own status is what decides which board shows it.
  has(contentBlock, '"changes_requested"', "the verdict itself is still recorded");

  has(contentBlock, "INSERT INTO feedback", "their words go into the thread");
  has(contentBlock, "const byPerson = new Map", "and the maker is told once, not once per piece");
  ok("an approved brief becomes the maker's, and a rejected one goes back to be written");
}

/* ---------------- the client is answered in the right words ---------- */
{
  const router = readFileSync(`${SRC}/../../whatsapp-service/src/lib/message-router.js`, "utf8");

  // "We'll get it scheduled for posting" is right about an approved video and
  // wrong about approved copy — nothing has been made yet.
  has(router, "if (data?.kind === 'content') {", "content gets its own acknowledgement");
  has(router, "we'll get started on ", "which says what actually happens next");
  assert.ok(
    !/kind === 'content'[\s\S]{0,400}scheduled for posting/.test(router),
    "and never promises a posting slot for a brief"
  );

  // The portal is the only thing that knows which it was, so it says so.
  has(wa, 'kind: "content"', "the portal reports the kind");
  has(wa, "count: content.count", "and how many it covered");
  ok("the client is told what really happens next, not the video sentence");
}

/* ---------------- a linked group learns its own name ---------------- */
{
  // `linkGroup` is given a name only when somebody links from the live chat
  // list — the least reliable thing the service does, since it runs library
  // code inside the WhatsApp Web page. Every other route in left it null, so
  // Settings showed a column of raw ids.
  has(wa, "if (input.groupName?.trim()) {", "an inbound message carries the name");
  has(wa, "SET group_name = ?", "which is stored on the group");
  has(
    wa,
    "WHERE group_id = ? AND (group_name IS NULL OR group_name <> ?)",
    "and only written when it actually changes"
  );

  // Groups linked before this existed should not have to wait for somebody to
  // write in the chat before they stop showing as an id.
  has(wa, "COALESCE(NULLIF(g.group_name, ''), (", "the stored name comes first");
  has(wa, "FROM whatsapp_messages m", "and the transcript fills the gap");

  const ui = readFileSync(`${SRC}/app/(app)/settings/whatsapp/group-manager.tsx`, "utf8");
  has(ui, "const liveName = (groupId: string)", "the page has one more fallback");
  // The old copy blamed WhatsApp for not exposing names, which was wrong and
  // sent people looking for a problem that was not there.
  assert.ok(!/doesn't expose group names/.test(ui), "the wrong explanation is gone");
  has(ui, "name will appear on their first message", "and it now reads as waiting, not broken");
  ok("a group’s name is learnt from its own messages rather than left blank");
}

await finish(pass);
