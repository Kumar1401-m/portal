/**
 * POST /api/automation/analyse
 *
 * Push a video's AI caption analysis forward by one step.
 *
 * The portal's own UI drives this through a server action; this is the same
 * work over HTTP, so it can be batched. Useful for catching up after a spell
 * where nobody opened the tasks — analysis starts on upload but needs someone
 * to come back and finish it, and an unattended caller can do that instead.
 *
 * Deliberately one step per call, not a loop to completion. Watching a video
 * is four stages across ~30 seconds and a serverless function can be killed
 * partway; short calls plus a resumable job survive that, a long call does not.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body: { "deliverable_id": 12, "force"?: false }
 *   or  { "pending": true, "limit"?: 5 }   — advance whatever is in flight
 */
import { readAuthorized, ok, fail, asInt } from "@/lib/automation-api";
import { isAuthorizedCronRequest, unauthorized } from "@/lib/api-auth";
import { queueAnalysis, runAnalysis, getPendingAnalyses, videoAiReady } from "@/lib/video-ai";

export const dynamic = "force-dynamic";

/**
 * Vercel kills a function at its plan's limit; this keeps the whole request
 * comfortably inside even the smallest, at the cost of the caller polling.
 */
export const maxDuration = 60;

/**
 * GET — the scheduled catch-up. Advances whatever analysis is in flight.
 *
 * The uploader drives a caption to completion from the browser, which works
 * right up until the tab is closed halfway through. Before this, such a job
 * simply stopped: the row sat in `uploading` or `processing` and the caption
 * arrived only when somebody happened to open that task again.
 *
 * A GET with no body because that is all Vercel Cron sends. Each run advances
 * every pending job by one step, so a job needing three steps finishes within
 * three runs rather than holding one request open for all of them.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorized();
  if (!(await videoAiReady())) return ok({ advanced: 0, skipped: "video AI not configured" });

  const jobs = await getPendingAnalyses(5);
  const results = [];
  for (const job of jobs) {
    try {
      const r = await runAnalysis(job.deliverable_id);
      results.push({ deliverable_id: job.deliverable_id, state: r.state, more: r.more ?? false });
    } catch (err) {
      // One bad video must not stop the others from being picked up.
      results.push({
        deliverable_id: job.deliverable_id,
        state: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
  return ok({ advanced: results.length, results });
}

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  if (!(await videoAiReady())) {
    return fail(
      "Video AI isn't available — needs GEMINI_API_KEY and the video_analysis table.",
      503,
      "not_configured"
    );
  }

  // Batch mode: advance everything currently in flight.
  if (body.pending === true) {
    const limit = Math.min(10, Math.max(1, asInt(body.limit, 5)));
    const jobs = (await getPendingAnalyses(limit)).slice(0, limit);
    const results = [];
    for (const job of jobs) {
      const r = await runAnalysis(job.deliverable_id);
      results.push({ deliverable_id: job.deliverable_id, state: r.state, more: r.more ?? false });
    }
    return ok({ advanced: results.length, results });
  }

  const id = asInt(body.deliverable_id);
  if (!id) return fail("deliverable_id is required.", 400, "missing_id");

  await queueAnalysis(id, body.force === true);
  const result = await runAnalysis(id);

  if (!result.ok && result.state === "failed") {
    // 422, not 500: a video too large or in an unsupported format is a fact
    // about the file, and retrying will not change it.
    return fail(result.error || "Analysis failed.", 422, "analysis_failed");
  }

  return ok({
    deliverable_id: id,
    state: result.state,
    more: result.more ?? false,
    caption: result.caption ?? null,
    // A recoverable failure — a transient fetch error, say — leaves the job
    // queued for another attempt. Reporting it as a plain `ok` with no detail
    // makes a stuck job look like a finished one, which is how a caller ends
    // up polling something that will never progress without being told why.
    ...(result.error ? { warning: result.error } : {}),
  });
}
