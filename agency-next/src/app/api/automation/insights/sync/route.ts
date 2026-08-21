/**
 * GET /api/automation/insights/sync
 *
 * Reads every client's recent Instagram posts back into `post_insights` —
 * reach, likes, comments, saves, shares — which is what the Analytics board
 * and the monthly report are built from.
 *
 * Nightly. Meta keeps revising a post's numbers for about two days after it
 * goes out, so anything that recent is re-read on every run and everything
 * older is skipped: after the first sweep this costs a handful of calls per
 * client rather than one per post.
 *
 * Safe to run twice — every row is an upsert on the media id.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 */
import { guard, ok, fail } from "@/lib/automation-api";
import { syncAllPosts, insightsReady } from "@/lib/analytics";
import { recordRun } from "@/lib/automation-runs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  if (!(await insightsReady())) {
    return fail("The post_insights table isn't in this database yet.", 503, "schema");
  }

  const result = await syncAllPosts();

  await recordRun(
    "insights_sync",
    result.failed === 0,
    `${result.posts} posts across ${result.clients} clients` +
      // The name and the reason, not the tally. "1 failed" on the
      // Automations page is a red dot nobody can act on.
      result.problems.map((p) => `. ${p.client}: ${p.error}`).join("")
  ).catch(() => {});

  // 200 even with per-client failures, like the ads sync: one expired token is
  // not a reason for the whole nightly job to show red.
  return ok(result);
}
