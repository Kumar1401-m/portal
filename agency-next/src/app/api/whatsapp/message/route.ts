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
import { logIncomingMessage, clientForGroup } from "@/lib/whatsapp-approvals";
import { sendTextToGroup } from "@/lib/whatsapp-service-client";
import {
  clientFacts,
  composeReply,
  shouldAutoReply,
  markReplied,
} from "@/lib/whatsapp-ai";

export const dynamic = "force-dynamic";

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/**
 * Answer the client, when answering is the right thing to do.
 *
 * Entirely best-effort and deliberately swallows everything: this runs after
 * the transcript is safely written, and a reply that cannot be composed or
 * sent must never turn a logged message into a failed one. The service reads
 * the `ok` of this response to decide whether the approval pipeline is
 * healthy.
 *
 * Awaited rather than left dangling — the platform freezes a serverless
 * function the moment it responds, so a floating promise here would simply
 * never run.
 */
async function maybeAnswer(input: {
  groupId: string;
  direction: string;
  parsedCommand: string | null;
  message: string | null;
  senderName: string | null;
}): Promise<boolean> {
  try {
    const gate = shouldAutoReply(input);
    if (!gate.reply) return false;

    // An unlinked group belongs to nobody, so there are no facts that may
    // safely be shared in it.
    const clientId = await clientForGroup(input.groupId);
    if (!clientId) return false;

    const facts = await clientFacts(clientId);
    if (!facts) return false;

    const reply = await composeReply(facts, input.message || "", input.senderName);
    if (!reply) return false;

    const sent = await sendTextToGroup(input.groupId, reply);
    if (!sent.ok) return false;

    markReplied(input.groupId);

    // The transcript is the record of what the client was told, so our own
    // answers belong in it as much as theirs do.
    await logIncomingMessage({
      waMessageId: sent.messageId ?? null,
      groupId: input.groupId,
      groupName: null,
      senderName: "Assistant",
      senderNumber: null,
      message: reply,
      videoCode: null,
      parsedCommand: "ai_reply",
      direction: "out",
      time: null,
    }).catch(() => {});

    return true;
  } catch (err) {
    console.warn("[whatsapp] auto-reply skipped:", err instanceof Error ? err.message : err);
    return false;
  }
}

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

    const replied = await maybeAnswer({
      groupId,
      direction: body.direction === "out" ? "out" : "in",
      parsedCommand: str(body.parsedCommand),
      message: str(body.message),
      senderName: str(body.senderName),
    });

    return Response.json({ ok: true, logged: true, replied });
  } catch (err) {
    console.warn("[whatsapp] message log failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: true, logged: false });
  }
}
