/**
 * GET /api/automation/youtube/queue
 *
 * Step 1 of the YouTube runner. Videos whose posting time has arrived, for
 * clients who opted into YouTube. Read against the same `scheduled_at` as the
 * Instagram queue, which is what makes the two go out together.
 *
 * Read-only — nothing is reserved here. The workflow must call
 * /youtube/claim for each item before uploading anything; that is where two
 * concurrent runs are stopped from putting the same video on the channel
 * twice.
 *
 * Auth:  Authorization: Bearer <N8N_API_KEY>
 * Query: limit — max items (default 10, capped at 50)
 */
import { guard, ok, fail } from "@/lib/automation-api";
import { getYouTubeQueue, youtubeReadiness } from "@/lib/youtube";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  // Said out loud rather than returned as an empty queue: "nothing to upload"
  // and "the migration was never run" look identical otherwise, and the second
  // stays silent for as long as nobody checks.
  const readiness = await youtubeReadiness();
  if (!readiness.ready) return fail(readiness.reason ?? "Not ready", 503);

  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 10), 50);

  const items = await getYouTubeQueue(limit);
  return ok({ count: items.length, items });
}
