/**
 * Where finished work goes, and what a piece is called.
 *
 * Two things that quietly made the boards worse as the agency got busier: a
 * posted video never left the list of work to do, and everything the month
 * generator created was called "Video 6".
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const load = (rel) => import(pathToFileURL(`${SRC}/${rel}`).href);
const c = await load("lib/constants.ts");
const content = await load("lib/content.ts");
const ai_mod = await load("lib/whatsapp-ai.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

/* ---------------- posted is posted, however it was recorded ---------------- */
{
  // A piece can be posted in two different places: the publisher writes
  // posting_status, marking it by hand writes the workflow status. A check
  // written for one was blind to the other — which is exactly how a row
  // showing "Posted" stayed on the board of work still to do.
  assert.equal(c.isFinished("scheduled", "posted"), true, "published by the automation");
  assert.equal(c.isFinished("posted", null), true, "marked posted by hand");
  assert.equal(c.isFinished("completed", null), true, "and filed away after that");

  // Nothing is owed on these either.
  assert.equal(c.isFinished("cancelled", null), true);
  assert.equal(c.isFinished("rejected", null), true);

  // Everything still moving stays.
  for (const s of ["pending", "content_review", "waiting_for_raw", "editing", "caption_ready", "review", "changes_requested", "resolved", "approved", "scheduled"]) {
    assert.equal(c.isFinished(s, null), false, `${s} is still work`);
  }
  // A scheduled post that has not gone out yet is not finished.
  assert.equal(c.isFinished("scheduled", "scheduled"), false);

  // It must agree with the label the same row prints, or one of them is lying.
  for (const [s, p] of [["scheduled", "posted"], ["posted", null], ["completed", null]]) {
    assert.equal(c.postStatusLabel(s, p), "Posted", `${s}/${p} prints Posted`);
    assert.equal(c.isFinished(s, p), true, "and is therefore off the working boards");
  }
  ok("finished means finished whichever column recorded it");
}

/* ---------------- and it is off both boards ---------------- */
{
  const today = readFileSync(`${SRC}/app/(app)/today/page.tsx`, "utf8");
  has(today, "!isFinished(d.status, d.posting_status)", "Today's Tasks drops it");

  const tasks = readFileSync(`${SRC}/app/(app)/deliverables/page.tsx`, "utf8");
  has(tasks, "board.filter((d) => !isFinished(d.status, d.posting_status))", "All Tasks drops it");

  // Not deleted, though: "what went out in May" is a fair question, and
  // cancelled and rejected live nowhere else at all.
  has(tasks, 'const showDone = sp.done === "1"', "one link brings it back");
  has(tasks, "doneHref(true)", "which is on the page");
  // Paging must not silently switch it off again.
  has(tasks, 'params={showDone ? { ...params, done: "1" } : params}', "and survives paging");

  // A tab reading 28 above a board holding 12 is a bug report waiting to
  // happen, so the counts come from the rows on screen.
  assert.ok(!/getServiceCounts\(/.test(tasks), "the tab counts are not the unfiltered ones");
  has(tasks, "for (const d of all) counts[serviceOf(d)]++", "they are counted from what is shown");
  ok("finished work is hidden on both boards, and one click away on Tasks");
}

/* ---------------- a placeholder title is not a name ---------------- */
{
  // What generateMonthTasks calls things before anybody writes a word.
  for (const t of ["Video 6", "Poster 2", "video 12", "  Reel 3 ", "Post 1"]) {
    assert.ok(content.isPlaceholderTitle(t), `${JSON.stringify(t)} is a placeholder`);
  }
  // Anything a person chose is theirs, and must survive untouched.
  for (const t of ["Diwali reel", "Video walkthrough", "Poster for the launch", "3 BHK tour", "", "Video"]) {
    assert.ok(!content.isPlaceholderTitle(t), `${JSON.stringify(t)} is a real title`);
  }
  ok("a generated name is told apart from one somebody chose");
}

/* ---------------- and it is findable, in exactly one place ---------------- */
{
  // The hole this change would otherwise have opened: hidden from both working
  // boards, and on the Posted tab only if somebody had marked it by hand. A
  // piece the publisher put out has posting_status set and a workflow status
  // that never moved, so it would have shown under Scheduled — and nowhere
  // else at all.
  const lib = readFileSync(`${SRC}/lib/deliverables.ts`, "utf8");
  has(lib, "if (f.postedEither) {", "the tab can ask for posted in either sense");
  has(
    lib,
    "(d.posting_status = 'posted' OR d.status IN ('posted','completed'))",
    "and it means the same thing isFinished means"
  );
  has(
    lib,
    "COALESCE(SUM(d.posting_status = 'posted' OR d.status IN ('posted','completed')),0) AS posted",
    "so the tab count matches the rows behind it"
  );

  const page = readFileSync(`${SRC}/app/(app)/approvals/page.tsx`, "utf8");
  has(page, "postedEither: true", "the Posted tab asks for it");
  has(page, "active.postedEither", "and the filter honours it");
  ok("posted work is findable, in exactly one place");
}

/* ---------------- housekeeping the boards already did ---------------- */
{
  // "❤️" is two code points, and inside [❤️…] the class holds both — so it
  // matched a bare variation selector, and "☺️" came back as a heart.
  const ai = readFileSync(`${SRC}/lib/whatsapp-ai.ts`, "utf8");
  has(ai, "const t = text.replace(", "selectors are stripped before matching");
  // Behaviour, not source: ☺️ carries the same selector, so before the fix it
  // matched the heart class and came back as “that means a lot to us”.
  assert.ok(
    !ai_mod.emojiReply("☺️").includes("means a lot"),
    "a smiley is no longer read as a heart"
  );
  assert.ok(ai_mod.emojiReply("❤️").includes("means a lot"), "and a heart still is");
  assert.ok(ai_mod.emojiReply("🙏").startsWith("🙏"), "and folded hands still get thanks");
  ok("two small wrongnesses that only showed up at the edges");
}

/* ---------------- and the tile counting it says the same thing ---------------- */
{
  const wa = readFileSync(`${SRC}/lib/whatsapp-approvals.ts`, "utf8");

  // “Ready to post” asked for status <> 'posted' alone, so it counted
  // anything the publisher had put out — which sets posting_status and leaves
  // the workflow status where it was — for ever. The tile read “Ready to
  // post: 1” about something already on the client’s page.
  has(wa, "COALESCE(d.posting_status,'') <> 'posted'", "the publisher’s column counts");
  has(
    wa,
    "d.status NOT IN ('posted','completed','cancelled','rejected')",
    "and so does everything else that is finished"
  );
  assert.ok(
    !wa.includes("d.wa_status = 'approved' AND d.status <> 'posted'"),
    "the half-check is gone"
  );
  ok("a piece already posted is not counted as ready to post");
}

/* ---------------- and a video names itself on upload ---------------- */
{
  const up = readFileSync(`${SRC}/app/(app)/deliverables/upload-actions.ts`, "utf8");
  // Same rule as the content desk — only over a placeholder, never over a
  // title somebody typed.
  has(up, "isPlaceholderTitle(t.title)", "a named task keeps its name");
  has(up, "(t?.description ?? \"\").trim() || (t?.caption ?? \"\").trim()", "named from the brief, then the caption");
  // The analysis has not finished at upload time and the file is VID_2026.mp4,
  // so neither is a source.
  has(up, "} catch (err) {", "and a failed rename cannot fail the upload");
  ok("an uploaded video is named from what the task already says");
}

await finish(pass);
