"use server";

import { revalidatePath } from "next/cache";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { queryOne } from "@/lib/db";
import { queueAnalysis, runAnalysis, applyCaption, getAnalysis } from "@/lib/video-ai";

export type AnalyseState = {
  ok: boolean;
  state?: string;
  message?: string;
  error?: string;
  /** True while there is more work — the client polls again. */
  more?: boolean;
  caption?: string | null;
};

/** Everyone who can act on a video shares the same access rule. */
async function assertAccess(deliverableId: number) {
  const user = await requireUser(STAFF_ROLES);
  const d = await queryOne<{ client_id: number }>(
    "SELECT client_id FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!d) return { ok: false as const, error: "Task not found." };
  if (!(await canAccessClient(user, d.client_id))) {
    return { ok: false as const, error: "You don't have access to this client." };
  }
  return { ok: true as const };
}

/**
 * Push one analysis forward.
 *
 * Called repeatedly by the UI rather than once: watching a 66 MB video is four
 * steps across roughly half a minute, and a serverless function can be killed
 * partway. Each call does as much as it safely can and reports whether more
 * remains, so no single request has to survive the whole job.
 */
export async function analyseVideoAction(
  _prev: AnalyseState,
  formData: FormData
): Promise<AnalyseState> {
  const id = Number(formData.get("deliverable_id"));
  if (!id) return { ok: false, error: "Missing task." };

  const access = await assertAccess(id);
  if (!access.ok) return { ok: false, error: access.error };

  const force = formData.get("force") === "1";
  await queueAnalysis(id, force);

  const result = await runAnalysis(id);
  revalidatePath(`/deliverables/${id}`);
  revalidatePath("/editor");

  if (!result.ok && result.state === "failed") {
    return { ok: false, state: result.state, error: result.error };
  }

  return {
    ok: true,
    state: result.state,
    more: result.more,
    caption: result.caption ?? null,
    message:
      result.state === "done"
        ? "Caption written from the video."
        : result.state === "uploading"
          ? "Sending the video to the AI…"
          : result.state === "processing"
            ? "The AI is watching the video…"
            : "Working…",
  };
}

/**
 * Carry an upload's analysis through to a finished caption on the task.
 *
 * Called by the uploader in a loop while the browser is still open, which is
 * the only place the whole job can safely run: it takes about half a minute
 * across four steps, and a server action that tried to sit through all of it
 * would be killed by the platform somewhere in the middle.
 *
 * The caption is written onto the task only when there isn't one. That
 * restraint is the whole reason this can be automatic — an editor who has
 * already written or tweaked a caption never has it overwritten by a video
 * they uploaded afterwards, so nobody has to remember to turn it off.
 */
export async function finishAnalysisAfterUpload(
  deliverableId: number
): Promise<AnalyseState & { applied?: boolean }> {
  if (!deliverableId) return { ok: false, error: "Missing task." };

  const access = await assertAccess(deliverableId);
  if (!access.ok) return { ok: false, error: access.error };

  const result = await runAnalysis(deliverableId);

  let applied = false;
  if (result.state === "done") {
    const d = await queryOne<{ caption: string | null }>(
      "SELECT caption FROM deliverables WHERE id = ?",
      [deliverableId]
    );
    if (!d?.caption?.trim()) {
      const out = await applyCaption(deliverableId);
      applied = out.ok;
    }
  }

  revalidatePath(`/deliverables/${deliverableId}`);
  revalidatePath("/deliverables");
  revalidatePath("/editor");

  if (!result.ok && result.state === "failed") {
    return { ok: false, state: result.state, error: result.error };
  }

  return {
    ok: true,
    state: result.state,
    more: result.more,
    caption: result.caption ?? null,
    applied,
    message:
      result.state === "done"
        ? applied
          ? "Caption written from the video."
          : "Caption ready — the task already has one, so it wasn't replaced."
        : result.state === "uploading"
          ? "Sending the video to the AI…"
          : result.state === "processing"
            ? "The AI is watching the video…"
            : "Writing the caption…",
  };
}

/** Copy the AI draft onto the task, replacing whatever caption is there. */
export async function applyCaptionAction(
  _prev: AnalyseState,
  formData: FormData
): Promise<AnalyseState> {
  const id = Number(formData.get("deliverable_id"));
  if (!id) return { ok: false, error: "Missing task." };

  const access = await assertAccess(id);
  if (!access.ok) return { ok: false, error: access.error };

  const result = await applyCaption(id);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/deliverables/${id}`);
  revalidatePath("/editor");
  return { ok: true, message: "Caption applied to the task." };
}

/**
 * Kick off analysis right after an upload, without making the uploader wait.
 *
 * Queues the job and takes one step — usually enough to get the file uploaded
 * to Gemini — then returns. Whoever opens the task next finishes it off. The
 * whole thing is best-effort: a failed analysis must never make a successful
 * video upload look broken.
 */
export async function startAnalysisAfterUpload(deliverableId: number): Promise<void> {
  try {
    await queueAnalysis(deliverableId);
    await runAnalysis(deliverableId);
  } catch (err) {
    console.warn(
      "[video-ai] post-upload analysis did not start:",
      err instanceof Error ? err.message : err
    );
  }
}

/** Current state, for the polling UI. */
export async function pollAnalysis(deliverableId: number): Promise<AnalyseState> {
  const access = await assertAccess(deliverableId);
  if (!access.ok) return { ok: false, error: access.error };

  const a = await getAnalysis(deliverableId);
  if (!a) return { ok: true, state: "queued", more: false };

  return {
    ok: a.state !== "failed",
    state: a.state,
    caption: a.caption,
    error: a.state === "failed" ? a.last_error ?? undefined : undefined,
    more: !["done", "failed"].includes(a.state),
  };
}
