/**
 * POST /api/whatsapp/message
 *
 * The transcript. Every inbound group message lands here, whether or not it
 * parsed as a command — most of a client group is ordinary conversation, and
 * that context is exactly what makes the log worth keeping when someone says
 * "we told you to change it".
 *
 * Always answers 200 when authorised. A transcript write failing must never
 * make the service think the approval itself failed.
 *
 * Auth: Authorization: Bearer <WHATSAPP_SERVICE_KEY>
 */
import { isAuthorizedWhatsAppRequest, unauthorized } from "@/lib/api-auth";
import { logIncomingMessage } from "@/lib/whatsapp-approvals";

export const dynamic = "force-dynamic";

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

export async function POST(request: Request) {
  if (!isAuthorizedWhatsAppRequest(request)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const groupId = str(body.groupId);
  if (!groupId) return Response.json({ ok: false, error: "groupId is required." }, { status: 400 });

  try {
    await logIncomingMessage({
      waMessageId: str(body.waMessageId),
      groupId,
      groupName: str(body.groupName),
      senderName: str(body.senderName),
      senderNumber: str(body.senderNumber),
      message: str(body.message),
      videoCode: str(body.videoCode),
      parsedCommand: str(body.parsedCommand),
      direction: body.direction === "out" ? "out" : "in",
      time: str(body.time),
    });
    return Response.json({ ok: true, logged: true });
  } catch (err) {
    console.warn("[whatsapp] message log failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: true, logged: false });
  }
}
