/**
 * POST /api/whatsapp/intent
 *
 * What a client meant, when they did not say it in English.
 *
 * The command parser is deliberately literal — "ok", "approve", "change" and
 * a short list of near-misses. That covers a client who types, because they
 * type what the message asked them to type. It does not cover a client who
 * speaks: a voice note comes back transcribed in their own language, and
 * "సరే బాగుంది, పంపించండి" is not any of the words the parser knows. Those
 * replies were logged and then ignored — the client had answered, and as far
 * as the portal was concerned nobody had.
 *
 * So: the parser stays exactly as it is and stays first. This is only asked
 * when the parser found nothing, and it answers one question — approve,
 * change, reject, or ordinary conversation.
 *
 * Deliberately cautious about approval. Praise is not permission: a client
 * saying the reel looks lovely has not said to publish it, and in a language
 * the reader does not speak that distinction is easy to lose. The model is
 * told so, and anything short of a clear instruction comes back as `none`,
 * which leaves the message in the transcript for a person to read.
 *
 * Auth: Authorization: Bearer <WHATSAPP_SERVICE_KEY>
 * Body: { text, language? }
 */
import { isAuthorizedWhatsAppRequest, unauthorized } from "@/lib/api-auth";
import { env } from "@/lib/env";
import { ask, modelReady } from "@/lib/model";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Longer than any reply to a video; past this it is a conversation. */
const MAX_CHARS = 1500;

export type Intent = "approve" | "change" | "reject" | "status" | "none";

const INSTRUCTION = [
  "You read replies that clients of a social-media agency send in their WhatsApp group.",
  "They are answering about a video, a poster, or written content we sent them for approval.",
  "They write in Telugu, Hindi, Tamil, Kannada, English or a mix, often transliterated.",
  "",
  "Decide what the message asks us to do. Reply with JSON only:",
  '{"intent":"approve|change|reject|status|none","confidence":0.0-1.0,"note":"","summary":""}',
  "",
  "approve  — they clearly accept it and want it to go ahead.",
  "change   — they want something altered. Put what they want in `note`, in English.",
  "reject   — they do not want it used at all.",
  "status   — they are asking where things stand, not answering.",
  "none     — anything else: chat, thanks, a question, praise on its own.",
  "",
  "Be careful with approve. Praise is not permission — 'super', 'chala bagundi',",
  "'nice work' say the work is good, not that it may be published. Only choose",
  "approve when they are telling us to go ahead: 'ok post it', 'sare pettandi',",
  "'theek hai bhej do', 'approved', 'yes go ahead'. If you are unsure, choose none.",
  "",
  "`summary` is one short English sentence saying what they said, for our team.",
].join("\n");

type Parsed = { intent: Intent; confidence: number; note: string; summary: string };

const INTENTS: Intent[] = ["approve", "change", "reject", "status", "none"];

/** Model output, trusted only as far as it typechecks. */
function coerce(raw: string): Parsed | null {
  // Models fence JSON more often than not, whatever they are told.
  const body = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const intent = String(j.intent ?? "none").toLowerCase() as Intent;
  if (!INTENTS.includes(intent)) return null;
  const confidence = Number(j.confidence);
  return {
    intent,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    note: typeof j.note === "string" ? j.note.trim().slice(0, 1000) : "",
    summary: typeof j.summary === "string" ? j.summary.trim().slice(0, 300) : "",
  };
}

export async function POST(request: Request) {
  if (!isAuthorizedWhatsAppRequest(request)) return unauthorized();
  // No model, no guess. The caller treats this as "not understood", which is
  // exactly what the portal did before this route existed.
  if (!modelReady()) {
    return Response.json({ ok: true, intent: "none", confidence: 0, reason: "no model" });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ ok: false, error: "text is required." }, { status: 400 });
  if (text.length > MAX_CHARS) {
    return Response.json({ ok: true, intent: "none", confidence: 0, reason: "too long" });
  }

  /*
   * The shape is enforced, not requested.
   *
   * This used to ask for JSON in the prompt and then repair whatever came
   * back — a code fence, a missing key, a confidence of "high" instead of a
   * number. Every one of those repairs was a guess about what the model had
   * meant, on the path that decides whether a client just approved their
   * video. A strict schema removes the guessing: the decoder cannot emit an
   * intent outside the list, and cannot omit one.
   */
  const res = await ask<{
    intent: Intent;
    confidence: number;
    note: string;
    summary: string;
  }>({
    user: `${INSTRUCTION}\n\nMessage:\n${text}`,
    // Fast and cheap: this runs on every inbound message, and a client waiting
    // on an approval is waiting on this call.
    model: env.gemini.fastModel,
    effort: "low",
    schemaName: "intent",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "confidence", "note", "summary"],
      properties: {
        intent: { type: "string", enum: INTENTS },
        confidence: { type: "number" },
        note: { type: "string" },
        summary: { type: "string" },
      },
    },
    maxTokens: 800,
    timeoutMs: 20_000,
  });

  if (!res.ok || !res.data) {
    // "none" rather than an error: the caller treats it as "not understood",
    // which is exactly what the portal did before this route existed. A
    // classifier that is down must never look like a client saying no.
    console.warn("[whatsapp] intent unavailable:", res.error || "empty reply");
    return Response.json({ ok: true, intent: "none", confidence: 0, reason: "unavailable" });
  }

  const d = res.data;
  return Response.json({
    ok: true,
    intent: INTENTS.includes(d.intent) ? d.intent : "none",
    confidence: Number.isFinite(d.confidence) ? Math.min(1, Math.max(0, d.confidence)) : 0,
    note: (d.note || "").trim().slice(0, 1000),
    summary: (d.summary || "").trim().slice(0, 300),
  });
}
