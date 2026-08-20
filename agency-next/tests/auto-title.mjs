/**
 * What a video ends up being called, and when.
 *
 * A generated month arrives as "Video 1" through "Video 20". Those numbers are
 * fine as a placeholder and useless on a board: two clients' work looks
 * identical, and nobody can find last week's reel by name. The analysis knows
 * what the footage is about — it had to, to write the caption — so the title
 * comes from there.
 *
 * Two things are worth pinning. The first is WHEN: it used to happen only when
 * somebody pressed "Apply caption", so a video could be uploaded, analysed,
 * sent and approved while the board still said "Video 7". The second is WHO
 * wins: a title a person typed must survive a model that disagrees with it.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const read = (rel) => readFileSync(`${SRC}/${rel}`, "utf8");
const { isGeneratedTitle, titleFromTopic } = await import(
  pathToFileURL(`${SRC}/lib/title.ts`).href
);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- which titles the portal may overwrite ---------------- */
{
  for (const t of ["Video 1", "Video 20", "video 7", "Poster 3", "Reel 12", "Post 2", "Video7"]) {
    assert.equal(isGeneratedTitle(t), true, `${t} is a placeholder`);
  }
  // The other shape a nameless task gets, from autoTaskTitle.
  assert.equal(isGeneratedTitle("Instagram Reel · 11 Aug"), true);
  assert.equal(isGeneratedTitle("   "), true, "and an empty title is nobody's decision");
  ok("the numbered placeholder and the category-and-date title are both replaceable");
}

{
  // The whole point of the guard: these were typed by a person.
  for (const t of [
    "Diwali offer reel",
    "Video walkthrough of the new showroom",
    "Poster for the 5th anniversary",
    "Home loan myths, part 2",
  ]) {
    assert.equal(isGeneratedTitle(t), false, `"${t}" was typed by somebody`);
  }
  ok("a title somebody wrote is never overwritten, even when it starts with Video or Poster");
}

/* ---------------- what it gets renamed to ---------------- */
{
  assert.equal(titleFromTopic("home loan eligibility explained"), "Home loan eligibility explained");
  assert.equal(titleFromTopic('"gold rate update".'), "Gold rate update", "quotes and stops trimmed");
  assert.equal(titleFromTopic("  "), null, "nothing usable leaves the old title alone");
  assert.equal(titleFromTopic("ab"), null, "and two characters is not a title");
  assert.equal(titleFromTopic(null), null);
  ok("the topic becomes a title, or nothing at all — never a blank one");
}

{
  // A model that echoes the placeholder back has told us nothing, and writing
  // it would look exactly like the rename worked.
  assert.equal(titleFromTopic("Video 4"), null);
  ok("a topic that is itself a placeholder is refused rather than written back");
}

{
  const long = "a".repeat(200);
  const capped = titleFromTopic(long);
  assert.ok(capped.length <= 90, `${capped.length} characters would break the column`);
  assert.ok(capped.endsWith("…"), "and says it was cut");
  ok("a topic that came back as a sentence is capped to something a cell can hold");
}

/* ---------------- the rename happens without anyone pressing anything ---------------- */
{
  const src = read("lib/video-ai.ts");
  const doneAt = src.indexOf("state = 'done'");
  const returnsDone = src.indexOf('state: "done"', doneAt);
  const named = src.indexOf("nameFromTopic(", doneAt);
  assert.ok(doneAt > 0 && returnsDone > doneAt, "runAnalysis has a done path");
  assert.ok(
    named > doneAt && named < returnsDone,
    "the title is written when the analysis finishes, not when somebody applies the caption"
  );
  ok("finishing the analysis names the task, so the board never sits on Video 7");
}

{
  // Both entry points, so a row analysed before this existed still gets named.
  const src = read("lib/video-ai.ts");
  const applyAt = src.indexOf("export async function applyCaption");
  assert.ok(src.indexOf("nameFromTopic(", applyAt) > applyAt, "applyCaption still names it too");
  ok("applying a caption by hand names it as well, for anything analysed earlier");
}

/* ---------------- the ones already on the board ---------------- */
{
  // Everything analysed before the rename existed is still called "Video 7"
  // and never would be otherwise: its analysis is done, so nothing runs over
  // it again. Those are the videos actually on the board today.
  const src = read("lib/video-ai.ts");
  const at = src.indexOf("export async function nameAnalysedVideos");
  assert.ok(at > 0, "there is a backfill");
  const fn = src.slice(at, at + 1400);
  assert.ok(fn.includes("v.state = 'done'"), "it looks at finished analyses");
  assert.ok(fn.includes("isGeneratedTitle(r.title)"), "and still refuses to touch a typed title");
  assert.ok(fn.includes("LIMIT "), "bounded, because it runs on a page visit");
  assert.ok(!/callJSON|fetch\(/.test(fn), "and spends nothing — the topic is already in the row");

  const actions = read("app/(app)/editor/actions.ts");
  assert.ok(
    actions.indexOf("nameAnalysedVideos()") > actions.indexOf("advanceStalledAnalyses"),
    "and it is drained by the queue everyone already opens"
  );
  ok("videos analysed before this get named too, without re-analysing anything");
}

await finish(pass);
