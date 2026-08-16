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
   * Their words, and then what those words mean in English.
   *
   * Both, because they are read by different things. `text` is fed straight
   * into the command parser, so it has to be what was actually said — a model
   * that helpfully answers "The client is approving the video" instead of
   * "sare" breaks approval outright. `english` is read by a person scrolling
   * the transcript, and a Telugu voice note transcribed into Telugu told them
   * no more than "[voice note]" did.
   *
   * One call rather than two: the audio is already uploaded, and a second
   * round trip to translate a sentence we are holding in memory doubles both
   * the wait and the cost of every voice note that arrives.
   */
  const instruction = [
    "Transcribe this voice message, then translate the transcription into English.",
    'Reply with JSON only: {"text":"...","english":"..."}',
    '"text" is exactly what was said, in the speaker\'s own language and words — do not translate, summarise, answer or explain it.',
    '"english" is a plain English translation of that same sentence, or the identical string when they already spoke English.',
    'If nothing intelligible was said, reply {"text":"","english":""}.',
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
        generationConfig: {
          temperature: 0,
          // A minute of speech is comfortably more than 400 tokens, and the
          // budget is also what a thinking model spends before it writes a
          // word — too tight and the reply comes back empty, which reads as
          // "the client said nothing" rather than "we cut them off".
          maxOutputTokens: 1200,
          responseMimeType: "application/json",
        },
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
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const cand = j.candidates?.[0];
    const raw = (cand?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .trim();

    /*
     * A model that ignores the format must not cost us the transcription.
     *
     * Before the translation was asked for this endpoint returned whatever
     * came back, and that is exactly the fallback: unparsable JSON means we
     * have prose, and prose from this prompt is the transcript. Approval —
     * which only ever needed `text` — keeps working on a day the JSON does
     * not, and only the English half is lost.
     */
    let text = raw;
    let english = "";
    try {
      const parsed = JSON.parse(
        raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
      ) as { text?: unknown; english?: unknown };
      if (typeof parsed.text === "string") {
        text = parsed.text.trim();
        english = typeof parsed.english === "string" ? parsed.english.trim() : "";
      }
    } catch {
      console.warn("[whatsapp] transcription was not JSON, using it verbatim:", raw.slice(0, 120));
    }

    // Said out loud, because the symptom of an empty transcript — a client
    // whose voice notes are simply never acted on — looks nothing like its
    // cause, and the cause is usually the token budget above.
    if (!text) console.warn("[whatsapp] transcription came back empty", { finishReason: cand?.finishReason });

    // Only when it says something the transcript did not: a client who spoke
    // English gets the same sentence back, and printing it twice in the
    // timeline is noise.
    return Response.json({ ok: true, text, english: english && english !== text ? english : "" });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "Transcription failed." },
      { status: 502 }
    );
  }
}
