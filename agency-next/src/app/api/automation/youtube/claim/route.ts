/**
 * POST /api/automation/youtube/claim
 *
 * Step 2. Reserves one video for this run and moves it to `processing`. Call
 * it immediately before downloading the file — a claim only holds for the
 * lease, and an upload that takes longer than the lease risks a second run
 * picking the same video up and putting two copies on the channel.
 *
 * `ok: false` here is normal, not an error: another execution got there first,
 * or the video is already up. The workflow should skip the item and carry on
 * rather than fail the run, so the IF node branches on `ok`.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body: { "deliverable_id": number, "run_id"?: string }
 */
import { readAuthorized, ok, fail, asInt, asStr } from "@/lib/automation-api";
import { claimForYouTube } from "@/lib/youtube";

export const dynamic = "force-dynamic";

/** HTTP status per outcome — 409 for "someone else has it", 410 for terminal. */
const STATUS: Record<string, number> = {
  not_found: 404,
  already_posted: 410,
  claimed_elsewhere: 409,
  exhausted: 410,
  no_video: 409,
};

const MESSAGE: Record<string, string> = {
  not_found: "Deliverable not found.",
  already_posted: "Already on YouTube — nothing to do.",
  claimed_elsewhere: "Another run is uploading this video.",
  exhausted: "Retry budget exhausted; needs a manual retry from the portal.",
  no_video: "No reachable video file — the claim was released.",
};

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  const deliverableId = asInt(body.deliverable_id);
  if (!deliverableId) return fail("deliverable_id is required.", 400, "missing_id");

  const result = await claimForYouTube(deliverableId, asStr(body.run_id));
  if (!result.ok) {
    return fail(MESSAGE[result.reason], STATUS[result.reason] ?? 409, result.reason);
  }
  return ok({ item: result.item });
}
