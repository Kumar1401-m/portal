/**
 * POST /api/automation/reports/send
 *
 * Builds and emails the performance report for one client, or for every client
 * still owed one.
 *
 * The whole report — figures, comparison, top posts, recommendations, HTML —
 * is produced server-side. n8n only says "send it", which keeps the numbers a
 * client receives identical to the ones the dashboard shows, and means editing
 * the workflow can never change what the report says.
 *
 * Sending is recorded before the email goes out and guarded by a unique key,
 * so a retried call cannot send the same client the same report twice. Pass
 * `force: true` for a deliberate resend.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body: { "period": "weekly", "client_id"?: 4, "force"?: false }
 */
import { readAuthorized, ok, fail, asInt, asStr } from "@/lib/automation-api";
import { sendClientReport, getReportsDue, type ReportPeriod } from "@/lib/client-report";
import { analyticsReady } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  if (!(await analyticsReady())) {
    return fail("Analytics columns are missing.", 503, "schema_missing");
  }

  const raw = (asStr(body.period) || "weekly").toLowerCase();
  if (raw !== "weekly" && raw !== "monthly") {
    return fail('period must be "weekly" or "monthly".', 400, "bad_period");
  }
  const period = raw as ReportPeriod;
  const force = body.force === true;

  const one = asInt(body.client_id);
  const clientIds = one
    ? [one]
    : (await getReportsDue(period)).clients
        .filter((c) => force || !Number(c.already_sent))
        .map((c) => c.client_id);

  const results = [];
  for (const clientId of clientIds) {
    try {
      results.push(await sendClientReport(clientId, period, { force }));
    } catch (err) {
      // One client's report failing must not stop the rest of the run.
      const message = err instanceof Error ? err.message : "Unknown error";
      console.warn(`[automation] report failed for client ${clientId}:`, message);
      results.push({ ok: false, clientId, sent: false, error: message });
    }
  }

  return ok({
    period,
    attempted: results.length,
    sent: results.filter((r) => r.sent).length,
    results,
  });
}
