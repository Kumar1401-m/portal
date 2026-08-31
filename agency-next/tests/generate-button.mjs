/**
 * "Generate with AI", using the writer that can actually see the video.
 *
 * The portal has two caption writers and they are not equal.
 *
 *   The video writer reads a dozen high-detail frames of the finished cut,
 *   hears the transcript, applies the client's brand rules and reproduces
 *   their agreed caption structure, at the highest reasoning effort the
 *   portal buys anywhere.
 *
 *   The brief writer reads what somebody typed into the task weeks ago, at
 *   medium effort, and has never heard of the caption structure.
 *
 * The button in the task modal called the second one — always, including on a
 * task with the finished video sitting in the panel directly beneath it. So
 * "Generate with AI" wrote about the plan rather than about the reel, and the
 * structure agreed with the client was ignored, and nothing said so: the
 * caption came back fluent and confident either way.
 *
 * The brief writer stays for the two cases where it is the only option — a
 * poster, and a task with nothing uploaded yet.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const ai = await import(pathToFileURL(`${SRC}/lib/video-ai.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * The button picks the writer that can see
 * ------------------------------------------------------------------ */
{
  const modal = read("app/(app)/deliverables/edit-video-modal.tsx");

  assert.ok(
    modal.includes("if (!isPoster && (d.cloud_video_link || d.edited_link)) {"),
    "a task with a video goes to the video writer"
  );
  assert.ok(modal.includes("await fromVideo();"), "which is the analysis, not the brief");
  assert.ok(
    modal.includes("const res = await generateCaptionAction({ ok: false }, fd);"),
    "and a poster, or a task with nothing uploaded, still gets the brief writer"
  );

  /*
   * Polled, not awaited once. It runs as several steps across about half a
   * minute and a serverless function can be killed partway through any of
   * them, so each call does what it safely can and says whether more remains.
   */
  const pollAt = modal.indexOf("if (!res.more) return;");
  const waitAt = modal.indexOf("await new Promise((r) => setTimeout(r, 2500));");
  assert.ok(pollAt > 0 && waitAt > pollAt, "and it is polled until it says it is finished");
  assert.ok(modal.includes("const CAPTION_POLLS = 12;"), "with a ceiling, so nothing spins forever");
  ok("the button writes from the video whenever there is a video to write from");
}

/* ------------------------------------------------------------------ *
 * And says what a regenerate costs
 * ------------------------------------------------------------------ */
{
  const modal = read("app/(app)/deliverables/edit-video-modal.tsx");

  assert.ok(modal.includes("Regenerate: 3 times per video, per 48 hours."), "the rule is stated up front");
  assert.ok(
    modal.includes("`${left} of 3 regenerations left in this 48 hours.`"),
    "and counts down once a run has reported"
  );
  assert.ok(
    modal.includes("No regenerations left for 48 hours"),
    "and says so plainly when there are none"
  );

  /*
   * Disabled as well as explained. Left enabled, the fourth press reaches the
   * server, is refused there, and comes back as a red failure — which reads
   * as something being broken rather than as a limit working.
   */
  assert.ok(
    modal.includes("disabled={captioning || left === 0}"),
    "the button turns off rather than failing on the press"
  );
  ok("the limit is on screen before it is hit, not reported after");
}

/* ------------------------------------------------------------------ *
 * The number is the real one
 * ------------------------------------------------------------------ */
{
  const clean = async () => {
    await db.execute(
      "DELETE va FROM video_analysis va JOIN deliverables d ON d.id = va.deliverable_id WHERE d.title = 'ZZ budget shown'"
    );
    await db.execute("DELETE FROM deliverables WHERE title = 'ZZ budget shown'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ budget shown'");
  };
  await clean();

  const cid = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ budget shown','active')")).insertId
  );
  const did = Number(
    (await db.execute(
      "INSERT INTO deliverables (client_id, title, status) VALUES (?, 'ZZ budget shown', 'editing')",
      [cid]
    )).insertId
  );

  try {
    await db.execute("INSERT INTO video_analysis (deliverable_id, state) VALUES (?, 'queued')", [did]);

    const hour = 60 * 60 * 1000;
    const setLog = (times) =>
      db.execute("UPDATE video_analysis SET gen_log = ? WHERE deliverable_id = ?", [
        JSON.stringify(times.map((t) => new Date(t).toISOString())),
        did,
      ]);

    assert.deepEqual(
      await ai.captionBudget(did),
      { used: 0, left: 3, limit: 3 },
      "a fresh video has all three"
    );

    await setLog([Date.now() - hour, Date.now() - 2 * hour]);
    assert.deepEqual(
      await ai.captionBudget(did),
      { used: 2, left: 1, limit: 3 },
      "two spent leaves one"
    );

    await setLog([Date.now() - hour, Date.now() - 2 * hour, Date.now() - 3 * hour]);
    assert.deepEqual(await ai.captionBudget(did), { used: 3, left: 0, limit: 3 }, "three leaves none");

    // Older than the window: they do not count, and the screen must not go on
    // saying zero to somebody who is entitled to three.
    await setLog([Date.now() - 50 * hour, Date.now() - 60 * hour, Date.now() - 70 * hour]);
    assert.deepEqual(
      await ai.captionBudget(did),
      { used: 0, left: 3, limit: 3 },
      "and the window really is a window"
    );

    // What the screen reads comes from the same call the refusal does, so the
    // two cannot disagree about whether a press will work.
    const actions = read("app/(app)/editor/actions.ts");
    assert.ok(
      actions.includes("const budget = await captionBudget(deliverableId);"),
      "the reply carries the same count the limit is enforced from"
    );
    assert.ok(actions.includes("left: budget.left,"), "and hands it to the screen");
    ok("what the box says is what the server will actually allow");
  } finally {
    await clean();
  }
}


/* ------------------------------------------------------------------ *
 * One line about what it is doing, and it does not die halfway
 * ------------------------------------------------------------------ */
{
  const studio = read("app/(app)/deliverables/[id]/caption-studio.tsx");

  /*
   * A caption takes the better part of a minute \u2014 a dozen frames read at the
   * highest thinking the portal buys. A spinner that says nothing for that
   * long reads as a hung page, and three things all saying "generating" reads
   * as three things going on.
   */
  assert.ok(studio.includes("const [step, setStep] = useState<string | null>(null);"), "there is a step");
  assert.ok(studio.includes("setStep(res.message ?? "), "which is whatever the job says it is doing");
  assert.equal(
    studio.split("animate-spin").length - 1,
    3,
    "a spinner on each of the two buttons and one on the line, and nothing else"
  );
  assert.ok(!studio.includes("Generating\u2026"), "the button does not narrate what the line already says");

  /*
   * Polled, and that is not only about the message: the writer runs as
   * several steps and a serverless function can be killed partway through any
   * of them. A single long request returns nothing at all, having spent one
   * of the three regenerations this video gets in 48 hours.
   */
  assert.ok(
    studio.includes("finishAnalysisAfterUpload(deliverableId, i === 0, overrides)"),
    "it polls the same job the uploader and the modal poll"
  );
  assert.ok(studio.includes("const CAPTION_POLLS = 12;"), "with a ceiling, so nothing spins for ever");
  assert.ok(!studio.includes("generateCaptionAction"), "and no longer runs it as one long request");

  /*
   * And the selects above the button still change the caption. Losing them in
   * the rewrite would have left a row of controls that look like they do
   * something and do not.
   */
  for (const f of ["tone", "language", "goal", "length"]) {
    assert.ok(studio.includes(`fd.get("${f}")`), `the ${f} choice still travels with the run`);
  }
  assert.ok(
    studio.includes('includeContact: fd.get("include_contact") !== null'),
    "and so does the contact-details box"
  );

  const actions = read("app/(app)/editor/actions.ts");
  assert.ok(
    actions.includes("const result = await runAnalysis(deliverableId, overrides);"),
    "which reach the writer"
  );
  ok("the studio says one true thing while it works, and survives a long video");
}


await finish(pass);