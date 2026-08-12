/**
 * POST /api/automation/youtube/result
 *
 * Step 3 — the workflow reports what YouTube did. One endpoint for both
 * outcomes, so the n8n error branch has the same contract as the success
 * branch and a run that dies partway cannot leave the row claimed for ever.
 *
 * Success stores the video id and watch link and marks it posted. Failure
 * decides between another attempt and giving up, and that decision lives in
 * `src/lib/youtube.ts` rather than in the workflow, so it survives n8n being
 * reimported or edited by hand.
 *
 * Idempotent: replaying a success for something already up is a no-op, and a
 * late failure callback can never un-post a live video.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body (success):
 *   { "deliverable_id": 12, "status": "posted", "video_id": "dQw4w9WgXcQ",
 *     "url": "https://youtu.be/dQw4w9WgXcQ" }
 * Body (failure):
 *   { "deliverable_id": 12, "status": "failed",
 *     "error_message": "The user has exceeded the number of videos they may upload.",
 *     "permanent": false }
 */
import { readAuthorized, ok, fail, asInt, asStr } from "@/lib/automation-api";
import { recordYouTubeResult } from "@/lib/youtube";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  const deliverableId = asInt(body.deliverable_id);
  if (!deliverableId) return fail("deliverable_id is required.", 400, "missing_id");

  const status = asStr(body.status);
  if (status !== "posted" && status !== "failed") {
    return fail('status must be "posted" or "failed".', 400, "bad_status");
  }

  const result = await recordYouTubeResult({
    deliverableId,
    status,
    videoId: asStr(body.video_id),
    url: asStr(body.url),
    errorMessage: asStr(body.error_message),
    // Only ever true when the workflow is sure another go cannot help — a
    // revoked credential, a channel that does not exist, a rejected file.
    permanent: body.permanent === true,
  });
  if (!result.ok) return fail(`Could not record the result (${result.state}).`, 409, result.state);
  return ok({ state: result.state });
}
