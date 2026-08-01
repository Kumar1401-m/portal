/**
 * POST /api/automation/insights/sync
 *
 * Pull one client's Instagram history immediately — the API equivalent of the
 * "Analyse now" button.
 *
 * Distinct from /insights/account and /insights/posts, which are dumb sinks
 * that store whatever n8n hands them. This one does the fetching itself, so a
 * newly connected account can be backfilled with a single call and no workflow
 * run. Useful for onboarding a client mid-month, and for re-syncing one
 * account without waiting for the nightly job.
 *
 * Also resolves a Facebook Page id to the Instagram account id and corrects
 * the client record, so a mistyped id fixes itself rather than failing later.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body: { "client_id": 4, "days"?: 30 }
 */
import { readAuthorized, ok, fail, asInt } from "@/lib/automation-api";
import { syncClientAnalytics } from "@/lib/instagram-sync";
import { analyticsReady } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  if (!(await analyticsReady())) {
    return fail("Analytics columns are missing.", 503, "schema_missing");
  }

  const clientId = asInt(body.client_id);
  if (!clientId) return fail("client_id is required.", 400, "missing_client");

  const result = await syncClientAnalytics(clientId, {
    days: body.days == null ? undefined : asInt(body.days),
    skipRecommendations: body.skip_recommendations === true,
  });

  // A failed sync is a client-configuration problem (no id, no token, revoked
  // permissions), not a server fault — 422 so a workflow can branch on it
  // without treating it as an outage.
  if (!result.ok) return fail(result.error || "Sync failed.", 422, "sync_failed");

  return ok({
    client: result.clientName,
    username: result.username,
    followers: result.followers,
    corrected_id: result.correctedId ?? null,
    days_backfilled: result.daysBackfilled,
    posts_stored: result.postsStored,
    recommendations: result.recommendations,
    warnings: result.warnings ?? [],
  });
}
