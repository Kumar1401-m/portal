/**
 * Making the AI watch a video it was never shown.
 *
 * Frames are decoded in the browser as a video uploads, which covers every
 * video from now on and none of the ones already in the bucket. Those get
 * analysed from their sound track alone — a real answer, and a much weaker
 * one, because everything the branding rules are about (the logo, the footer,
 * the phone number burned into the last frame) exists only in the picture.
 *
 * Worse, it is invisible: a caption written from audio reads exactly like one
 * written from the whole video.
 *
 * Two things fix that, and this holds both.
 *
 * ## The bytes have to come from us
 *
 * Playing a cross-origin video is fine; reading pixels back out of it is not.
 * The moment a cross-origin frame is drawn to a canvas the canvas is tainted
 * and `toDataURL` throws — a browser security rule, not an R2 setting, and not
 * something code in this repo could fix by configuring a bucket. `?bytes=1`
 * serves the same video from the portal's own origin, so the canvas stays
 * clean.
 *
 * ## And the order of the upload is load-bearing
 *
 * Attaching points the task at the new file, and queueing the analysis is what
 * discards the analysis of the video this one replaced. Frames saved before
 * that happens are written onto a row that is about to be deleted — so a
 * Replace produced a caption written with its eyes shut.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * Same-origin bytes, streamed
 * ------------------------------------------------------------------ */
{
  const route = read("app/v/[id]/route.ts");

  assert.ok(route.includes('searchParams.get("bytes") === "1"'), "there is a bytes mode");
  /*
   * Streamed, never buffered. A finished reel is tens of megabytes and
   * holding one in a serverless function's memory to hand it straight back
   * out is how that function runs out of it.
   */
  assert.ok(route.includes("new NextResponse(upstream.body"), "the body is piped, not read into memory");
  assert.ok(
    !/arrayBuffer\(\)|\.blob\(\)/.test(route),
    "and never collected first"
  );

  /*
   * The token check has to come first, and it already does — this asserts the
   * bytes mode did not sneak in above it. A route that serves raw video
   * before checking the token would be a public download link for every
   * client's unreleased work.
   */
  const tokenAt = route.indexOf("verifyVideoToken");
  const bytesAt = route.indexOf('searchParams.get("bytes")');
  assert.ok(tokenAt > 0 && bytesAt > tokenAt, "the token is verified before any bytes are served");
  ok("a stored video can be read from the portal's own origin, and only with its token");
}

/* ------------------------------------------------------------------ *
 * The panel says when the AI has only heard it
 * ------------------------------------------------------------------ */
{
  const panel = read("app/(app)/editor/ai-caption.tsx");

  assert.ok(panel.includes("hasFrames: boolean;"), "the panel is told whether there are frames");
  assert.ok(
    panel.includes("The AI has not seen this video, only heard it."),
    "and says so in as many words"
  );
  assert.ok(
    panel.includes("data.hasVideo && !data.hasFrames && data.videoHref"),
    "only when there is a video, no frames, and something to read them from"
  );

  /*
   * And the fix is one button, not an instruction. "Re-upload it" would be
   * the honest workaround and a terrible one — a 60 MB file across a phone
   * connection to recover something the browser can read in four seconds.
   */
  assert.ok(panel.includes("Let the AI watch it"), "with a button that fixes it in place");
  assert.ok(panel.includes("bytes=1"), "reading through the portal, so the canvas is not tainted");
  assert.ok(panel.includes('fd.set("force", "1")'), "and forcing a fresh look once it can see");

  /*
   * The two halves have to agree on what the field is called, and nothing
   * else here would notice if they stopped. A hand-built FormData that names
   * the id anything else reaches an action reading `Number(undefined)` — 0,
   * which the action rejects as "Missing task." So the frames are stored, the
   * re-run never happens, and the panel goes on showing the same failure as
   * though the button did nothing at all.
   */
  const field = read("app/(app)/editor/actions.ts").split('formData.get("')[1]?.split('"')[0];
  assert.ok(field, "the action reads an id out of the form");
  assert.ok(
    panel.includes(`fd.set("${field}", String(deliverableId))`),
    `the button sends the id under the name the action reads it by ("${field}")`
  );
  ok("a video the AI has not seen says so, and can be shown to it in one click");
}

/* ------------------------------------------------------------------ *
 * Attach, then read — in that order
 * ------------------------------------------------------------------ */
{
  const up = read("app/(app)/deliverables/video-upload.tsx");

  const attachAt = up.indexOf("await attachUploadedVideo(");
  const framesAt = up.indexOf("await extractFrames(");
  const saveAt = up.indexOf("await saveFrames(");
  assert.ok(attachAt > 0 && framesAt > attachAt, "frames are read after the video is attached");
  assert.ok(saveAt > framesAt, "and saved after they are read");

  /*
   * The whole reason for that order. Queueing the analysis discards the
   * previous video's row, so frames stored beforehand go with it.
   */
  const queue = read("lib/video-ai.ts");
  assert.ok(
    queue.includes("await discardIfVideoChanged(deliverableId);"),
    "queueing throws away an analysis belonging to a replaced video"
  );
  ok("a Replace no longer deletes the frames of the video that replaced it");
}

/* ------------------------------------------------------------------ *
 * And nothing runs before there is something to look at
 * ------------------------------------------------------------------ */
{
  const up = read("app/(app)/deliverables/video-upload.tsx");
  assert.ok(
    up.includes("attachUploadedVideo(deliverableId, signed.key, signed.publicUrl, !isPoster)"),
    "a video tells the attach that frames are coming"
  );

  const actions = read("app/(app)/editor/actions.ts");
  assert.ok(actions.includes("if (runNow) await runAnalysis(deliverableId);"), "so it queues without running");
  assert.ok(
    read("app/(app)/deliverables/upload-actions.ts").includes(
      "await startAnalysisAfterUpload(deliverableId, !framesFirst);"
    ),
    "and the flag is what decides"
  );

  /*
   * A frameless run is not merely wasted money — it can *succeed*. The job is
   * marked done from the sound track, and the frames then land against an
   * analysis nothing will ever look at again.
   */
  ok("the analysis waits for its eyes instead of finishing without them");
}

/* ------------------------------------------------------------------ *
 * Both halves count the same frames
 * ------------------------------------------------------------------ */
{
  const frames = read("lib/frames.ts");
  assert.ok(frames.includes("export const MAX_FRAMES = 12;"), "the count is a literal");
  /*
   * Next substitutes only NEXT_PUBLIC_ variables into a client bundle, and
   * this module is imported by both sides. An override would have applied on
   * the server and silently not in the browser — the decoder making eight and
   * the reader expecting twelve, which fails as a missing frame rather than
   * as a bad setting.
   */
  assert.ok(!frames.includes("process.env"), "not an env var, which only one side would see");
  ok("the browser and the server cannot disagree about how many frames exist");
}

await finish(pass);
