/**
 * GET /api/automation/insights/brain
 *
 * Runs the Marketing Brain across every client on the floor and stores what it
 * found in `ai_insights` — so the AI board has something on it before anybody
 * opens it, which is the whole difference between an assistant and a search box.
 *
 * Best run after the post-insights sync, since it reads what that wrote. On a
 * nightly schedule that means: ads sync → insights sync → this.
 *
 * Safe to run twice — one row per client per kind, updated in place, and
 * findings that have stopped being true are removed on each run.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 */
import { guard, ok, fail } from "@/lib/automation-api";
import { refreshInsights, insightsReady } from "@/lib/ai-insights";
import { recordRun } from "@/lib/automation-runs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  if (!(await insightsReady())) {
    return fail("The ai_insights table isn't in this database yet.", 503, "schema");
  }

  const result = await refreshInsights();
  await recordRun(
    "ai_insights",
    true,
    // The reason, when there is one — see refreshInsights. A nightly job that
    // reports nothing and does not say why is a job nobody can fix.
    result.skipped ??
      `${result.found} findings across ${result.clients} clients` +
        (result.cleared ? `, ${result.cleared} cleared` : "")
  ).catch(() => {});

  return ok(result);
}
