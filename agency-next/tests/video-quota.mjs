/**
 * A rate limit is a wait, not a failure.
 *
 * The lesson survived changing provider, which is why this file did. On the
 * old free tier the model refused twenty generations in and the job cleared
 * its lease and requeued, so the next run asked again immediately, was refused
 * again, and wrote a second identical error under the first — the card showed
 * the same paragraph twice beside the word Failed, for a video that would have
 * captioned itself half a minute later.
 *
 * Nothing about that was Gemini-specific. Every provider rate-limits, every
 * provider has bad minutes, and a background job with a four-attempt budget
 * can still destroy itself on refusals that read no video and burned no
 * tokens. These checks hold the three rules that stop it:
 *
 *   a refusal that could work later is not a permanent failure
 *   it does not spend an attempt
 *   and it holds its lease rather than asking again at once
 */
import assert from "node:assert/strict";
import { finish } from "./finish.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.PORTAL_SRC;
const src = readFileSync(`${SRC}/lib/video-ai.ts`, "utf8");
const client = readFileSync(`${SRC}/lib/model.ts`, "utf8");
const ai = await import(pathToFileURL(`${SRC}/lib/video-ai.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ---------------- it is recognised, in one place ---------------- */
{
  /*
   * Decided by the client rather than by each caller sniffing error strings.
   * Four callers each with their own idea of what "temporary" means is how
   * they came to disagree, and the one that got it wrong was the background
   * job — the only one where being wrong is permanent.
   */
  assert.ok(
    client.includes("retriable: res.status === 429 || res.status >= 500"),
    "a rate limit and a provider outage are the retriable ones"
  );
  assert.ok(
    client.includes('"The model took too long to answer."') && client.includes("const aborted = err instanceof Error && err.name === \"AbortError\""),
    "and so is a timeout"
  );
  assert.ok(
    /aborted[\s\S]{0,200}retriable: true/.test(client),
    "which is marked as such rather than failing the job"
  );
  ok("a refusal that could work later is told apart from one that never will");
}

/* ---------------- a bad key is not waited out ---------------- */
{
  /*
   * The other half, and the one that is easy to lose. If everything were
   * retriable, a wrong key would queue for ever and the card would say
   * "trying again" until somebody read the logs. 401 and 400 are answers,
   * not weather.
   */
  assert.ok(
    src.includes('await setState(deliverableId, res.retriable ? "queued" : "failed"'),
    "an answer that will not change marks the job failed"
  );
  assert.ok(
    src.includes("more: res.retriable"),
    "and only a retriable one tells the caller to come back"
  );
  ok("a permanent refusal fails fast instead of retrying for ever");
}

/* ---------------- and the give-up budget is not spent on waiting ---------------- */
{
  /*
   * Four attempts ends a job for good. The claim raises the count before
   * anything is known, so every rate-limited call spent one — and a video that
   * had used them, for reasons long since fixed, was marked failed on the next
   * run before the model was called at all. The button appeared to do nothing,
   * and no amount of deploying could change it, because nothing that was
   * deployed ever ran.
   */
  assert.ok(
    src.includes("attempts = GREATEST(attempts - 1, 0)"),
    "a refusal that burned no tokens gives its attempt back"
  );
  assert.ok(
    /if \(res\.retriable\) \{[\s\S]{0,200}attempts = GREATEST/.test(src),
    "and only a retriable one — a real failure still costs an attempt"
  );
  const upsert = src.split("ON DUPLICATE KEY UPDATE state = 'queued'")[1].split("`")[0];
  assert.ok(upsert.includes("attempts = 0"), "and asking again starts the budget over");
  ok("waiting for a rate limit never uses up the attempts meant for real failures");
}

/* ---------------- the lease is the back-off ---------------- */
{
  assert.match(
    src,
    /locked_at IS NULL OR locked_at < DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)/,
    "the claim refuses a job whose lease is still live"
  );
  ok("two runs cannot analyse the same video at once");
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
