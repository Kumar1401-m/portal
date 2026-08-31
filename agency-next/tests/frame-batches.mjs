/**
 * Frames reach the server in pieces small enough to arrive.
 *
 * They used to go in one call, and in production that call never ran. A
 * Server Action request body is capped at 1 MB by Next — not the ~4.5 MB
 * platform limit the code was written against — and twelve frames of base64
 * is roughly 2 MB. The framework rejected the request with a 413 before the
 * function was reached, which the browser showed as "an error occurred in the
 * Server Components render": no size, no action name, nothing to search for.
 *
 * The batches are cut by bytes rather than by a count of frames, because a
 * busy picture encodes several times larger than a plain one — a fixed twelve
 * fits one video and not the next.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish } from "./finish.mjs";

const SRC = process.env.PORTAL_SRC;
const read = (p) => readFileSync(`${SRC}/${p}`, "utf8");

const { planBatches, CHUNK_BYTES, MAX_ONE, MAX_FRAMES } = await import("../src/lib/frames.ts");

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };

/* ------------------------------------------------------------------ *
 * No batch can be refused
 * ------------------------------------------------------------------ */
{
  assert.ok(CHUNK_BYTES < 1_000_000, "a batch is budgeted under the 1 MB action limit");
  assert.ok(MAX_ONE < 1_000_000, "and so is the largest single frame that will be sent");

  const sizes = Array.from({ length: MAX_FRAMES }, () => 180_000);
  const groups = planBatches(sizes);
  assert.ok(groups.length > 1, "a full strip does not go in one call");
  for (const g of groups) {
    const bytes = g.reduce((n, i) => n + sizes[i], 0);
    assert.ok(bytes <= CHUNK_BYTES, `batch of ${g.length} is ${bytes} bytes, within budget`);
  }
  assert.deepEqual(groups.flat(), sizes.map((_, i) => i), "and every frame is in exactly one batch");
  ok("twelve frames are split into requests that each fit");
}

/* ------------------------------------------------------------------ *
 * Every batch is consecutive
 * ------------------------------------------------------------------ */
{
  /*
   * The server is told where a batch begins and names each file by its
   * position from there. A batch with a hole in it would file every frame
   * after the hole one place early, overwriting the one before it — so a
   * skipped frame has to end the batch rather than be stepped over.
   */
  const sizes = [100, 100, MAX_ONE + 1, 100, 100];
  const groups = planBatches(sizes);
  assert.deepEqual(groups, [[0, 1], [3, 4]], "an unsendable frame breaks the run in two");
  for (const g of groups) {
    assert.deepEqual(g, Array.from({ length: g.length }, (_, k) => g[0] + k), "batch is consecutive");
  }
  ok("a frame too big to send costs that frame and not the ones after it");
}

/* ------------------------------------------------------------------ *
 * One frame is always sendable on its own
 * ------------------------------------------------------------------ */
{
  const groups = planBatches([CHUNK_BYTES - 1, CHUNK_BYTES - 1]);
  assert.deepEqual(groups, [[0], [1]], "two near-budget frames go separately, never merged over");
  assert.deepEqual(planBatches([]), [], "no frames means no calls");
  assert.deepEqual(planBatches([0, 100]), [[1]], "and an empty frame is dropped, not sent");
  ok("the batcher never builds a request it knows will be refused");
}

/* ------------------------------------------------------------------ *
 * The server files each batch where the caller says
 * ------------------------------------------------------------------ */
{
  const actions = read("app/(app)/deliverables/upload-actions.ts");

  assert.ok(actions.includes("startIndex = 0"), "the action is told where the batch starts");
  assert.ok(
    actions.includes("const at = Math.max(0, Math.trunc(startIndex)) + i;"),
    "and counts positions across the whole strip"
  );
  assert.ok(
    actions.includes("const key = `frames/${Math.trunc(deliverableId)}/${at}.jpg`;"),
    "which is what names the file, so a second batch cannot overwrite the first"
  );
  assert.ok(actions.includes("if (at >= MAX_FRAMES) break;"), "and the cap is on the strip, not the batch");

  /*
   * The first batch replaces; the rest add. Replacing on every batch would
   * leave only the last one, which is the same silent half-blind analysis
   * this whole thing exists to prevent.
   */
  assert.ok(actions.includes("startIndex === 0\n      ? []"), "the first batch clears the old strip");
  assert.ok(actions.includes("[...new Set([...before, ...keys])]"), "later ones merge into it");
  ok("batches assemble into one ordered strip instead of overwriting each other");
}

/* ------------------------------------------------------------------ *
 * And nothing bypasses the batcher
 * ------------------------------------------------------------------ */
{
  for (const f of [
    "app/(app)/deliverables/video-upload.tsx",
    "app/(app)/editor/ai-caption.tsx",
  ]) {
    const s = read(f);
    assert.ok(s.includes("await saveFrames(deliverableId, frames)"), `${f} sends frames in batches`);
    assert.ok(!s.includes("saveVideoFrames("), `${f} does not call the action directly`);
  }
  ok("both the upload and the watch-it button go through the same batching");
}

await finish(pass);
