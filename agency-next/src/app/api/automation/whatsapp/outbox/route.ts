/**
 * GET /api/automation/whatsapp/outbox
 *
 * Sends the reminders a super admin scheduled for a particular time. Called
 * every few minutes; a run with nothing due is a cheap no-op.
 *
 * Kept apart from `/whatsapp/run`, which is the nightly rules engine. They
 * want opposite schedules: the rules should fire once a day at a civilised
 * hour, and this should fire often enough that "6pm" means 6pm. Folding the
 * two together would mean choosing one cadence and being wrong for the other.
 *
 * Overlapping calls are safe. Each message is claimed with a conditional
 * UPDATE before it is sent, so two runners cannot both send the same one.
 */
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/api-auth";
import { sendDueMessages } from "@/lib/reminder-outbox";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await sendDueMessages();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Outbox run failed" },
      { status: 500 }
    );
  }
}
