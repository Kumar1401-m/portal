/**
 * GET /api/zapier/ready-to-post
 * Polled by a Zapier "Webhooks by Zapier – Retrieve Poll" trigger. Returns
 * client-approved video content that hasn't been posted to Instagram yet.
 *
 * Auth: Authorization: Bearer <ZAPIER_API_KEY>  (see src/lib/api-auth.ts)
 * Query params:
 *   category  — content category to pull (default "Instagram Reel")
 *   limit     — max rows (default 25)
 */
import { isAuthorizedZapierRequest, unauthorized } from "@/lib/api-auth";
import { getReadyToPostToInstagram } from "@/lib/zapier";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedZapierRequest(request)) return unauthorized();

  const url = new URL(request.url);
  const category = url.searchParams.get("category") || "Instagram Reel";
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25;

  const items = await getReadyToPostToInstagram(category, limit);
  return Response.json(items);
}
