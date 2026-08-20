/**
 * GET /api/automation/publish/run
 *
 * Publish whatever is due. This is the whole publisher — the workflow that
 * used to do it lived on a server that had to be kept running, and this does
 * not.
 *
 * Called on a schedule by anything that can fetch a URL: Vercel Cron, or a
 * free external cron service when the plan's once-a-day limit is too coarse
 * for scheduled posting. A GET with no body because that is the common
 * denominator of all of them.
 *
 * Safe to call as often as you like. Each video is claimed before anything is
 * sent to Instagram, so two overlapping runs cannot post the same reel, and a
 * video still encoding is resumed rather than started again.
 *
 * Auth: Authorization: Bearer <CRON_SECRET or N8N_API_KEY>
 */
import { isAuthorizedCronRequest, unauthorized } from "@/lib/api-auth";
import { ok } from "@/lib/automation-api";
import { publishingReadiness } from "@/lib/instagram";
import { runPublisher } from "@/lib/instagram-publish";
import { recordRun } from "@/lib/automation-runs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorized();

  // Reported rather than treated as an empty queue: "nothing to post" and
  // "this was never set up" look identical otherwise, and the second stays
  // silent for as long as nobody checks.
  const readiness = await publishingReadiness();
  if (!readiness.ready) {
    // Recorded as a failed run, not skipped silently. A portal that cannot
    // publish should say so on the Automations page rather than looking idle.
    await recordRun("publishing", false, readiness.reason ?? "Not set up.");
    return ok({ posted: 0, skipped: readiness.reason });
  }

  const summary = await runPublisher(3);

  /*
   * A heartbeat, so the question "is posting working?" has an answer.
   *
   * The publisher left no trace of having run, which made two very different
   * situations identical from every screen in the portal: a schedule nobody
   * had wired, and one running every quarter hour with nothing due. The first
   * is the reason a client's feed goes quiet for a week, and it was invisible.
   *
   * "Ran and posted nothing" is a success — most runs have nothing to do.
   * Failure is reserved for a run that tried and could not.
   */
  await recordRun(
    "publishing",
    summary.failed === 0,
    summary.considered === 0
      ? "Nothing was due."
      : `${summary.posted} posted, ${summary.pending} still encoding, ${summary.failed} failed.`
  );
  return ok(summary);
}
