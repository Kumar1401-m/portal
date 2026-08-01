/**
 * POST /api/automation/insights/posts
 *
 * Stores per-post Instagram metrics. Takes a batch, because the daily job
 * reads a month of posts per client and one HTTP call per post would turn a
 * 20-client agency into thousands of requests a night.
 *
 * Each entry may carry the raw Graph insights response, the media object
 * (`like_count`, `permalink`, `timestamp`…), or flat numbers — see
 * src/lib/meta-insights.ts for why all three exist.
 *
 * Partial success is the normal case: one post whose insights Meta refuses
 * (too new, wrong media type) must not discard the other nineteen. Every entry
 * is attempted and the response reports per-entry outcomes.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body: { "client_id": 4, "date": "2026-07-31", "posts": [
 *           { "media_id": "178…", "media": { … }, "insights": { "data": [ … ] } } ] }
 */
import { readAuthorized, ok, fail, asInt, asStr, asDate, asDateTime } from "@/lib/automation-api";
import { savePostInsight, analyticsReady } from "@/lib/analytics";
import { parseMediaInsights, mergeMediaCounts } from "@/lib/meta-insights";
import { queryOne } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Guard against a runaway workflow posting an unbounded batch. */
const MAX_BATCH = 200;

type MediaObject = {
  id?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
  caption?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
};

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

  // A single post may be sent unwrapped, which is what an n8n loop over items
  // produces without an aggregate step.
  const rawPosts = Array.isArray(body.posts) ? body.posts : body.media_id ? [body] : [];
  if (!rawPosts.length) return fail("posts[] is required.", 400, "missing_posts");
  if (rawPosts.length > MAX_BATCH) {
    return fail(`Too many posts in one call (max ${MAX_BATCH}).`, 413, "batch_too_large");
  }

  const date = asDate(body.date);
  const platform = asStr(body.platform) || "instagram";
  const stored: string[] = [];
  const skipped: { media_id: string | null; reason: string }[] = [];

  for (const raw of rawPosts) {
    const post = (raw ?? {}) as Record<string, unknown>;
    const media = (post.media ?? {}) as MediaObject;
    const mediaId = asStr(post.media_id) || asStr(media.id);
    if (!mediaId) {
      skipped.push({ media_id: null, reason: "no media_id" });
      continue;
    }

    try {
      const insights = mergeMediaCounts(parseMediaInsights(post.insights as never), media);
      const pick = (flat: unknown, fromInsights: number) =>
        flat === undefined || flat === null || flat === "" ? fromInsights : asInt(flat);

      await savePostInsight({
        clientId,
        platform,
        mediaId,
        date: asDate(post.date ?? date),
        deliverableId: post.deliverable_id ? asInt(post.deliverable_id) : null,
        // media_product_type distinguishes a REEL from a FEED video, which
        // media_type does not — it reports both as VIDEO.
        mediaType: asStr(post.media_type) || media.media_product_type || media.media_type || null,
        permalink: asStr(post.permalink) || media.permalink || null,
        thumbnailUrl: asStr(post.thumbnail_url) || media.thumbnail_url || media.media_url || null,
        caption: asStr(post.caption) ?? media.caption ?? null,
        publishedAt: asDateTime(post.published_at ?? media.timestamp),
        reach: pick(post.reach, insights.reach),
        impressions: pick(post.impressions, insights.impressions),
        views: pick(post.views, insights.views),
        plays: pick(post.plays, insights.plays),
        likes: pick(post.likes, insights.likes),
        comments: pick(post.comments, insights.comments),
        shares: pick(post.shares, insights.shares),
        saves: pick(post.saves, insights.saves),
        totalInteractions: pick(post.total_interactions, insights.totalInteractions),
        raw: post.insights ?? null,
      });
      stored.push(mediaId);
    } catch (err) {
      // Logged and reported, never thrown: one bad row shouldn't cost the
      // whole night's collection for this client.
      const reason = err instanceof Error ? err.message : "Unknown error";
      console.warn(`[automation] post insight failed for ${mediaId}:`, reason);
      skipped.push({ media_id: mediaId, reason });
    }
  }

  return ok({
    client_id: clientId,
    date,
    stored: stored.length,
    skipped: skipped.length,
    skipped_detail: skipped.slice(0, 20),
  });
}
