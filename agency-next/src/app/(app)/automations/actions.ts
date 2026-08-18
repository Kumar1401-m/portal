"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { syncAllPosts, insightsReady } from "@/lib/analytics";
import { queueMonthlyReports } from "@/lib/monthly-report";
import { recordRun } from "@/lib/automation-runs";
import { thisMonthKey, shiftMonth } from "@/lib/date-range";

export type RunState = { ok: boolean; message: string };

/**
 * The two jobs the portal can run itself.
 *
 * Everything else on the map lives in n8n or in the WhatsApp service, and a
 * button here that pretended to start those would be a button that lies when
 * they are down. These two are ours, so they get one.
 */
export async function runInsightsSyncAction(): Promise<RunState> {
  await requireUser(ADMIN_ROLES);
  if (!(await insightsReady())) {
    return { ok: false, message: "Apply the pending database changes in Settings first." };
  }

  const r = await syncAllPosts();
  const summary = `${r.posts} posts across ${r.clients} clients${r.failed ? `, ${r.failed} failed` : ""}`;
  // Recorded even when it was a person who pressed it — the heartbeat answers
  // "when did this last work", and a manual run is still it working.
  await recordRun("insights_sync", r.failed === 0, summary);

  revalidatePath("/automations");
  revalidatePath("/analytics");
  return { ok: r.failed === 0, message: `Updated ${summary}.` };
}

/**
 * Queue last month's reports.
 *
 * Last month, not this one: run on the 1st the interesting month is the one
 * that just finished, and that is the only day anybody presses this by hand.
 * Nothing is sent — every report lands in the outbox where it can be read
 * before it reaches a client.
 */
export async function queueReportsAction(): Promise<RunState> {
  const user = await requireUser(ADMIN_ROLES);

  const month = shiftMonth(thisMonthKey(), -1);
  const r = await queueMonthlyReports(month, undefined, { id: user.id, name: user.name });
  await recordRun("monthly_reports", true, `${r.queued} queued for ${month}`);

  revalidatePath("/automations");
  revalidatePath("/settings/reminders");

  const skipped = r.skipped.length
    ? ` ${r.skipped.length} skipped (${r.skipped
        .slice(0, 3)
        .map((s) => `${s.client}: ${s.reason}`)
        .join("; ")}${r.skipped.length > 3 ? "…" : ""}).`
    : "";
  return {
    ok: r.queued > 0,
    message: r.queued
      ? `${r.queued} report${r.queued === 1 ? "" : "s"} for ${month} are in the outbox — read them in Settings → Reminders before they go.${skipped}`
      : `Nothing to send for ${month}.${skipped}`,
  };
}
