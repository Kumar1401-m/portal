"use client";

import { saveVideoFrames } from "./upload-actions";
import { planBatches, type Frame } from "@/lib/frames";

/**
 * Send decoded frames to the server, a batch at a time.
 *
 * The whole strip in one call is what this replaces, and it did not work: a
 * Server Action body is capped at 1 MB and twelve frames is about twice that,
 * so the request was refused before the action ran and the browser was shown
 * an opaque render error. See `planBatches` for how the batches are cut.
 */
export async function saveFrames(
  deliverableId: number,
  frames: Frame[]
): Promise<{ ok: boolean; stored: number; error?: string }> {
  let stored = 0;

  for (const group of planBatches(frames.map((f) => f.dataUrl.length))) {
    const res = await saveVideoFrames(
      deliverableId,
      group.map((i) => frames[i].dataUrl),
      group[0]
    );
    /*
     * A failed batch stops the rest. Carrying on would leave a gap-toothed
     * strip that the analysis reads as though it were the whole video —
     * saying nothing about the missing seconds because nothing tells it any
     * are missing.
     */
    if (!res.ok) return res;
    stored += res.stored;
  }

  return stored
    ? { ok: true, stored }
    : { ok: false, stored: 0, error: "No frames could be stored." };
}
