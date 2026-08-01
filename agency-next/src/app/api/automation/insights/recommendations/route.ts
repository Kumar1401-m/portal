/**
 * POST /api/automation/insights/recommendations
 *
 * Regenerates the AI recommendation cards for one client (or every client with
 * analytics enabled) from the history collected so far.
 *
 * Run at the end of the daily insights workflow, after the numbers have
 * landed — the recommendations are computed from those numbers, so running it
 * first would advise on yesterday's picture.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body: { "client_id"?: 4, "days"?: 90 }   // omit client_id to do all of them
 */
import { readAuthorized, ok, fail, asInt } from "@/lib/automation-api";
import { generateRecommendations } from "@/lib/insights-ai";
import { getAnalyticsClients, analyticsReady } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * Recommendations are drawn from a longer window than the dashboard's default
 * month: "best posting time" needs enough posts per weekday slot to be more
 * than noise, and a month of a 3-posts-a-week schedule is about twelve.
 */
const DEFAULT_WINDOW_DAYS = 90;

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  if (!(await analyticsReady())) {
    return fail("Analytics columns are missing.", 503, "schema_missing");
  }

  const days = Math.min(365, Math.max(14, asInt(body.days, DEFAULT_WINDOW_DAYS)));
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const one = asInt(body.client_id);
  const clientIds = one ? [one] : (await getAnalyticsClients()).map((c) => c.id);

  const results: { client_id: number; recommendations: number; error?: string }[] = [];
  for (const clientId of clientIds) {
    try {
      const recs = await generateRecommendations(clientId, { from, to, platform: "instagram" });
      results.push({ client_id: clientId, recommendations: recs.length });
    } catch (err) {
      // One client's LLM call failing shouldn't stop the rest of the agency
      // getting refreshed advice.
      const message = err instanceof Error ? err.message : "Unknown error";
      console.warn(`[automation] recommendations failed for client ${clientId}:`, message);
      results.push({ client_id: clientId, recommendations: 0, error: message });
    }
  }

  return ok({ window: { from, to }, clients: results.length, results });
}
