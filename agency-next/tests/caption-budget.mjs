/**
 * What a caption costs, and what it is worth without one.
 *
 * Three things that failed in the same afternoon, and are one story.
 *
 * ## The reply that "was not JSON"
 *
 * A reasoning model spends its output budget on thinking *and* writing. Run
 * out mid-sentence and the response still carries a message item holding
 * however much was written — so the text is not empty, it is half a JSON
 * object. The parse failed and the error blamed the schema, which was the one
 * part working correctly. Checked live against the real API: a truncated
 * response comes back `status: "incomplete"` with
 * `incomplete_details.reason: "max_output_tokens"` and a `message` item.
 *
 * ## Three captions per video per 48 hours
 *
 * A generation reads a dozen high-detail frames at the highest reasoning
 * effort the portal buys anywhere, and there is a Regenerate button beside
 * it. Three is enough to get one reel's copy right.
 *
 * ## And a video with no caption is not ready to be approved
 *
 * A post is the video and its words. Sent without them the client approves a
 * clip, and the copy that goes out under it on their feed is copy they were
 * never shown.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const wa = await import(pathToFileURL(`${SRC}/lib/whatsapp-approvals.ts`).href);
const ai_mod = await import(pathToFileURL(`${SRC}/lib/video-ai.ts`).href);
const db = await import(pathToFileURL(`${SRC}/lib/db.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * A cut-off reply is a budget problem, not a schema problem
 * ------------------------------------------------------------------ */
{
  const src = read("lib/model.ts");

  const incompleteAt = src.indexOf('candidate?.finishReason && candidate.finishReason !== "STOP"');
  const parseAt = src.indexOf("JSON.parse(text)");
  assert.ok(incompleteAt > 0, "a cut-off reply is recognised");
  assert.ok(parseAt > incompleteAt, "and recognised before the reply is parsed");

  /*
   * The old check only ran when the text was empty, which is exactly when
   * truncation does NOT look like truncation — a partial JSON object is not
   * empty. Guarding it that way is what produced the misleading message.
   */
  assert.ok(
    !src.includes("if (!text.trim()) {\n      const incomplete"),
    "not only when nothing at all came back"
  );
  assert.ok(src.includes("ran out of room while thinking"), "and says what actually happened");
  assert.ok(
    src.includes("The reply was not the JSON it was required to be: ${text.trim().slice(0, 120)}"),
    "a genuine schema failure shows what it got instead"
  );
  ok("a truncated reply reports its budget, not a JSON complaint");
}

/* ------------------------------------------------------------------ *
 * The reply is parsed at all
 * ------------------------------------------------------------------ */
{
  /*
   * The bug this block exists for, and it was total rather than occasional.
   *
   * `ask` only fills in `data` when it is given a schema — without one it
   * returns the text and a null `data`, by design. The caption call passed
   * no schema and asked for JSON in the prompt instead, and `generate` read
   * `res.data` and treated null as a parse failure. So every caption in the
   * portal failed, every time, with "the reply was not the JSON it was
   * required to be" — reported on a reply that was perfectly good JSON that
   * nothing ever parsed.
   */
  const oa = read("lib/model.ts");
  assert.ok(oa.includes("if (!args.schema) return out;"), "no schema means no parsed data");

  const ai = read("lib/video-ai.ts");
  assert.ok(ai.includes("schema: CAPTION_SCHEMA,"), "so the caption call passes one");
  assert.ok(ai.includes('schemaName: "video_caption",'), "named, so a rejection says which one");

  /*
   * And the schema has to be legal for strict mode, which is fussier than
   * JSON Schema: every property must be listed in `required`, and every
   * object must refuse extra ones. Break either and OpenAI answers 400 — the
   * caption fails again, for a reason no screen in the portal would show.
   */
  const walk = (node, where) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, `${where} refuses unknown keys`);
      assert.deepEqual(
        [...(node.required || [])].sort(),
        Object.keys(node.properties || {}).sort(),
        `${where} requires exactly the properties it declares`
      );
      for (const [k, v] of Object.entries(node.properties || {})) walk(v, `${where}.${k}`);
    }
    if (node.type === "array") walk(node.items, `${where}[]`);
  };
  walk(ai_mod.CAPTION_SCHEMA, "caption");

  // What generate() actually reads back off the reply, so a rename cannot
  // quietly leave a field permanently undefined.
  for (const key of ["summary", "spoken_language", "topic", "mood", "has_face", "on_screen_text",
                     "scenes", "hook", "caption", "video_keyword", "branding"]) {
    assert.ok(ai_mod.CAPTION_SCHEMA.properties[key], `the schema declares ${key}`);
  }
  for (const key of ["logo_text", "footer_text", "phone", "website", "handle", "tagline",
                     "business_name_seen"]) {
    assert.ok(
      ai_mod.CAPTION_SCHEMA.properties.branding.properties[key],
      `the branding block declares ${key}`
    );
  }
  ok("the caption reply is made to be JSON, and is actually parsed");
}

/* ------------------------------------------------------------------ *
 * Every value lands in its own column
 * ------------------------------------------------------------------ */
{
  /*
   * This one has to hit MySQL, because MySQL is the only thing that noticed.
   *
   * The finished analysis was written as a SQL string full of `?` and a
   * separate array of values, with two optional groups spliced into each —
   * at different points. So the moment the `has_face` column existed, every
   * value after it shifted one place: the on-screen text went into
   * `scenes_json`, a JSON column, and the write died with
   *
   *   Invalid JSON text: "Invalid value." at position 0
   *
   * naming a column that had nothing wrong with it. Placeholder and value
   * counts matched perfectly, so nothing short of executing it could tell.
   * And it only broke once the database was migrated — the feature failed on
   * the most up-to-date machines and worked on the stale ones.
   */
  const clean = async () => {
    await db.execute(
      "DELETE va FROM video_analysis va JOIN deliverables d ON d.id = va.deliverable_id WHERE d.title = 'ZZ column order'"
    );
    await db.execute("DELETE FROM deliverables WHERE title = 'ZZ column order'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ column order'");
  };
  await clean();

  const cid = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ column order','active')")).insertId
  );
  const did = Number(
    (await db.execute(
      "INSERT INTO deliverables (client_id, title, status) VALUES (?, 'ZZ column order', 'editing')",
      [cid]
    )).insertId
  );

  try {
    await db.execute("INSERT INTO video_analysis (deliverable_id, state) VALUES (?, 'queued')", [did]);

    // The same shape generate() builds, optional columns and all.
    const ONSCREEN = ["GOLD RATE DOWN", "CALL NOW"].join(String.fromCharCode(10));
    const fields = {
      summary: "A jeweller talks about this week's gold rate.",
      spoken_language: "Telugu",
      topic: "Gold rate offer",
      mood: "promotional",
      on_screen_text: ONSCREEN,
      scenes_json: JSON.stringify([{ start: "00:00", end: "00:12", label: "shopfront" }]),
      caption: "Namaste Hyderabad",
      hook: "Gold rate thakkuva ga vachindi",
      hashtags: "#gold #hyderabad",
      raw_json: JSON.stringify({ ok: true }),
      tokens_used: 822,
      duration_ms: 4321,
      model: "gpt-5.5",
      has_face: 1,
      brand_seen: "Name on screen: ZZ Jewellers",
      context_used: "[sources: none]",
      grounded: 0,
    };

    const built = ai_mod.buildCaptionUpdate(did, fields);
    assert.equal(
      built.params.length,
      built.sql.split("= ?").length - 1,
      "one value per placeholder"
    );
    // The write itself is the assertion: a value in the wrong column is a
    // MySQL error, not a wrong answer.
    await db.execute(built.sql, built.params);

    const row = await ai_mod.getAnalysis(did);
    assert.equal(row.state, "done", "the analysis finishes");
    assert.equal(row.spoken_language, "Telugu", "language is in the language column");
    assert.equal(row.on_screen_text, ONSCREEN, "on-screen text stayed put");
    assert.equal(Number(row.has_face), 1, "and the flag that caused the shift is its own column");
    const scenes = typeof row.scenes_json === "string" ? JSON.parse(row.scenes_json) : row.scenes_json;
    assert.equal(scenes[0].label, "shopfront", "the scenes survived as scenes");
    ok("the finished analysis writes every value into the column it belongs to");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * Three per video per 48 hours
 * ------------------------------------------------------------------ */
{
  const clean = async () => {
    await db.execute(
      "DELETE va FROM video_analysis va JOIN deliverables d ON d.id = va.deliverable_id WHERE d.title = 'ZZ caption budget'"
    );
    await db.execute("DELETE FROM deliverables WHERE title = 'ZZ caption budget'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ caption budget'");
  };
  await clean();

  const cid = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ caption budget','active')")).insertId
  );
  const did = Number(
    (await db.execute(
      "INSERT INTO deliverables (client_id, title, status) VALUES (?, 'ZZ caption budget', 'editing')",
      [cid]
    )).insertId
  );

  const setLog = async (times) =>
    db.execute(
      "UPDATE video_analysis SET gen_log = ?, state = 'queued', attempts = 0, locked_at = NULL WHERE deliverable_id = ?",
      [JSON.stringify(times.map((t) => new Date(t).toISOString())), did]
    );

  try {
    await db.execute("INSERT INTO video_analysis (deliverable_id, state) VALUES (?, 'queued')", [did]);

    const hour = 60 * 60 * 1000;
    // Three inside the window: the next ask is refused before anything is
    // fetched, decoded or paid for.
    await setLog([Date.now() - hour, Date.now() - 2 * hour, Date.now() - 3 * hour]);
    const blocked = await ai_mod.runAnalysis(did);
    assert.equal(blocked.ok, false, "a fourth caption in 48 hours is refused");
    assert.match(blocked.error, /limit/i, "and says it is a limit, not a fault");

    /*
     * The refusal has to be visible on the row, not only in the reply. The
     * upload polls this job and would otherwise sit on "writing the
     * caption…" against a job nothing is going to run.
     */
    const row = await ai_mod.getAnalysis(did);
    assert.equal(row.state, "failed", "the job stops rather than staying queued");
    assert.match(row.last_error, /48 hours/, "with the reason on the row");

    // The same three, but old enough to have fallen out of the window.
    await setLog([Date.now() - 50 * hour, Date.now() - 60 * hour, Date.now() - 70 * hour]);
    const allowed = await ai_mod.runAnalysis(did);
    // Matched on our own words, not on "limit": a provider quota error carries
    // a rate-limits URL, and a test that reads that as our ceiling passes and
    // fails for reasons that have nothing to do with the window.
    assert.ok(
      !/Caption limit reached/.test(allowed.error || ""),
      "captions older than the window do not count"
    );
    ok("one video gets three captions in 48 hours, and the fourth is refused before it costs anything");

    /*
     * Only a caption that was actually written counts. A rate limit or a
     * timeout produced nothing usable, and charging it against the three
     * would leave a video with no caption and no way left to ask for one.
     */
    const srcAi = read("lib/video-ai.ts");
    const recordAt = srcAi.indexOf("await recordCaption(deliverableId);");
    const doneAt = srcAi.indexOf('    state: "done",');
    assert.ok(recordAt > 0 && doneAt > recordAt, "the count is written on the success path only");
    assert.ok(
      srcAi.includes('if (!(await hasColumn("video_analysis", "gen_log"))) return 0;'),
      "and a database without the column captions videos rather than refusing to"
    );
    ok("a failed generation costs no part of the budget");
  } finally {
    await clean();
  }
}

/* ------------------------------------------------------------------ *
 * Nothing goes to a client without the words
 * ------------------------------------------------------------------ */
{
  const clean = async () => {
    await db.execute("DELETE FROM deliverables WHERE title = 'ZZ no caption yet'");
    await db.execute("DELETE FROM clients WHERE company_name = 'ZZ no caption yet'");
  };
  await clean();

  const cid = Number(
    (await db.execute("INSERT INTO clients (company_name, status) VALUES ('ZZ no caption yet','active')")).insertId
  );
  const did = Number(
    (await db.execute(
      `INSERT INTO deliverables (client_id, title, status, cloud_video_url, caption)
       VALUES (?, 'ZZ no caption yet', 'editing', 'https://example.com/z.mp4', NULL)`,
      [cid]
    )).insertId
  );

  try {
    const res = await wa.prepareSend(did);
    assert.equal(res.ok, false, "a video with no caption cannot be sent for approval");
    assert.match(res.error, /no caption/i, "and the reason names the caption");

    /*
     * Checked in prepareSend rather than in the button, because every way of
     * asking a client — the panel, the bulk send, the reminder that chases an
     * unanswered one — goes through here, and a rule written in one caller is
     * a rule the other callers do not have.
     */
    const src = read("lib/whatsapp-approvals.ts");
    const gateAt = src.indexOf("This video has no caption yet");
    const codeAt = src.indexOf("const videoCode = await ensureVideoCode(deliverableId);");
    assert.ok(gateAt > 0 && codeAt > gateAt, "the gate is in the shared path, before the send is built");
    /*
     * And the button is off, not merely error-prone.
     *
     * A missing group or a missing video fails loudly inside WhatsApp. A
     * missing caption does not fail at all: the video goes, the client replies
     * OK, and what they approved was a clip — while the words that publish
     * underneath it are words they were never shown.
     */
    const panel = read("app/(app)/deliverables/[id]/send-approval.tsx");
    assert.ok(panel.includes("hasCaption: boolean;"), "the panel is told whether there is one");
    assert.ok(
      panel.includes("const blocked = !panel.hasGroup || !panel.hasVideo || !panel.hasCaption;"),
      "and a video without one cannot be sent from the screen either"
    );
    assert.ok(panel.includes("No caption yet."), "with the reason said, not just the button greyed");
    /*
     * Composed the same way the message composes it — and excused the same
     * way the send excuses it. A poster has no caption to wait for, because
     * its words are on the design; requiring one held every poster back with a
     * message asking for something no part of this portal would ever write.
     */
    assert.ok(
      src.includes("hasCaption: isPosterWork(d) || Boolean(composeCaption(d.caption, d.hashtags).trim()),"),
      "and the button decides it the same way the message composes it"
    );
    assert.ok(
      src.includes("if (!isPosterWork(d) && !composeCaption(d.caption, d.hashtags).trim()) {"),
      "the send excusing a poster and holding a video back"
    );
    ok("the client is never asked to approve a video without its caption");
  } finally {
    await clean();
  }
}

await finish(pass);
