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
 * The service could not do this itself: transcription needs the model key,
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
import { ask, modelReady, transcribeBlob } from "@/lib/model";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Voice notes are short by nature; anything past a couple of minutes is not a
 * reply to a video. The cap is on the encoded size because that is what this
 * request actually has to carry.
 */
const MAX_BASE64_CHARS = 8 * 1024 * 1024;

/**
 * The extension the format is read from.
 *
 * It ignores the multipart content type entirely and decides from the filename
 * alone, so this mapping is not cosmetic — get it wrong and a perfectly good
 * voice note comes back "Unsupported file format". WhatsApp sends
 * `audio/ogg; codecs=opus`; `.opus` and `.oga` are both refused, `.ogg` is
 * accepted, which is not guessable and was checked against the live API.
 */
function extensionFor(mimeType: string): string {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  const known: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/flac": "flac",
  };
  return known[type] || "ogg";
}

/** Nothing outside plain ASCII — so English needs no translating. */
const looksEnglish = (s: string) => !/[^\x00-\x7F]/.test(s);

export async function POST(request: Request) {
  if (!isAuthorizedWhatsAppRequest(request)) return unauthorized();
  if (!modelReady()) {
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

  /*
   * Their words first, then what those words mean — and in that order for a
   * reason. `text` is fed straight into the command parser, so it has to be
   * exactly what was said: a model that helpfully returns "The client is
   * approving the video" instead of "sare" breaks approval outright. A
   * dedicated transcription model cannot do anything else, which is the
   * safest possible guarantee of that.
   *
   * `english` is read by a person scrolling the transcript, where a Telugu
   * voice note transcribed into Telugu tells them no more than "[voice note]"
   * did.
   */
  const bytes = Buffer.from(audio, "base64");
  const heard = await transcribeBlob(
    new Blob([new Uint8Array(bytes)], { type: mimeType }),
    `voice.${extensionFor(mimeType)}`
  );

  if (heard.error) {
    console.warn("[whatsapp] transcription failed:", heard.error);
    return Response.json({ ok: false, error: heard.error }, { status: 502 });
  }

  const text = heard.text || "";
  // Said out loud, because the symptom — a client whose voice notes are simply
  // never acted on — looks nothing like its cause.
  if (!text) console.warn("[whatsapp] transcription came back empty");

  /*
   * The translation is a second call, and only when there is something to
   * translate.
   *
   * It used to ride along with the transcription in one request. It cannot
   * any more: the transcription endpoint returns words and nothing else. That
   * is a fair trade — a client who spoke English costs exactly one call, as
   * before, and the parser now reads output from a model that is incapable of
   * paraphrasing them.
   */
  let english = "";
  if (text && !looksEnglish(text)) {
    const t = await ask({
      system:
        "You translate one short message into English. Reply with the translation and nothing else — " +
        "no quotes, no notes, no explanation. Do not answer it, summarise it or comment on it.",
      user: text,
      model: env.gemini.fastModel,
      effort: "low",
      maxTokens: 800,
      timeoutMs: 20_000,
    });
    // Losing the translation costs a person one click to play the note back;
    // losing the transcript would cost the client their approval.
    if (t.ok) english = t.text.trim();
    else console.warn("[whatsapp] translation failed:", t.error);
  }

  // Only when it says something the transcript did not: a client who spoke
  // English gets the same sentence back, and printing it twice is noise.
  return Response.json({ ok: true, text, english: english && english !== text ? english : "" });
}
