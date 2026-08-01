/**
 * POST /api/automation/publish/result
 *
 * Step 4 — the workflow reports what Instagram did. One endpoint for both
 * outcomes so the n8n error branch has the same contract as the success
 * branch, and a run that dies partway can't leave the row claimed for ever.
 *
 * Success stores the media id, permalink and publish timestamp and marks the
 * deliverable posted. Failure decides between another attempt and giving up —
 * that decision lives in the database (see src/lib/instagram.ts), not in the
 * workflow, so it survives n8n being reimported or edited.
 *
 * Idempotent: replaying a success for something already posted is a no-op, and
 * a late failure callback can never un-post a live post.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body (success):
 *   { "deliverable_id": 12, "status": "posted", "media_id": "1784…",
 *     "permalink": "https://instagram.com/p/…", "posted_at": "2026-08-01T18:30:00+0000",
 *     "run_id": "…", "duration_ms": 8123 }
 * Body (failure):
 *   { "deliverable_id": 12, "status": "failed", "error_message": "…",
 *     "error_code": "190", "stage": "create_container", "permanent": false }
 */
import { readAuthorized, ok, fail, asInt, asStr, asDateTime } from "@/lib/automation-api";
import { markPosted, markFailed } from "@/lib/instagram";

export const dynamic = "force-dynamic";

/**
 * Meta error codes that repeat identically however many times you retry.
 * Treating them as permanent stops a broken token burning the whole retry
 * budget over the next hour, and gets a human told straight away.
 *
 *   190 / 102  — token expired, invalid, or session ended
 *   200 / 10   — permission missing for this account
 *   9007       — media format Instagram will not accept
 *   36003      — the account is not an eligible business/creator account
 */
const PERMANENT_ERROR_CODES = new Set(["190", "102", "200", "10", "9007", "36003"]);

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  const deliverableId = asInt(body.deliverable_id);
  if (!deliverableId) return fail("deliverable_id is required.", 400, "missing_id");

  const status = (asStr(body.status) || "posted").toLowerCase();

  if (status === "posted" || status === "success") {
    const mediaId = asStr(body.media_id) || asStr(body.instagram_media_id);
    if (!mediaId) {
      return fail("media_id is required when reporting a successful post.", 400, "missing_media_id");
    }
    const result = await markPosted({
      deliverableId,
      mediaId,
      permalink: asStr(body.permalink),
      postedAt: asDateTime(body.posted_at),
      runId: asStr(body.run_id),
      durationMs: body.duration_ms == null ? null : asInt(body.duration_ms),
    });
    if (!result.ok) return fail(result.error || "Could not record the post.", 404, "not_found");
    return ok({ status: "posted", already_posted: Boolean(result.alreadyPosted) });
  }

  if (status === "failed" || status === "error") {
    const message = asStr(body.error_message) || asStr(body.error) || "Unknown publishing error";
    const code = asStr(body.error_code);
    // Either side may call it permanent: the workflow knows about its own
    // failures (a missing file), and we know Meta's codes.
    const permanent = body.permanent === true || (code ? PERMANENT_ERROR_CODES.has(code) : false);

    const result = await markFailed({
      deliverableId,
      errorCode: code,
      errorMessage: message,
      stage: asStr(body.stage) || "publish",
      permanent,
      runId: asStr(body.run_id),
    });
    if (!result.ok) return fail(result.error || "Could not record the failure.", 404, "not_found");
    return ok({
      status: result.willRetry ? "will_retry" : "failed",
      will_retry: result.willRetry,
      attempts_used: result.attemptsUsed,
      permanent,
    });
  }

  return fail(`Unknown status "${status}". Use "posted" or "failed".`, 400, "bad_status");
}
