import { NextResponse, type NextRequest } from "next/server";
import { queryOne, hasColumn } from "@/lib/db";
import { resolveVideoUrl } from "@/lib/storage";
import { verifyVideoToken } from "@/lib/video-link";

export const dynamic = "force-dynamic";

/**
 * The permanent address of an uploaded video: mints a fresh signed R2 URL and
 * redirects to it. Deliberately outside the signed-in area — Instagram, Zapier
 * and whoever the client forwards it to all need to fetch it without a session.
 * The token in the query string is what grants access.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const deliverableId = Number(id);
  const token = req.nextUrl.searchParams.get("k") || "";
  if (!Number.isInteger(deliverableId) || deliverableId <= 0 || !token) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (!(await hasColumn("deliverables", "cloud_video_key"))) {
    return new NextResponse("Not found", { status: 404 });
  }

  const d = await queryOne<{ cloud_video_key: string | null; cloud_video_url: string | null }>(
    "SELECT cloud_video_key, cloud_video_url FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!d?.cloud_video_key) return new NextResponse("Not found", { status: 404 });

  // A wrong token and a missing video look the same from outside, so the URL
  // can't be used to probe which tasks have a video on them.
  if (!verifyVideoToken(deliverableId, d.cloud_video_key, token)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const signed = await resolveVideoUrl(d.cloud_video_key, d.cloud_video_url);
  if (!signed) return new NextResponse("Video unavailable", { status: 404 });

  // 302, never cached: the target is short-lived and must be re-minted.
  return NextResponse.redirect(signed, {
    status: 302,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
