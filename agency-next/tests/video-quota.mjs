/**
 * Running out of Gemini quota is a wait, not a failure.
 *
 * The free tier allows twenty generations and the API says exactly how long to
 * wait — "Please retry in 28.4s". The job cleared its lease and requeued, so
 * the next run asked again immediately, was refused again, and wrote a second
 * identical error under the first. The card showed the same paragraph twice
 * beside the word Failed, for a video that would have captioned itself half a
 * minute later.
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const src = readFileSync(`${SRC}/lib/video-ai.ts`, "utf8");
const ai = await import(pathToFileURL(`${SRC}/lib/video-ai.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- it is recognised ---------------- */
{
  const line = src.split("const outOfQuota =")[1]?.split(";")[0] ?? "";
  assert.ok(line.includes("429"), "the status Gemini actually returns");
  for (const word of ["quota", "rate", "too many requests"]) {
    assert.ok(line.toLowerCase().includes(word), `and the wording, for "${word}"`);
  }
  ok("an exhausted quota is told apart from a broken video");
}

/* ---------------- and it is not retried into the ground ---------------- */
{
  /*
   * The lease is the back-off. A claimed job is not re-claimed until it
   * expires, so leaving `locked_at` alone holds the job without needing a
   * retry-after column, a scheduler change, or anything else new.
   */
  assert.ok(
    src.includes("if (!outOfQuota) patch.locked_at = null;"),
    "the lease is released on an ordinary error and held on a quota one"
  );
  // The claim is what the held lease defeats — if that guard ever goes, so does this.
  assert.match(
    src,
    /locked_at IS NULL OR locked_at < DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)/,
    "and the claim still refuses a job whose lease is live"
  );
  ok("a quota error holds its lease instead of asking again at once");
}

/* ---------------- and it does not read as broken ---------------- */
{
  assert.match(
    src,
    /Out of Gemini quota for now — this will try itself again shortly/,
    "the card says it is waiting, not that the video failed"
  );
  // "Failed" stays for the things that genuinely are.
  assert.ok(
    src.includes('out.error.code === 400 || /not available|not found/i.test(message)'),
    "a bad request or a missing model is still permanent"
  );
  ok("waiting for quota reads as waiting");
}

/* ---------------- and the next model is tried before giving up ---------------- */
{
  /*
   * The refusal is about one model, and the reply says which: `limit: 20,
   * model: gemini-3.7-flash`. A different model has its own untouched
   * allowance, so the caption can still arrive today rather than tomorrow.
   */
  assert.ok(src.includes("const VIDEO_MODELS = ["), "there is a list, not one model");
  assert.ok(
    src.includes("for (const model of VIDEO_MODELS) {"),
    "and the call walks it"
  );
  assert.ok(
    src.includes("GEMINI_VIDEO_FALLBACKS"),
    "the fallbacks are configurable without a deploy"
  );

  // Only on quota. A video Gemini cannot read is a video none of them can
  // read, and walking the list to be told so three times costs three uploads.
  const loop = src.split("for (const model of VIDEO_MODELS) {")[1].split("}")[0];
  assert.ok(loop.includes("if (!out.error) break;"), "a success stops the loop");
  assert.ok(
    loop.includes("if (!quota && !gone) break;"),
    "and so does any error that is neither quota nor a retired model"
  );

  // The lite model takes no video, so it must not be a fallback for this.
  const list = src.split("const VIDEO_MODELS = [")[1].split("];")[0];
  assert.ok(!list.includes("flash-lite"), "the caption studio's model is not on the list");

  /*
   * Checked against the live API, not chosen from memory. `gemini-2.0-flash`
   * was the fallback here and had already been retired — so the chain that
   * existed to survive a quota error died on its first hop and behaved
   * exactly like having no fallback at all.
   */
  assert.ok(!list.includes("gemini-2.0"), "no model that Google has already retired");

  assert.ok(src.includes("model = ?"), "and the row records which model answered");
  ok("a model out of quota hands over to one that is not");
}

/* ---------------- a retired model is not the end of the chain ---------------- */
{
  const loop = src.split("for (const model of VIDEO_MODELS) {")[1].split("}")[0];
  assert.ok(loop.includes("const gone ="), "a withdrawn model is recognised");
  assert.ok(loop.includes("if (!quota && !gone) break;"), "and hands on to the next one");

  /*
   * Only the last error survives the loop, and the last model may be the
   * retired one — which classifies as permanent and marks the job failed, for
   * a video whose only problem was that today's allowance had run out.
   */
  assert.ok(src.includes("let sawQuota = false;"), "a quota refusal is remembered across the loop");
  assert.ok(
    src.includes("!sawQuota && (out.error.code === 400"),
    "and a run that hit quota is never marked permanently failed"
  );
  ok("a run that ran out of quota comes back tomorrow instead of dying");
}

/* ---------------- and the give-up budget is not spent on waiting ---------------- */
{
  /*
   * Four attempts ends a job for good. The claim raises the count before
   * anything is known, so every quota refusal spent one — and a video that
   * had used them, for reasons long since fixed, was marked failed on the
   * next run before Gemini was called at all. The button appeared to do
   * nothing, and no amount of deploying could change it, because nothing
   * that was deployed ever ran.
   */
  assert.ok(
    src.includes("attempts = GREATEST(attempts - 1, 0)"),
    "a refusal that burned no tokens gives its attempt back"
  );
  const upsert = src.split("ON DUPLICATE KEY UPDATE state = 'queued'")[1].split("`")[0];
  assert.ok(upsert.includes("attempts = 0"), "and asking again starts the budget over");
  ok("waiting for quota never uses up the attempts meant for real failures");
}

/* ---------------- asking again revives a failed job ---------------- */
{
  /*
   * The one that made every other fix here invisible.
   *
   * The button sends `force` only when there is a finished caption to
   * rewrite, so a failed job always took the other branch — which was a
   * deliberate no-op, to avoid restarting a video already being analysed. So
   * nothing could revive a failure: the state stayed failed, the attempts
   * stayed spent, and the same error came back for ever, however many times
   * the underlying cause was fixed and deployed.
   */
  const clean = async () => {
    await db.execute("DELETE FROM video_analysis WHERE deliverable_id IN (SELECT id FROM deliverables WHERE title = 'ZZ revive')");
    await db.execute("DELETE FROM deliverables WHERE title = 'ZZ revive'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ revive'");
  };
  await clean();
  const cid = Number((await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ revive','active')")).insertId);
  const did = Number((await db.execute("INSERT INTO deliverables (client_id, title, status) VALUES (?,'ZZ revive','editing')", [cid])).insertId);
  try {
    await db.execute(
      "INSERT INTO video_analysis (deliverable_id, state, attempts, last_error) VALUES (?, 'failed', 9, 'out of quota')",
      [did]
    );

    // The plain ask — the one the button actually makes for a failure.
    await ai.queueAnalysis(did);
    const [row] = await db.query("SELECT state, attempts, last_error FROM video_analysis WHERE deliverable_id = ?", [did]);
    assert.equal(row.state, "queued", "a failed job is put back in the queue");
    assert.equal(Number(row.attempts), 0, "with its budget restored");
    assert.equal(row.last_error, null, "and the old error cleared");

    // A job in flight is left alone — that is what the no-op was protecting.
    await db.execute("UPDATE video_analysis SET state = 'processing', attempts = 2 WHERE deliverable_id = ?", [did]);
    await ai.queueAnalysis(did);
    const [live] = await db.query("SELECT state, attempts FROM video_analysis WHERE deliverable_id = ?", [did]);
    assert.equal(live.state, "processing", "a running analysis is not restarted");
    assert.equal(Number(live.attempts), 2, "nor its attempts reset under it");
  } finally {
    await clean();
  }
  ok("a failed analysis can be asked again; a running one cannot be disturbed");
}

await finish(pass);
