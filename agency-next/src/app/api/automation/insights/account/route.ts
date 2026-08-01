/**
 * POST /api/automation/insights/account
 *
 * Stores one day of account-level Instagram metrics for one client.
 *
 * Accepts either shape:
 *   - `insights`: the Graph API response pasted straight through, which is
 *     what an n8n HTTP Request node produces with no transformation at all;
 *   - flat fields (`reach`, `profile_visits`, …) for anything the workflow
 *     computed itself.
 *
 * Flat fields win where both are present, so a workflow can let the parser do
 * the work and still override one number it knows better.
 *
 * Idempotent by (client, platform, date): re-running the day, or backfilling,
 * updates in place instead of duplicating.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body: { "client_id": 4, "date": "2026-07-31",
 *         "insights": { "data": [ … ] },      // raw Graph response
 *         "followers": 12043,                 // from /{ig-user-id}?fields=followers_count
 *         "posts_count": 2 }
 */
import { readAuthorized, ok, fail, asInt, asStr, asDate } from "@/lib/automation-api";
import { saveAccountSnapshot, analyticsReady } from "@/lib/analytics";
import { parseAccountInsights } from "@/lib/meta-insights";
import { queryOne } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  if (!(await analyticsReady())) {
    return fail(
      "Analytics columns are missing. Run database/migrate.js, or apply them from Settings → Database.",
      503,
      "schema_missing"
    );
  }

  const clientId = asInt(body.client_id);
  if (!clientId) return fail("client_id is required.", 400, "missing_client");

  const client = await queryOne<{ id: number }>("SELECT id FROM clients WHERE id = ?", [clientId]);
  if (!client) return fail("No such client.", 404, "not_found");

  const date = asDate(body.date);
  const parsed = parseAccountInsights(body.insights as never, { sum: body.sum_range === true });

  // `??` rather than `||` throughout: a genuine 0 from the workflow must not
  // fall through to the parsed value.
  const pick = (flat: unknown, fromInsights: number) =>
    flat === undefined || flat === null || flat === "" ? fromInsights : asInt(flat);

  await saveAccountSnapshot({
    clientId,
    platform: asStr(body.platform) || "instagram",
    date,
    followers: asInt(body.followers ?? body.followers_count),
    followerDelta: pick(body.follower_delta ?? body.follower_count, parsed.followerDelta),
    reach: pick(body.reach, parsed.reach),
    impressions: pick(body.impressions, parsed.impressions),
    views: pick(body.views, parsed.views),
    accountsEngaged: pick(body.accounts_engaged, parsed.accountsEngaged),
    profileVisits: pick(body.profile_visits ?? body.profile_views, parsed.profileVisits),
    websiteClicks: pick(body.website_clicks, parsed.websiteClicks),
    reelPlays: asInt(body.reel_plays),
    likes: pick(body.likes, parsed.likes),
    comments: pick(body.comments, parsed.comments),
    shares: pick(body.shares, parsed.shares),
    saves: pick(body.saves, parsed.saves),
    totalInteractions: pick(body.total_interactions, parsed.totalInteractions),
    postsCount: asInt(body.posts_count),
    // The untouched response is kept so a metric we don't read today can still
    // be recovered from history later, without a re-fetch Meta may no longer
    // serve.
    raw: body.insights ?? null,
  });

  return ok({ client_id: clientId, date, stored: true });
}
