/**
 * One caption writer, not two.
 *
 * The portal had grown two, and they were not variations on a theme:
 *
 *   The video writer read a dozen high-detail frames of the finished cut,
 *   heard the transcript, applied the client's brand rules and reproduced
 *   their agreed caption structure, at the highest reasoning effort the
 *   portal buys anywhere.
 *
 *   The brief writer read what somebody typed into the task weeks ago, at
 *   medium effort, and had never heard of the caption structure.
 *
 * Which one you got depended on which button you happened to press, and both
 * returned something fluent and finished-looking. The second existed for a
 * reason that had nothing to do with quality: the first *refused* when there
 * were no frames and no transcript, and a poster and an un-uploaded task are
 * ordinary, not errors.
 *
 * So the refusal went. The one writer works from whatever it has and is told
 * plainly what it does not have, which is the thing that stops it describing
 * footage nobody showed it. And it now returns the alternates the second
 * writer was kept for.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const ai = await import(pathToFileURL(`${SRC}/lib/video-ai.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * Both buttons reach the same writer
 * ------------------------------------------------------------------ */
{
  const actions = read("app/(app)/deliverables/actions.ts");
  assert.ok(actions.includes("runAnalysisForCaption("), "the caption studio runs the analysis");
  assert.ok(
    actions.includes("await queueAnalysis(deliverableId, true);"),
    "forced, because pressing Generate and getting the caption already on screen reads as broken"
  );
  assert.ok(!actions.includes("await generateCaption("), "and the brief writer is no longer called");

  const modal = read("app/(app)/deliverables/edit-video-modal.tsx");
  assert.ok(modal.includes("await fromVideo();"), "so does the task modal");
  ok("every Generate button in the portal reaches one writer");
}

/* ------------------------------------------------------------------ *
 * It works with nothing to look at
 * ------------------------------------------------------------------ */
{
  const src = read("lib/video-ai.ts");
  assert.ok(!src.includes("Nothing to analyse"), "no frames and no audio is not a failure");
  assert.ok(
    src.includes("You were given NO frames — say nothing about what is on screen."),
    "it is told there were no frames"
  );
  assert.ok(src.includes("You were given NO transcript"), "and none of the audio");
  assert.ok(src.includes("IMPORTANT:"), "under a heading, where an instruction is obeyed");
  ok("a poster, or a task with nothing uploaded, gets a caption instead of an error");
}

/* ------------------------------------------------------------------ *
 * And returns what the second writer was kept for
 * ------------------------------------------------------------------ */
{
  const schema = ai.CAPTION_SCHEMA;
  for (const key of ["alternate_captions", "cta", "seo_keywords"]) {
    assert.ok(schema.properties[key], `the schema declares ${key}`);
    assert.ok(schema.required.includes(key), `and requires ${key}, as strict mode insists`);
  }

  const src = read("lib/video-ai.ts");
  assert.ok(src.includes('"alternate_captions": ['), "the prompt asks for the alternates");
  assert.ok(
    src.includes("They are\nthere so a caption can be *chosen* rather than regenerated."),
    "and says what they are for, which is why they matter"
  );

  /*
   * The alternates are one click from being the caption, so an invented
   * phone number surviving in one is exactly as bad as one surviving in the
   * main copy — and much easier to miss, because nobody reads five captions
   * as carefully as they read one.
   */
  assert.ok(
    src.includes(".map((alt) => correctPhones(alt, phones, ctx?.phone ?? null).caption)"),
    "and every one of them gets the same invented-number check as the caption"
  );
  ok("choosing an alternate is safe, and costs nothing");
}

/* ------------------------------------------------------------------ *
 * A studio setting still changes the caption
 * ------------------------------------------------------------------ */
{
  const src = read("lib/video-ai.ts");
  assert.ok(src.includes("export type CaptionOverrides"), "per-run choices have a shape");
  assert.ok(
    src.includes("language: overrides?.language || str(cs.language),"),
    "and beat the client's saved setting for this one caption"
  );
  assert.ok(src.includes("goal: overrides?.goal || null,"), "the goal reaches the brief");
  assert.ok(src.includes("length: overrides?.length || null,"), "so does the length");
  /*
   * A caption carrying a phone number the client asked not to publish is not
   * a matter of style, so the box that turns them off is a rule rather than a
   * hint, and it gives the caption somewhere else to end.
   */
  assert.ok(src.includes("const NO_CONTACT = ["), "and the no-contact box is stated as a rule");
  assert.ok(src.includes('End with "DM us" or "link in bio" instead.'), "with an ending to use instead");

  const actions = read("app/(app)/deliverables/actions.ts");
  assert.ok(
    actions.includes('includeContact: formData.get("include_contact") !== "off",'),
    "and the studio's own box is what sets it"
  );
  ok("the studio's per-caption choices survived the merge");
}

await finish(pass);
