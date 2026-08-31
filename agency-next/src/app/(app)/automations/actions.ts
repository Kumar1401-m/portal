"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { syncAllPosts, insightsReady } from "@/lib/analytics";
import { publishingReadiness } from "@/lib/instagram";
import { runPublisher } from "@/lib/instagram-publish";
import { runApprovalClock } from "@/lib/whatsapp-reminders";
import { queueMonthlyReports } from "@/lib/monthly-report";
import { recordRun } from "@/lib/automation-runs";
import { thisMonthKey, shiftMonth } from "@/lib/date-range";

export type RunState = { ok: boolean; message: string };

/**
 * The jobs the portal can run itself.
 *
 * Everything else on the map lives in n8n or in the WhatsApp service, and a
 * button here that pretended to start those would be a button that lies when
 * they are down. These are ours, so they get one.
 */

/**
 * Publish whatever is due, now.
 *
 * The publisher is meant to run every quarter hour, and on the free Vercel
 * plan the only wired schedule fires once a day — so "it was approved and it
 * still has not gone out" is a thing that happens, and until now there was
 * nowhere in the portal to do anything about it. Somebody had to wait for
 * tomorrow's cron.
 *
 * The same call the schedule makes, with the same claiming, so pressing it
 * while a scheduled run is in flight cannot double-post: a video is claimed
 * before anything is sent to Instagram.
 *
 * This is not a substitute for the clock. It is what you press at four in the
 * afternoon when a client is asking, and it is why the button says what it
 * actually did rather than just "done".
 */
export async function runPublisherAction(): Promise<RunState> {
  await requireUser(ADMIN_ROLES);

  const readiness = await publishingReadiness();
  if (!readiness.ready) {
    await recordRun("publishing", false, readiness.reason ?? "Not set up.");
    return { ok: false, message: readiness.reason ?? "Publishing is not set up." };
  }

  const r = await runPublisher(3);
  const summary =
    r.considered === 0
      ? "Nothing was due."
      : `${r.posted} posted, ${r.pending} still encoding, ${r.failed} failed.`;
  await recordRun("publishing", r.failed === 0, summary);

  // The approval clock rides with the publisher on the schedule, so it rides
  // with it here too — otherwise pressing this by hand quietly skips the half
  // of the job that decides what is allowed to publish next.
  const clock = await runApprovalClock().catch(() => null);

  revalidatePath("/automations");
  revalidatePath("/dashboard");
  revalidatePath("/deliverables");

  const clockNote =
    clock && (clock.chased || clock.approved)
      ? ` Also chased ${clock.chased} and auto-approved ${clock.approved}.`
      : "";

  return {
    ok: r.failed === 0,
    message:
      (r.considered === 0
        ? "Nothing was due to go out. Anything approved is waiting for its scheduled time."
        : summary) + clockNote,
  };
}
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
