/**
 * GET /api/automation/decisions
 *
 * The night shift. Reads every board the portal keeps — money, work, the
 * Brain's findings, what the learning loop has proven — decides which few
 * things actually need somebody tomorrow morning, and puts them in the
 * notification bell with a link to act on.
 *
 * Run last on the nightly chain, after the two that write what it reads:
 * insights sync → brain → this.
 *
 * Safe to run twice. A decision is claimed by its title for a week, so a
 * second run the same night sends nothing and an invoice that is still overdue
 * on Thursday does not produce a fourth notification about it.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 */
import { guard, ok } from "@/lib/automation-api";
import { runDecisions } from "@/lib/decisions";
import { recordRun } from "@/lib/automation-runs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  const result = await runDecisions();
  await recordRun(
    "ai_decisions",
    true,
    `${result.sent.length} sent of ${result.considered} considered` +
      (result.skipped ? `, ${result.skipped} already said` : "")
  ).catch(() => {});

  return ok({
    considered: result.considered,
    sent: result.sent.map((d) => ({ title: d.title, urgency: Math.round(d.urgency), source: d.source })),
    skipped: result.skipped,
    brief: result.brief,
  });
}
