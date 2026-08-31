import { NextResponse, type NextRequest } from "next/server";
import { queryOne, hasColumn } from "@/lib/db";
import { resolveVideoUrl } from "@/lib/storage";
import { verifyVideoToken } from "@/lib/video-link";

export const dynamic = "force-dynamic";

/**
 * The permanent address of an uploaded video: mints a fresh signed R2 URL and
 * redirects to it. Deliberately outside the signed-in area — Instagram, n8n
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

  /*
   * `?bytes=1` — the same video, served from here instead of redirected to.
   *
   * This exists for exactly one caller: the browser decoding frames out of a
   * video that was uploaded before frames were a thing. It cannot use the
   * redirect above, and the reason is worth writing down because it looks like
   * it should work.
   *
   * Playing a cross-origin video is fine. *Reading pixels back out of it* is
   * not: the moment a cross-origin frame is drawn to a canvas the canvas is
   * tainted, and `toDataURL` throws SecurityError rather than returning an
   * image. That is a browser security rule, not an R2 setting — and it is why
   * frames could only ever be taken at upload time, when the file was already
   * a local `File` and no origin was involved.
   *
   * Coming through here the bytes are same-origin. The browser turns them into
   * a `blob:` URL, the canvas stays clean, and every video the agency has ever
   * uploaded becomes readable — without touching the bucket's CORS policy,
   * which is a setting in somebody else's dashboard and cannot be fixed from
   * code.
   *
   * The body is streamed, never buffered: a finished reel is tens of
   * megabytes and holding one in a serverless function's memory to hand it
   * straight back out is how that function runs out of it.
   */
  if (req.nextUrl.searchParams.get("bytes") === "1") {
    const upstream = await fetch(signed).catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      return new NextResponse("Video unavailable", { status: 502 });
    }
    return new NextResponse(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "video/mp4",
        ...(upstream.headers.get("content-length")
          ? { "Content-Length": upstream.headers.get("content-length")! }
          : {}),
        "Cache-Control": "no-store, max-age=0",
      },
    });
  }

  // 302, never cached: the target is short-lived and must be re-minted.
  return NextResponse.redirect(signed, {
    status: 302,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
