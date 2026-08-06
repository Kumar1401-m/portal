/**
 * POST /api/whatsapp/transcribe
 *
 * Turn a client's voice note into text.
 *
 * Clients answer by voice — it is faster than typing on a phone, and for a
 * change request it is far more natural than composing a paragraph. Before
 * this those messages were logged as "[voice note]" and nobody knew what was
 * asked until someone played them back.
 *
 * The service could not do this itself: transcription needs the Gemini key,
 * which belongs to the portal and should not be copied onto a box running a
 * browser automation. So the service posts the audio here and gets words back,
 * then treats them exactly as if the client had typed them — same parser, same
 * approval path, one set of rules for both.
 *
 * Auth: Authorization: Bearer <WHATSAPP_SERVICE_KEY>
 * Body: { audioBase64, mimeType, groupId? }
 */
import { isAuthorizedWhatsAppRequest, unauthorized } from "@/lib/api-auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Voice notes are short by nature; anything past a couple of minutes is not a
 * reply to a video. The cap is on the encoded size because that is what this
 * request actually has to carry.
 */
const MAX_BASE64_CHARS = 8 * 1024 * 1024;

export async function POST(request: Request) {
  if (!isAuthorizedWhatsAppRequest(request)) return unauthorized();
  if (!env.gemini.enabled) {
    return Response.json({ ok: false, error: "No transcription model configured." }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const audio = typeof body.audioBase64 === "string" ? body.audioBase64 : "";
  const mimeType = (typeof body.mimeType === "string" && body.mimeType) || "audio/ogg";
  if (!audio) {
    return Response.json({ ok: false, error: "audioBase64 is required." }, { status: 400 });
  }
  if (audio.length > MAX_BASE64_CHARS) {
    return Response.json(
      { ok: false, error: "That voice note is too long to transcribe." },
      { status: 413 }
    );
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${env.gemini.model}` +
    `:generateContent?key=${env.gemini.apiKey}`;

  /*
   * Asked for the words and nothing else.
   *
   * The transcript is fed straight into the command parser, so a model that
   * helpfully answers "The client is approving the video" instead of "ok"
   * would break approval outright. Hence: transcribe, don't interpret.
   */
  const instruction = [
    "Transcribe this voice message exactly, and output only the transcription.",
    "Keep the speaker's own language and words — do not translate, summarise, answer or explain.",
    "If nothing intelligible was said, output nothing at all.",
  ].join(" ");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: mimeType, data: audio } },
              { text: instruction },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 400 },
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn("[whatsapp] transcription failed:", res.status, detail.slice(0, 200));
      return Response.json(
        { ok: false, error: `Transcription failed (HTTP ${res.status}).` },
        { status: 502 }
      );
    }

    const j = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = (j.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .trim();

    return Response.json({ ok: true, text });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "Transcription failed." },
      { status: 502 }
    );
  }
}
