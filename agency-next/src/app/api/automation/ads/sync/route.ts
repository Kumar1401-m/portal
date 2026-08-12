/**
 * GET /api/automation/ads/sync
 *
 * Pulls the last 28 days of Meta insights for every client with an ad account
 * and upserts a row per client per day.
 *
 * Twenty-eight days each night rather than yesterday only, because Meta keeps
 * restating conversions as attribution settles. A figure fetched once on the
 * day is a figure that never becomes correct — re-pulling the window is what
 * makes the board agree with Ads Manager a month later.
 *
 * Safe to run twice: every row is an upsert on (client_id, date).
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 */
import { guard, ok, fail } from "@/lib/automation-api";
import { syncAllAds, adsReadiness, RESTATEMENT_DAYS } from "@/lib/ads";
import { recordRun } from "@/lib/automation-runs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  const readiness = await adsReadiness();
  if (!readiness.ready) return fail(readiness.reason ?? "Not ready", 503);

  const url = new URL(request.url);
  const days = Math.min(Math.max(1, Number(url.searchParams.get("days")) || RESTATEMENT_DAYS), 90);

  const result = await syncAllAds(days);

  // The heartbeat is how Settings shows "last ran"; a job nobody can see
  // stopped is a job that stays stopped.
  await recordRun(
    "ads_sync",
    result.failures.length === 0,
    `${result.synced} clients, ${result.rows} days${
      result.failures.length ? `, ${result.failures.length} failed` : ""
    }`
  ).catch(() => {});

  // 200 even with per-client failures: the run itself worked, and one client's
  // expired token is not a reason for n8n to show the whole job red every
  // night until somebody notices.
  return ok({ days, ...result });
}
