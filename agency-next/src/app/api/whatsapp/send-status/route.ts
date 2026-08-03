/**
 * POST /api/whatsapp/send-status
 *
 * Outbound progress for one video: sending → sent → delivered → read, or
 * failed. Called once per attempt, not just at the end, so the send log shows
 * "went out on the third try, 90 seconds late" rather than only the verdict.
 *
 * Delivery receipts arrive later and carry only the WhatsApp message id, so
 * the deliverable is resolved from that.
 *
 * Auth: Authorization: Bearer <WHATSAPP_SERVICE_KEY>
 */
import { isAuthorizedWhatsAppRequest, unauthorized } from "@/lib/api-auth";
import { recordSendStatus } from "@/lib/whatsapp-approvals";

export const dynamic = "force-dynamic";

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const int = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

const STATUSES = new Set(["queued", "sending", "sent", "delivered", "read", "failed"]);

export async function POST(request: Request) {
  if (!isAuthorizedWhatsAppRequest(request)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const raw = String(body.status ?? "").toLowerCase();
  if (!STATUSES.has(raw)) {
    return Response.json(
      { ok: false, error: `Unknown status "${raw}". Expected one of: ${[...STATUSES].join(", ")}.` },
      { status: 400 }
    );
  }

  try {
    await recordSendStatus({
      deliverableId: int(body.deliverableId),
      videoCode: str(body.videoCode),
      groupId: str(body.groupId),
      attemptNo: int(body.attemptNo) ?? 1,
      status: raw as "queued" | "sending" | "sent" | "delivered" | "read" | "failed",
      waMessageId: str(body.waMessageId),
      mediaBytes: int(body.mediaBytes),
      durationMs: int(body.durationMs),
      errorCode: str(body.errorCode),
      errorMessage: str(body.errorMessage),
    });
    return Response.json({ ok: true });
  } catch (err) {
    // Logged, never fatal: the send itself may well have succeeded, and
    // failing this call would make the service retry a delivered video.
    console.warn("[whatsapp] send-status failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: true, recorded: false });
  }
}
