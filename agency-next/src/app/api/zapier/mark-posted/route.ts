/**
 * POST /api/zapier/mark-posted
 * Called by a "Webhooks by Zapier" action step, right after the "Instagram
 * for Business: Publish Video" step succeeds — closes the loop so the
 * deliverable doesn't get offered by /ready-to-post again.
 *
 * Auth: Authorization: Bearer <ZAPIER_API_KEY>  (see src/lib/api-auth.ts)
 * Body (JSON): { "deliverable_id": number, "instagram_media_id"?: string, "permalink"?: string }
 */
import { isAuthorizedZapierRequest, unauthorized } from "@/lib/api-auth";
import { markPostedToInstagram } from "@/lib/zapier";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedZapierRequest(request)) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const deliverableId = Number(b.deliverable_id);
  if (!deliverableId) {
    return Response.json({ ok: false, error: "deliverable_id is required." }, { status: 400 });
  }

  const mediaId = typeof b.instagram_media_id === "string" ? b.instagram_media_id : null;
  const permalink = typeof b.permalink === "string" ? b.permalink : null;

  const result = await markPostedToInstagram(deliverableId, mediaId, permalink);
  if (!result.ok) return Response.json(result, { status: 404 });
  return Response.json(result);
}
