/**
 * POST /api/whatsapp/approve
 *
 * A client replied APPROVE / CHANGE / REJECT in their WhatsApp group. The
 * service has parsed it; this records the verdict.
 *
 * Idempotent on `waMessageId` — WhatsApp replays messages after a reconnect,
 * so the same approval arrives more than once. A replay returns
 * `alreadyRecorded: true` and changes nothing, which is what tells the service
 * not to send the client a second confirmation.
 *
 * Auth: Authorization: Bearer <WHATSAPP_SERVICE_KEY>
 * Body: { videoId, status, command, approvedBy, approvedNumber, message,
 *         comment, groupId, groupName, waMessageId, time }
 */
import { isAuthorizedWhatsAppRequest, unauthorized } from "@/lib/api-auth";
import { recordApproval } from "@/lib/whatsapp-approvals";

export const dynamic = "force-dynamic";

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Accept either an explicit command or the human-readable status. */
function resolveCommand(body: Record<string, unknown>): "approve" | "change" | "reject" | null {
  const raw = String(body.command ?? body.status ?? "").toLowerCase();
  if (raw.includes("approve")) return "approve";
  if (raw.includes("change")) return "change";
  if (raw.includes("reject")) return "reject";
  return null;
}

export async function POST(request: Request) {
  if (!isAuthorizedWhatsAppRequest(request)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const videoCode = str(body.videoId) || str(body.videoCode);
  if (!videoCode) {
    return Response.json({ ok: false, error: "videoId is required." }, { status: 400 });
  }

  const command = resolveCommand(body);
  if (!command) {
    return Response.json(
      { ok: false, error: 'Unrecognised command — expected "approve", "change" or "reject".' },
      { status: 400 }
    );
  }

  const result = await recordApproval({
    videoCode,
    command,
    approvedBy: str(body.approvedBy),
    approvedNumber: str(body.approvedNumber),
    message: str(body.message),
    comment: str(body.comment),
    groupId: str(body.groupId),
    groupName: str(body.groupName),
    waMessageId: str(body.waMessageId),
    time: str(body.time),
  });

  if (!result.ok) {
    // 422, not 500: an unknown video code or a group mismatch is a fact about
    // the request, and the service tells the client rather than retrying.
    return Response.json(result, { status: 422 });
  }

  return Response.json(result);
}
