/**
 * GET /api/automation/insights/targets
 *
 * Step 1 of the daily analytics workflow: which accounts to read, and which
 * of their posts are worth re-reading.
 *
 * Returning the media list from here rather than letting n8n call
 * /{ig-user-id}/media itself is deliberate — the portal already knows which
 * posts it published and when, so the workflow only spends Graph API calls on
 * posts inside the freshness window instead of walking the whole feed.
 *
 * Auth:  Authorization: Bearer <N8N_API_KEY>
 * Query: days — how far back to refresh post metrics (default 30, max 90)
 */
import { guard, ok } from "@/lib/automation-api";
import { query, hasColumn } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

type ClientRow = {
  client_id: number;
  company_name: string;
  ig_user_id: string;
  ig_username: string | null;
  ig_access_token: string | null;
};

type MediaRow = { client_id: number; deliverable_id: number; media_id: string; published_at: string };

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  if (!(await hasColumn("clients", "analytics_enabled"))) {
    return ok({ count: 0, clients: [], note: "Analytics columns not migrated yet." });
  }

  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("days"));
  // Instagram keeps serving insights for old media, but a post older than a
  // month has essentially stopped moving — refreshing it every night spends
  // rate limit for nothing.
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 90) : 30;

  const clients = await query<ClientRow>(
    `SELECT c.id AS client_id, c.company_name, c.ig_user_id, c.ig_username, c.ig_access_token
       FROM clients c
      WHERE c.status <> 'churned'
        AND c.analytics_enabled = 1
        AND c.ig_user_id IS NOT NULL AND c.ig_user_id <> ''
      ORDER BY c.company_name`
  );

  const media = await query<MediaRow>(
    `SELECT d.client_id, d.id AS deliverable_id, d.instagram_media_id AS media_id,
            COALESCE(d.instagram_posted_at, d.posted_at) AS published_at
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id
      WHERE c.status <> 'churned'
        AND c.analytics_enabled = 1
        AND d.instagram_media_id IS NOT NULL AND d.instagram_media_id <> ''
        AND COALESCE(d.instagram_posted_at, d.posted_at) >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY published_at DESC`,
    [days]
  );

  const byClient = new Map<number, MediaRow[]>();
  for (const m of media) {
    const list = byClient.get(m.client_id) || [];
    list.push(m);
    byClient.set(m.client_id, list);
  }

  return ok({
    count: clients.length,
    window_days: days,
    // The date the metrics will describe. Yesterday, not today: Instagram's
    // day-scoped metrics for the current day are still accumulating, so
    // storing them would record a partial day as a real one and put a fake
    // trough at the end of every chart.
    snapshot_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    clients: clients.map((c) => ({
      client_id: c.client_id,
      client_name: c.company_name,
      ig_user_id: c.ig_user_id,
      ig_username: c.ig_username,
      // Per-client token when the account sits outside the agency's Business
      // Manager; otherwise n8n falls back to its own META_ACCESS_TOKEN.
      access_token: c.ig_access_token || null,
      uses_agency_token: !c.ig_access_token,
      media: (byClient.get(c.client_id) || []).map((m) => ({
        media_id: m.media_id,
        deliverable_id: m.deliverable_id,
        published_at: m.published_at,
      })),
    })),
    agency_token_configured: env.meta.enabled,
  });
}
