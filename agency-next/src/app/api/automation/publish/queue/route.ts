/**
 * GET /api/automation/publish/queue
 *
 * Step 1 of the publisher workflow. Returns approved, scheduled deliverables
 * whose posting time has arrived, for clients that opted into auto-publishing.
 *
 * Read-only — nothing is reserved here. The workflow must call
 * /publish/claim for each item before touching the Graph API; that is where
 * two concurrent n8n executions are prevented from posting the same reel.
 *
 * Auth:  Authorization: Bearer <N8N_API_KEY>
 * Query: limit — max items (default 10, capped at 50)
 */
import { guard, ok, fail } from "@/lib/automation-api";
import { getPublishQueue, publishingReadiness } from "@/lib/instagram";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  // Reported explicitly rather than as an empty queue: "nothing to post" and
  // "the feature was never migrated" look identical otherwise, and the second
  // one is silent for as long as nobody checks.
  const readiness = await publishingReadiness();
  if (!readiness.ready) return fail(readiness.reason!, 503, "schema_missing");

  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50) : 10;

  const items = await getPublishQueue(limit);
  return ok({ count: items.length, items });
}
