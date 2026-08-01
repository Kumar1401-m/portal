/**
 * GET /api/automation/reports/due?period=weekly|monthly
 *
 * Which clients are owed a report for the period that has just finished, and
 * whether one has already gone out.
 *
 * The window is computed here rather than in the workflow so that a cron
 * firing a few minutes late — or a manual re-run mid-week — still reports on
 * the same completed period. n8n never has to do date arithmetic.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 */
import { guard, ok, fail } from "@/lib/automation-api";
import { getReportsDue, type ReportPeriod } from "@/lib/client-report";
import { analyticsReady } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  if (!(await analyticsReady())) {
    return fail("Analytics columns are missing.", 503, "schema_missing");
  }

  const url = new URL(request.url);
  const raw = (url.searchParams.get("period") || "weekly").toLowerCase();
  if (raw !== "weekly" && raw !== "monthly") {
    return fail('period must be "weekly" or "monthly".', 400, "bad_period");
  }
  const period = raw as ReportPeriod;

  const { from, to, clients } = await getReportsDue(period);
  const pending = clients.filter((c) => !Number(c.already_sent));

  return ok({
    period,
    from,
    to,
    total: clients.length,
    pending: pending.length,
    // Only the ones still owed — the workflow can iterate the list directly
    // without an IF node per client.
    clients: pending.map((c) => ({
      client_id: c.client_id,
      client_name: c.company_name,
      email: c.email,
    })),
  });
}
