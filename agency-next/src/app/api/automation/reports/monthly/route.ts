/**
 * POST /api/automation/reports/monthly
 *
 * Builds each client's month — delivered, reach, follower growth, ad spend —
 * and puts one message per client into the WhatsApp outbox.
 *
 * Queued, never sent. Run this on the 1st and the reports sit in Settings →
 * Reminders with a send time on them, where a human can read and cancel any of
 * them first. A generated message reaching a client before anybody has seen it
 * is the failure mode this deliberately avoids.
 *
 * Body (all optional):
 *   { "month": "2026-07", "sendAt": "2026-08-01 04:00:00" }
 *
 * `month` defaults to the one that just finished, which is what "run it on the
 * 1st" means. `sendAt` is UTC and defaults to now — set it to stagger the
 * batch or to hold it until somebody is awake.
 *
 * Safe to run twice. Each client's month is claimed in `scheduled_reports`,
 * whose unique key on (client, period, period_start) means a second call for
 * the same month queues nothing and reports those clients as skipped.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 */
import { readAuthorized, ok, fail, asStr } from "@/lib/automation-api";
import { queueMonthlyReports } from "@/lib/monthly-report";
import { recordRun } from "@/lib/automation-runs";
import { outboxReady } from "@/lib/reminder-outbox";
import { thisMonthKey, shiftMonth } from "@/lib/date-range";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  if (!(await outboxReady())) {
    return fail("The WhatsApp outbox isn't set up in this database yet.", 503, "schema");
  }

  const asked = asStr(body.month);
  const month = asked && /^\d{4}-\d{2}$/.test(asked) ? asked : shiftMonth(thisMonthKey(), -1);
  const sendAt = asStr(body.sendAt) ?? undefined;

  const result = await queueMonthlyReports(month, sendAt);
  await recordRun("monthly_reports", true, `${result.queued} queued for ${month}`).catch(() => {});

  return ok(result);
}
