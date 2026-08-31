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
  holdingReply,
  recentTurns,
  shouldAutoReply,
  markReplied,
  emojiReply,
  unheardVoiceReply,
} from "@/lib/whatsapp-ai";
import { groupAllows } from "@/lib/whatsapp-groups";
import { clientWants } from "@/lib/client-messages";
import { notifyAdmins } from "@/lib/notify";

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
  addressed?: boolean;
  voiceUnreadable?: boolean;
}): Promise<boolean> {
  try {
    const gate = shouldAutoReply(input);
    if (!gate.reply) return false;

    // An unlinked group belongs to nobody, so there are no facts that may
    // safely be shared in it.
    const clientId = await clientForGroup(input.groupId);
    if (!clientId) return false;

    /*
     * And whether the assistant is wanted in *this* chat.
     *
     * A client can have several groups with us, and the one where their own
     * people talk among themselves is not a room a robot should answer in.
     * Checked after the group is attributed rather than before, so an
     * unlinked group is still rejected for the older, stronger reason: it
     * belongs to nobody, so there are no facts that may safely be shared.
     *
     * Ticked by default, so this changes nothing until somebody unticks it.
     */
    if (!(await groupAllows(input.groupId, "chat"))) return false;

    /*
     * And whether this client wants an assistant at all.
     *
     * Two switches for one behaviour, and they answer different questions: the
     * group one is "not in this room", the client one is "not for us". A
     * client who says the replies are unwelcome should not have to have that
     * unticked on each of their groups one at a time, and should not find it
     * back the day somebody links a new one.
     */
    if (!(await clientWants(clientId, "ai_replies"))) return false;

    /*
     * Three answers that need no model, and must not wait for one.
     *
     * A voice note we could not hear has no words to answer, and an emoji has
     * nothing to look up — sending either through the model would spend a
     * call to arrive somewhere worse.
     *
     * `hold` is the third: a message too long to be a question. It is not sent
     * to the model, because an answer drawn confidently from the wrong half of
     * a long message is worse than none — but it is answered, warmly, and the
     * team is told below. That is the whole of the difference between "we're
     * on it" and being left on read.
     */
    const quick = input.voiceUnreadable
      ? unheardVoiceReply(input.senderName)
      : gate.kind === "emoji"
        ? emojiReply(input.message || "", input.senderName)
        : gate.kind === "hold"
          ? holdingReply(input.senderName)
          : null;

    /*
     * A promise of a reply, with somebody behind it.
     *
     * The holding line commits the agency to coming back to them, and a
     * promise nothing is listening to is worse than the silence it replaced.
     * The emoji and unheard-voice replies need no such thing: neither of them
     * says anyone will follow up.
     */
    if (quick && gate.kind === "hold") {
      const facts = await clientFacts(clientId).catch(() => null);
      await notifyAdmins(
        "general",
        `${facts?.companyName || "A client"} sent a long message`,
        `${input.senderName || "They"} wrote: "${(input.message || "").slice(0, 200)}…". ` +
          `It was too long to answer automatically — they've been told someone will come back to them.`,
        `/clients/${clientId}`
      ).catch(() => {});
    }

    if (quick) {
      const out = await sendTextToGroup(input.groupId, quick);
      if (!out.ok) return false;
      markReplied(input.groupId);
      await logIncomingMessage({
        waMessageId: out.messageId ?? null,
        groupId: input.groupId,
        groupName: null,
        senderName: "Assistant",
        senderNumber: null,
        message: quick,
        videoCode: null,
        parsedCommand: "ai_reply",
        direction: "out",
        time: null,
      }).catch(() => {});
      return true;
    }

    // The record and the conversation. Without the second, "and the other
    // one?" — which is how people actually talk in a chat — could only be
    // answered by asking them to say it again.
    const [facts, history] = await Promise.all([
      clientFacts(clientId),
      recentTurns(input.groupId),
    ]);
    if (!facts) return false;

    /*
     * A question we cannot answer still gets an answer.
     *
     * When the model is switched off or unreachable, the client used to get
     * silence — which, to someone who has just asked their agency a question,
     * is indistinguishable from being ignored. They get a thank-you and a
     * promise of a person instead, and the notification below is what makes
     * that promise true rather than a nicer way of ignoring them.
     */
    const composed = await composeReply(facts, input.message || "", input.senderName, history);
    const reply = composed ?? holdingReply(input.senderName);

    const sent = await sendTextToGroup(input.groupId, reply);
    if (!sent.ok) return false;

    if (!composed) {
      await notifyAdmins(
        "general",
        `${facts.companyName} asked a question`,
        `${input.senderName || "They"} wrote: "${(input.message || "").slice(0, 200)}". ` +
          `They've been told someone will come back to them.`,
        `/clients/${clientId}`
      ).catch(() => {});
    }

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
      addressed: body.addressed === true,
      voiceUnreadable: body.voiceUnreadable === true,
    });

    return Response.json({ ok: true, logged: true, replied });
  } catch (err) {
    console.warn("[whatsapp] message log failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: true, logged: false });
  }
}
