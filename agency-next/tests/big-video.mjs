/**
 * A video is not too big to be listened to.
 *
 * Transcription takes an mp4 whole, which is elegant until a reel is finished
 * at a decent bitrate: the endpoint refuses anything over 25 MB, so a 66 MB
 * video was captioned from its pictures alone. Nothing failed — the caption
 * came back fluent and complete and simply never mentioned a word anybody
 * said, which is indistinguishable from a good one until you watch the video.
 *
 * The size is almost all picture. A minute of 1080p is tens of megabytes; the
 * same minute of speech at 16 kHz mono is under two. So the browser decodes
 * the audio track — it is holding the file and has the decoder built in — and
 * uploads that alongside the frames.
 *
 * Which puts the whole thing on a 44-byte header being right. A wrong sample
 * rate or byte rate does not fail: it plays back at the wrong speed and
 * transcribes as nonsense, in the correct language, with no error anywhere.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");
const audio = await import(pathToFileURL(`${SRC}/lib/audio.ts`).href);

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * The header says what the samples actually are
 * ------------------------------------------------------------------ */
{
  const rate = audio.AUDIO_RATE;
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]);
  const view = new DataView(await audio.encodeWav(samples, rate).arrayBuffer());
  const ascii = (at, n) =>
    Array.from({ length: n }, (_, i) => String.fromCharCode(view.getUint8(at + i))).join("");

  assert.equal(ascii(0, 4), "RIFF", "it is a RIFF file");
  assert.equal(ascii(8, 4), "WAVE", "of type WAVE");
  assert.equal(ascii(12, 4), "fmt ", "with a format chunk");
  assert.equal(ascii(36, 4), "data", "and a data chunk");
  assert.equal(view.getUint32(4, true), 36 + samples.length * 2, "the RIFF size covers the rest");
  assert.equal(view.getUint32(40, true), samples.length * 2, "the data size is the samples");
  assert.equal(view.getUint16(20, true), 1, "uncompressed PCM");
  assert.equal(view.getUint16(22, true), 1, "one channel");
  assert.equal(view.getUint16(34, true), 16, "sixteen bits a sample");

  /*
   * These two are the silent ones. Neither produces an error — they produce
   * audio at the wrong speed, which transcribes as confident nonsense.
   */
  assert.equal(view.getUint32(24, true), rate, "the rate in the header is the rate encoded at");
  assert.equal(view.getUint32(28, true), rate * 2, "and the byte rate agrees with it");
  assert.equal(view.getUint16(32, true), 2, "as does the block align");
  ok("the WAV header describes the samples that follow it");
}

/* ------------------------------------------------------------------ *
 * Nothing wraps round
 * ------------------------------------------------------------------ */
{
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]);
  const view = new DataView(await audio.encodeWav(samples, audio.AUDIO_RATE).arrayBuffer());
  const at = (i) => view.getInt16(44 + i * 2, true);

  assert.equal(at(0), 0, "silence is silence");
  assert.ok(Math.abs(at(1) - 0x3fff) <= 1, "half scale is half scale");
  assert.ok(Math.abs(at(2) + 0x4000) <= 1, "and so is the negative half");
  assert.equal(at(3), 0x7fff, "full scale reaches the top");
  assert.equal(at(4), -0x8000, "and the bottom");

  /*
   * Rendering can hand back samples a little outside ±1. Scaled without
   * clamping, 2.0 becomes 65534 as a signed 16-bit integer — which is -2, the
   * opposite extreme, heard as a click on every peak in the file.
   */
  assert.equal(at(5), 0x7fff, "anything over full scale is held at the top");
  assert.equal(at(6), -0x8000, "and anything under it at the bottom");
  ok("samples past full scale clip instead of wrapping to the opposite extreme");
}

/* ------------------------------------------------------------------ *
 * One sound track per task, and it is that task's
 * ------------------------------------------------------------------ */
{
  assert.equal(audio.audioKey(272), "audio/272.wav", "keyed by deliverable");
  assert.equal(audio.audioKey(272.9), "audio/272.wav", "and never by a fraction of one");
  assert.ok(audio.MAX_AUDIO_BYTES <= 25 * 1024 * 1024, "and never sent if the endpoint would refuse it");

  /*
   * The key is per task, so a new upload normally overwrites it — but only if
   * the browser manages to extract anything. Without this, a video whose
   * audio cannot be decoded inherits the sound track of the cut it replaced
   * and is captioned, confidently, from words that are not in it.
   */
  const actions = read("app/(app)/deliverables/upload-actions.ts");
  assert.ok(
    actions.includes("await deleteObject(audioKey(deliverableId)).catch(() => false);"),
    "attaching a video bins the previous one's speech"
  );
  const attachAt = actions.indexOf("export async function attachUploadedVideo");
  assert.ok(
    actions.indexOf("await deleteObject(audioKey(deliverableId))") > attachAt,
    "on the attach, which is what every replacement goes through"
  );
  ok("a replaced video cannot be captioned from the sound track of the old one");
}

/* ------------------------------------------------------------------ *
 * The speech is preferred, and the video still works
 * ------------------------------------------------------------------ */
{
  const ai = read("lib/video-ai.ts");
  const speechAt = ai.indexOf('await transcribe(speech, "speech.wav")');
  const videoAt = ai.indexOf("const fromVideo = () =>");
  assert.ok(speechAt > 0 && videoAt > 0, "both sources exist");
  assert.ok(
    ai.includes("? await transcribe(speech, \"speech.wav\").then((r) => (r.text ? r : fromVideo()))"),
    "the extracted speech is tried first and the video is the fallback"
  );
  /*
   * A key nothing was ever written to presigns perfectly happily and 404s on
   * collection, so "there is no extracted speech" arrives as a failed fetch
   * rather than as a missing URL — which is why the fallback is on the
   * result, not on whether a URL could be built.
   */
  assert.ok(ai.includes("audioKey(deliverableId)"), "and it looks under this task's own key");

  for (const [f, blob] of [
    ["app/(app)/deliverables/video-upload.tsx", "file"],
    ["app/(app)/editor/ai-caption.tsx", "blob"],
  ]) {
    assert.ok(
      read(f).includes(`await saveAudio(deliverableId, ${blob});`),
      `${f} extracts the sound track too`
    );
  }
  ok("every video gets its speech read, whatever the file weighs");
}

await finish(pass);
