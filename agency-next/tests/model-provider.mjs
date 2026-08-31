/**
 * The one module that knows whose model this is.
 *
 * The portal has now been an OpenAI client and a Gemini one, and each swap was
 * a rewrite of `model.ts` and nothing else — no caption path, no assistant, no
 * WhatsApp route had to change either time. These checks are what keep that
 * true, and hold the handful of things about the video pipeline that are
 * quietly easy to get wrong.
 *
 * ## The pipeline does not assume a model can watch a video
 *
 * It was built that way because one provider could not, and it stays that way
 * because it is better: the browser decodes frames at upload time — it is
 * holding the file, it has a hardware decoder, and the portal runs on
 * serverless functions with no ffmpeg — and the sound track goes across as
 * audio. Nothing here depends on whether the model behind it happens to accept
 * video this month.
 *
 * What that leaves worth checking:
 *
 *   - frames must span the WHOLE video, because the branding lock-up is in the
 *     last second and nowhere else
 *   - the last frame must not be at exactly `duration`, which often renders
 *     blank
 *   - an analysis with no frames must fall back to the transcript rather than
 *     failing, and must SAY it saw nothing rather than describing what it did
 *     not see
 *   - the JSON Schema the callers write must be translated into the dialect
 *     this API takes, or every caption fails on a 400 naming a field no screen
 *     shows
 *   - one key live: a dead call site is a compile error and gets noticed; a
 *     live API key left in `.env` is a bill nobody is watching
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const load = (p) => import(pathToFileURL(`${SRC}/${p}`).href);
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");

const frames = await load("lib/frames.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * The frames cover the whole video
 * ------------------------------------------------------------------ */
{
  const times = frames.frameTimes(30, 12);
  assert.equal(times.length, 12, "twelve frames from a thirty-second reel");

  // Ordered, and strictly increasing — the prompt tells the model frame 1 is
  // the opening and the last is the ending, so the order is load-bearing.
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], `frame ${i} comes after frame ${i - 1}`);
  }

  /*
   * The end of the video is where the branding is, and it is the single thing
   * this feature is most often asked to read. A sampler that stops at the
   * halfway mark would look like it worked and would never once find a footer.
   */
  assert.ok(times[times.length - 1] > 29, "the last frame is in the final second");
  assert.ok(times[0] < 1, "and the first is in the opening second");

  /*
   * But not AT the ends. Seeking to exactly 0 can land on a black leader and
   * exactly `duration` frequently fails to render at all — either would spend
   * one of twelve frames on a blank rectangle.
   */
  assert.ok(times[0] > 0, "never exactly zero");
  assert.ok(times[times.length - 1] < 30, "never exactly the duration");
  ok("frames are sampled across the whole runtime, in order, ends nudged inward");
}

{
  // Degenerate inputs come from real files: a stream with no duration, a
  // still-image "video", a browser that reports NaN.
  assert.deepEqual(frames.frameTimes(0, 12), [0], "a zero-length video gives one frame");
  assert.deepEqual(frames.frameTimes(NaN, 12), [0], "so does an unknown duration");
  assert.equal(frames.frameTimes(10, 1).length, 1, "one frame is the middle, not a crash");
  ok("a video with no usable duration still yields something to look at");
}

/* ------------------------------------------------------------------ *
 * Downscaling never enlarges
 * ------------------------------------------------------------------ */
{
  const big = frames.fitWithin(3840, 2160, 960);
  assert.equal(big.w, 960, "a 4K master is scaled to the long edge");
  assert.equal(big.h, 540, "and keeps its aspect ratio");

  const portrait = frames.fitWithin(1080, 1920, 960);
  assert.equal(portrait.h, 960, "a reel is scaled by its height");
  assert.equal(portrait.w, 540, "which is the long edge on a vertical video");

  const small = frames.fitWithin(320, 240, 960);
  assert.deepEqual(small, { w: 320, h: 240 }, "a small video is never blown up");
  ok("frames are downscaled to a readable size and never upscaled");
}

/* ------------------------------------------------------------------ *
 * A missing half is declared, not imagined
 * ------------------------------------------------------------------ */
{
  const src = read("lib/video-ai.ts");

  assert.ok(
    src.includes("You were given NO frames — say nothing about what is on screen."),
    "with no frames it is told so in as many words"
  );
  assert.ok(
    src.includes("You were given NO transcript"),
    "and the same when there was nothing to hear"
  );
  /*
   * The failure mode this prevents is the expensive one. A model shown no
   * frames and not told so writes a confident paragraph about the visuals,
   * drawn from the title and the transcript — and it reads exactly like a
   * model that watched the video.
   */
  /*
   * With neither, it writes from the brief and says that is all it had.
   *
   * It used to refuse, and refusing is what forced the portal to keep a
   * second caption writer for the ordinary cases a refusal cannot serve — a
   * poster, and a task whose video is not uploaded yet. Two writers meant two
   * prompts and two sets of brand rules, and which caption you got depended
   * on which button you pressed.
   *
   * What must never be dropped is the telling. A model shown no frames and
   * not told so writes a confident paragraph about the visuals, drawn from
   * the title and the transcript, and it reads exactly like a model that
   * watched the video.
   */
  assert.ok(
    !src.includes("Nothing to analyse"),
    "having neither is a thinner brief, not a failure"
  );
  const missingAt = src.indexOf("const missing: string[] = [];");
  const noteAt = src.indexOf("missingNote");
  assert.ok(missingAt > 0 && noteAt > missingAt, "and what was missing reaches the prompt");
  assert.ok(src.includes("IMPORTANT:"), "under a heading it cannot skim past");
  ok("the model is told what it was not given, and writes from what it was");

  assert.ok(
    src.includes('detail: "high" as const'),
    "frames are sent at full detail — the job is reading small text"
  );
  assert.ok(src.includes('effort: "high"'), "and it is the one place that thinks hardest");
  ok("reading a logo off a frame is given the resolution and the thinking to do it");
}

/* ------------------------------------------------------------------ *
 * The transcript is bought once
 * ------------------------------------------------------------------ */
{
  const src = read("lib/video-ai.ts");
  assert.ok(
    src.includes("UPDATE video_analysis SET transcript = ? WHERE deliverable_id = ?"),
    "the transcript is stored the moment it arrives"
  );
  assert.ok(
    src.includes("if (transcript === null)"),
    "and a retry with one already stored never pays again"
  );
  /*
   * `=== null` rather than a falsy check, and that is the whole point: a video
   * with no speech in it transcribes to an empty string, which is a real
   * answer. Treating it as "not done yet" would re-transcribe a silent video
   * on every single retry.
   */
  assert.ok(
    !src.includes("if (!transcript) {\n    const linked"),
    "a silent video is a transcribed video, not an untranscribed one"
  );
  ok("transcription is paid for once per video");
}

/* ------------------------------------------------------------------ *
 * One provider
 * ------------------------------------------------------------------ */
{
  /*
   * Everything goes through model.ts, and nothing else knows whose model it
   * is. That is what made this swap a rewrite of one file: the portal has now
   * been an OpenAI client and a Gemini one, and no caption, assistant or
   * WhatsApp path had to be touched either time.
   */
  for (const p of [
    "lib/ai.ts",
    "lib/assistant.ts",
    "lib/video-ai.ts",
    "lib/whatsapp-ai.ts",
    "lib/ai-engines.ts",
    "app/api/whatsapp/intent/route.ts",
    "app/api/whatsapp/transcribe/route.ts",
  ]) {
    const src = read(p);
    assert.ok(
      !/generativelanguage|api\.openai\.com/.test(src),
      `${p} does not call a provider itself`
    );
  }
  ok("one module talks to the model, and the rest of the portal does not know which");

  /*
   * And only one key is live.
   *
   * A dead call site is a compile error and gets noticed. A live API key left
   * in `.env` is neither — it just sits there, still valid, still billable,
   * still in every backup of the file.
   */
  const envPath = `${SRC}/../.env.local`;
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, "utf8");
    assert.ok(/^GEMINI_API_KEY=.+/m.test(env), "the Gemini key is in .env.local");
    assert.ok(!/^OPENAI_API_KEY=.+/m.test(env), "and the OpenAI one is out of it");
    ok("the environment holds one key, for the one provider");
  }
}
/* ------------------------------------------------------------------ *
 * One place that knows how to ask
 * ------------------------------------------------------------------ */
{
  const client = read("lib/model.ts");
  assert.ok(client.includes(":generateContent"), "one endpoint, carrying text, images and audio together");
  assert.ok(
    client.includes("generationConfig.thinkingConfig = { thinkingLevel: THINKING[args.effort] }"),
    "effort is per call"
  );
  assert.ok(
    client.includes('generationConfig.responseMimeType = "application/json"'),
    "and a schema is enforced, not requested"
  );

  /*
   * The schema has to be translated, and the differences are not cosmetic:
   * this API rejects `additionalProperties` outright, has no union types, and
   * does not imply key order from `properties`. A schema it does not
   * understand is a 400 with a field path, which reaches a person as a failed
   * caption and nothing else.
   */
  const g = client.includes("export function toGeminiSchema");
  assert.ok(g, "a JSON Schema is converted to the dialect this API takes");

  /*
   * Retriable is the field that stops a background job destroying itself. The
   * analyser gives up after four attempts; without this, four rate limits in
   * a minute would exhaust that budget on a video nobody had looked at yet.
   */
  assert.ok(client.includes("retriable: res.status === 429 || res.status >= 500"), "and a rate limit is not a refusal");
  assert.ok(
    read("lib/video-ai.ts").includes("if (res.retriable) {"),
    "which the analyser reads before spending an attempt"
  );
  ok("every model call goes through one client that knows what is worth retrying");
}

/* ------------------------------------------------------------------ *
 * A client is never left on read
 * ------------------------------------------------------------------ */
{
  const ai = read("lib/whatsapp-ai.ts");
  assert.ok(
    ai.includes('if (text.length > MAX_INBOUND_CHARS) return { reply: true, kind: "hold" };'),
    "a long message gets an answer instead of silence"
  );
  const route = read("app/api/whatsapp/message/route.ts");
  assert.ok(route.includes('gate.kind === "hold"'), "and the route knows to send the holding line");
  assert.ok(
    route.includes('if (quick && gate.kind === "hold")'),
    "with the team notified, so the promise in it is true"
  );
  ok("the longest questions are the ones that used to be ignored, and are not now");
}

/* ------------------------------------------------------------------ *
 * The posting time is learned, once it can be
 * ------------------------------------------------------------------ */
{
  const bt = read("lib/best-time.ts");
  assert.ok(bt.includes("export const MIN_SLOT_POSTS = 3"), "an hour needs three posts behind it");
  /*
   * The second condition is the one that is easy to leave out and impossible
   * to spot afterwards. If every post has gone out at 7 PM, "7 PM is best" is
   * not a finding — it is the only hour with any evidence — and acting on it
   * would pin the schedule to the very habit it was meant to test, for ever,
   * because nothing would ever go out at another hour to disagree.
   */
  assert.ok(bt.includes("if (byHour.length < 2) return null;"), "and a second hour to have beaten");
  assert.ok(
    bt.includes("return { at: nextBestPostTime(country)"),
    "below that it is the country default, exactly as before"
  );
  ok("a learned posting time needs evidence, and a comparison, before it moves anything");

  /*
   * Either directly, or through the one handoff that now decides what an
   * approval sets in motion. The client portal used to call this itself; the
   * call moved into `approvalHandoff` so that the desk and the WhatsApp group
   * could not answer the question differently, and the learned hour is still
   * what a scheduled post gets.
   */
  for (const p of ["app/(app)/deliverables/actions.ts", "app/portal/actions.ts"]) {
    const s = read(p);
    assert.ok(
      s.includes("nextPostTimeFor") || s.includes("approvalHandoff("),
      `${p} schedules through it`
    );
  }
  /*
   * The learned hour is reached through `postingSlotFor` now, which puts it on
   * the day the task is down for rather than on the next one from now. The
   * hour is still this — the day is the part that was being ignored.
   */
  assert.ok(read("lib/instagram.ts").includes("postingSlotFor("), "the approval handoff schedules through it");
  assert.ok(
    bt.includes("const next = await nextPostTimeFor(clientId, country)"),
    "and that is where the learned hour is asked for"
  );
  ok("every place that schedules a post asks the same question");
}


/* ------------------------------------------------------------------ *
 * The schema, in the dialect this API actually takes
 * ------------------------------------------------------------------ */
{
  const m = await load("lib/model.ts");
  const ai = await load("lib/video-ai.ts");
  const g = m.toGeminiSchema(ai.CAPTION_SCHEMA);

  /*
   * Checked live: `additionalProperties` comes back as HTTP 400, "Unknown
   * name \"additionalProperties\" at 'generation_config.response_schema':
   * Cannot find field." Every caption would fail, and the message names a
   * field no screen in the portal shows.
   */
  assert.ok(!JSON.stringify(g).includes("additionalProperties"), "the rejected key is gone");
  assert.equal(g.type, "OBJECT", "types are upper case");
  assert.equal(g.properties.caption.type, "STRING", "all the way down");
  assert.equal(g.properties.hashtags ?? null, null, "and only what the schema declares");

  /*
   * There is no union type here. A JSON Schema ["string","null"] becomes a
   * string with a flag, and getting that wrong means the branding block \u2014
   * whose fields are null whenever a video has no footer \u2014 cannot be answered
   * at all.
   */
  const b = g.properties.branding.properties.phone;
  assert.equal(b.type, "STRING", "a nullable string is still a string");
  assert.equal(b.nullable, true, "with a flag rather than a union");

  // Arrays of objects survive the walk.
  assert.equal(g.properties.scenes.items.type, "OBJECT", "an array of objects converts too");
  assert.deepEqual(
    g.properties.scenes.items.propertyOrdering,
    ["start", "end", "label"],
    "and key order is stated, because it is not implied"
  );
  assert.deepEqual(g.required, ai.CAPTION_SCHEMA.required, "required carries over unchanged");
  ok("a JSON Schema becomes something this API will accept");
}

/* ------------------------------------------------------------------ *
 * Line breaks survive
 * ------------------------------------------------------------------ */
{
  /*
   * Structured output escapes its own newlines a second time, so a caption
   * written as three lines arrives as one line with a literal backslash-n in
   * it. `JSON.parse` has already done its job correctly \u2014 what it produced
   * was two characters.
   *
   * The whole shape of a caption is line breaks: the three lines, the blank
   * line before the contact details, the blank line before the keywords. This
   * is the difference between that and one paragraph with \n printed in it,
   * published on a client's own account.
   */
  const client = read("lib/model.ts");
  assert.ok(client.includes("realNewlines(JSON.parse(text))"), "the parsed reply is repaired");
  assert.ok(
    client.indexOf("function realNewlines") < client.indexOf("realNewlines(JSON.parse"),
    "by a function that walks the whole object, not just the caption"
  );
  ok("a three-line caption arrives as three lines");
}

/* ------------------------------------------------------------------ *
 * A provider error that says what to do about it
 * ------------------------------------------------------------------ */
{
  /*
   * "Captions stopped working" is the report. The cause is almost always the
   * daily allowance on a free-tier Google Cloud project, and Google's own
   * message — "You exceeded your current quota" — reads as "wait a minute".
   * Waiting buys the same small number tomorrow, and nothing in the portal can
   * change that, so the second sentence is the only one worth printing.
   *
   * Same shape as `fixFor` on the ads side, for the same reason: the
   * provider's words name the symptom and never the cure.
   */
  const mp = await load("lib/model.ts");

  const quota = mp.aiFixFor(
    "RESOURCE_EXHAUSTED",
    "You exceeded your current quota, please check your plan and billing details."
  );
  assert.ok(quota, "a quota error carries advice");
  assert.match(quota, /free tier/i, "it names the cause");
  assert.match(quota, /billing/i, "and the one thing that actually fixes it");
  assert.match(quota, /nothing in the portal/i, "and says the portal cannot work around it");

  // Recognised from the message alone too — the status field is not always set.
  assert.ok(mp.aiFixFor(undefined, "Quota exceeded for quota metric"), "the message is enough");

  assert.match(
    mp.aiFixFor("PERMISSION_DENIED", "API key not valid"),
    /Regenerate/,
    "a refused key sends somebody to the right screen"
  );
  assert.match(
    mp.aiFixFor("UNAVAILABLE", "The model is overloaded"),
    /Google's own capacity/,
    "and an outage is not blamed on the key"
  );

  // No invented advice. An error nobody has a cure for gets none, rather than
  // a confident line that sends somebody to change the wrong thing.
  assert.equal(mp.aiFixFor("INTERNAL", "Something went wrong"), undefined, "and silence otherwise");

  const src = read("lib/model.ts");
  assert.ok(src.includes("hint: aiFixFor(err.status,"), "every failed call carries it");
  ok("a provider error arrives with the fix, not just the symptom");
}

await finish(pass);
