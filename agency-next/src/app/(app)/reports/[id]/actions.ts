"use server";

import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { buildMonthlyReport, renderReportText, markReportSent } from "@/lib/monthly-report";
import { groupForClient, sendNow } from "@/lib/reminder-outbox";
import { reportLink } from "@/lib/doc-link";

export type SendState = { ok: boolean; message: string };

/**
 * Send this client their month, now.
 *
 * Sent rather than queued, unlike the scheduled batch — the whole card above
 * this button is the message, so by the time it is pressed a person has read
 * exactly what the client will read. The batch has no such reader, which is
 * why that one queues.
 */
export async function sendMonthlyReportAction(clientId: number, month: string): Promise<SendState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (!(await canAccessClient(user, clientId))) {
    return { ok: false, message: "That client isn't one of yours." };
  }
  if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, message: "Pick a month first." };

  const report = await buildMonthlyReport(clientId, month);
  if (!report) return { ok: false, message: "No such client." };

  const group = await groupForClient(clientId);
  if (!group) {
    return {
      ok: false,
      message: "This client has no WhatsApp group linked — link one on their page first.",
    };
  }

  const res = await sendNow({
    kind: "monthly_report",
    clientId,
    groupId: group.groupId,
    groupLabel: group.label,
    body: renderReportText(report, reportLink(clientId, month)),
    createdBy: user.id,
    createdByName: user.name,
  });

  if (!res.ok) return { ok: false, message: res.error ?? "WhatsApp wouldn't take it." };

  // Recorded against the month, so the scheduled batch on the 1st does not
  // send this client a second copy of a report they have already had.
  await markReportSent(clientId, month, group.label);
  return { ok: true, message: `Sent to ${group.label}.` };
}
