/**
 * GET /api/automation/whatsapp/run
 *
 * Every WhatsApp reminder the agency would otherwise send by hand: chasing
 * approvals, asking for footage, the month's plan, unpaid invoices, and the
 * team's own daily digest.
 *
 * Safe to call as often as you like. Each reminder is claimed with a unique
 * key before it is sent, so overlapping runs cannot double-send and a run
 * that finds nothing due is a no-op.
 *
 * The team digest needs a group id — `WHATSAPP_TEAM_GROUP_ID`. Without it
 * every other reminder still runs; only the internal digest is skipped, since
 * there is nowhere to put it.
 */
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/api-auth";
import { runReminders } from "@/lib/whatsapp-reminders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runReminders({
      teamGroupId: process.env.WHATSAPP_TEAM_GROUP_ID || null,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Reminder run failed" },
      { status: 500 }
    );
  }
}
