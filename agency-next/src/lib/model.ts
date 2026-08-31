/**
 * The one place that talks to the model.
 *
 * Every AI feature in the portal had grown its own HTTP call — the caption
 * studio, the group assistant, the internal assistant and the video analyser,
 * four copies of retry, timeout, JSON-parsing and error handling, each
 * slightly different. So a fix to any of them fixed one quarter of the
 * problem, and switching provider meant finding all four.
 *
 * That last part stopped being hypothetical. This module has now been an
 * OpenAI client and a Gemini one, and the swap was a rewrite of this file and
 * a rename of its import — nothing else in the portal knew which model it was
 * talking to, and nothing else had to change.
 *
 * ## Gemini, and what that changes
 *
 * `generateContent`, not chat completions. Images and audio go inline in the
 * same request as the text, base64, which is how a dozen video frames and a
 * sound track reach a model that has no video input of its own.
 *
 * `thinkingLevel` is the effort dial, per call rather than global — reading a
 * client's question in a group is not the same job as writing the month's
 * copy, and paying for thinking on the first would make the assistant slow at
 * the one thing it must be fast at.
 *
 * ## Structured output is a schema, not a plea
 *
 * With `schema`, the reply is *made* to be JSON in that shape — it cannot
 * return prose, cannot wrap the JSON in a code fence, and cannot omit a
 * required key. The old prompt-and-hope approach ("reply with JSON only")
 * failed a few percent of the time, and every one of those failures arrived
 * as a parse error at the far end of a job that had already been paid for.
 *
 * Gemini takes an OpenAPI-flavoured schema rather than JSON Schema, so the
 * one the caller writes is converted on the way out. See `toGeminiSchema`.
 */
import "server-only";
import { env } from "./env";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/** How hard to think. Costs thinking tokens; worth it on writing, not on chat. */
export type Effort = "low" | "medium" | "high";

/** One image for the model to look at — a `data:` URI, or a URL we can fetch. */
export type ImageInput = { url: string; detail?: "low" | "high" | "auto" };

export type AskArgs = {
  system?: string;
  user: string;
  /** Frames from a video, a poster, anything to be read rather than described. */
  images?: ImageInput[];
  /** A JSON Schema. Given one, the reply is guaranteed to match it. */
  schema?: Record<string, unknown>;
  /** Name for the schema — appears in errors, so make it say what it is. */
  schemaName?: string;
  effort?: Effort;
  model?: string;
  /** Ceiling on the reply, thinking included. */
  maxTokens?: number;
  /** Abandoned after this. A thinking model on a long prompt is not quick. */
  timeoutMs?: number;
};

export type AskResult<T = unknown> = {
  ok: boolean;
  /** Parsed when a schema was given, otherwise the raw text. */
  data: T | null;
  text: string;
  model: string;
  tokens: number;
  /** How many of those were spent thinking — the cost of `effort`. */
  reasoningTokens: number;
  error?: string;
  /**
   * Whether trying again could plausibly work.
   *
   * A rate limit or a 5xx is worth another go; a refused key or a malformed
   * request will be refused identically for ever. The callers here queue
   * background jobs, and retrying a permanent failure is how a job burns its
   * whole attempt budget in a minute and then gives up for good.
   */
  retriable?: boolean;
  /**
   * What to actually do about it, when the provider's own words do not say.
   *
   * Same idea as `fixFor` on the ads side, and here for the same reason: the
   * message names the symptom and not the cure. "You exceeded your current
   * quota" reads as "wait a minute" — when the truth is that the project is on
   * a free tier with a fixed daily allowance, that waiting until tomorrow buys
   * the same small number again, and that nothing in this portal can change
   * it. Somebody whose captions stopped needs the second sentence, not the
   * first.
   */
  hint?: string;
};

/**
 * The one line that turns a provider error into something a person can do.
 *
 * Exported so the mapping can be held against the statuses Google documents
 * rather than against whatever this function happens to return today.
 */
export function aiFixFor(status: string | undefined, message: string): string | undefined {
  const m = (message || "").toLowerCase();
  const s = (status || "").toUpperCase();

  if (s === "RESOURCE_EXHAUSTED" || m.includes("quota")) {
    return (
      "The Google Cloud project behind this key is on the free tier, which allows only a small " +
      "fixed number of requests a day for this model. Once they are used, every AI feature — " +
      "captions, analysis, the assistant — stops until it resets, and tomorrow brings the same " +
      "allowance. Enable billing on that project to lift it; nothing in the portal can work " +
      "around it."
    );
  }
  if (s === "PERMISSION_DENIED" || m.includes("api key not valid") || m.includes("api_key_invalid")) {
    return "The GEMINI_API_KEY is not accepted. Regenerate it in Google AI Studio and set it again.";
  }
  if (s === "NOT_FOUND" || m.includes("is not found for api version")) {
    return "This model name does not exist on the API version being called — check GEMINI_MODEL.";
  }
  if (s === "UNAVAILABLE" || m.includes("overloaded")) {
    return "Google's own capacity, not this portal and not the key. It usually clears in minutes.";
  }
  return undefined;
}

export const modelReady = (): boolean => env.gemini.enabled;

/** Effort, in the words this API uses for it. */
const THINKING: Record<Effort, string> = { low: "low", medium: "medium", high: "high" };

/**
 * A JSON Schema, as the model's own dialect.
 *
 * Gemini takes an OpenAPI-flavoured subset, and the differences are not
 * cosmetic — a schema it does not understand comes back as a 400 with a field
 * path, which surfaces as a failed caption for a reason no screen would show.
 *
 *   - `additionalProperties` is rejected outright ("Cannot find field").
 *   - types are upper case, and there is no union type: a JSON Schema
 *     `["string", "null"]` becomes `STRING` with `nullable: true`.
 *   - key order is not implied by `properties`, so it is stated. Without it
 *     the model may answer the keys in any order, which costs nothing for
 *     correctness and everything for reading a diff of two captions.
 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    const n = node as Record<string, unknown>;

    // A union with null is the only union JSON Schema uses here, and it maps
    // onto a flag rather than onto a type.
    const rawType = n.type;
    const types = Array.isArray(rawType) ? rawType : [rawType];
    const nullable = types.includes("null");
    const type = String(types.find((t) => t !== "null") ?? "string").toUpperCase();

    const out: Record<string, unknown> = { type };
    if (nullable) out.nullable = true;
    if (typeof n.description === "string") out.description = n.description;

    if (type === "OBJECT" && n.properties && typeof n.properties === "object") {
      const props = n.properties as Record<string, unknown>;
      const keys = Object.keys(props);
      out.properties = Object.fromEntries(keys.map((k) => [k, walk(props[k])]));
      out.propertyOrdering = keys;
      if (Array.isArray(n.required)) out.required = n.required;
    }
    if (type === "ARRAY" && n.items) out.items = walk(n.items);

    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

/**
 * Turn the two characters `\` and `n` back into a line break.
 *
 * Structured output escapes its own newlines a second time, so a caption
 * written as three lines arrives as one line with a literal `\n` sitting in
 * the middle of it — `JSON.parse` has already done its job, and what it
 * correctly produced was a backslash followed by an n.
 *
 * That is not cosmetic here. The whole shape of a caption is line breaks: the
 * three lines about the video, the blank line before the contact details, the
 * blank line before the keyword block. Published as one paragraph with `\n`
 * printed in it, on a client's own account.
 *
 * Only `\n` and `\r\n`. A caption containing a deliberate backslash-n is not
 * a thing; a caption containing other escapes might be, and they are left
 * alone.
 */
function realNewlines<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\\r\\n|\\n/g, "\n") as unknown as T;
  }
  if (Array.isArray(value)) return value.map(realNewlines) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, realNewlines(v)])
    ) as unknown as T;
  }
  return value;
}

/** Every text part of a reply, skipping the model's own thinking. */
function textOf(body: Record<string, unknown>): string {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const parts = ((candidates[0] as { content?: { parts?: unknown } })?.content?.parts ?? []) as {
    text?: string;
    thought?: boolean;
  }[];
  return parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text as string)
    .join("");
}

/**
 * Strip a markdown code fence, if the reply came wrapped in one.
 *
 * Only needed where there is no schema — with one, the decoder cannot emit a
 * fence at all. Without one it often does, and the fence is the difference
 * between a transcript and a transcript with three backticks on the front.
 */
function unfence(text: string): string {
  const m = /^\s*```(?:json|text)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return (m ? m[1] : text).trim();
}

/** A `data:` URI or a plain base64 blob, as the inline part the API wants. */
function inlineImage(url: string): Record<string, unknown> | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
  // A remote URL cannot be handed over as a link: this API takes bytes.
  return null;
}

/**
 * Ask the model something, once, and say plainly what came back.
 *
 * Deliberately never throws. Every caller here is either a background job that
 * has to record a reason and be retried, or a message to a client that must
 * still be sent when the model is unavailable — and an exception in both cases
 * just moves the same decision one stack frame up.
 */
export async function ask<T = unknown>(args: AskArgs): Promise<AskResult<T>> {
  const model = args.model || env.gemini.model;
  const blank: AskResult<T> = {
    ok: false,
    data: null,
    text: "",
    model,
    tokens: 0,
    reasoningTokens: 0,
  };
  if (!env.gemini.enabled) {
    return {
      ...blank,
      error: "No GEMINI_API_KEY is configured.",
      hint: "Set GEMINI_API_KEY in the portal's environment — every AI feature is off without it.",
    };
  }

  /*
   * Pictures first, then the words about them.
   *
   * Order is load-bearing: the frames are handed over as an ordered strip and
   * the text that follows explains what they are. Put the text first and the
   * instruction is read before there is anything to apply it to.
   */
  const parts: Record<string, unknown>[] = [
    ...(args.images || []).map((img) => inlineImage(img.url)).filter(Boolean as unknown as (v: Record<string, unknown> | null) => v is Record<string, unknown>),
    { text: args.user },
  ];

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
  };
  if (args.system) body.systemInstruction = { parts: [{ text: args.system }] };

  const generationConfig: Record<string, unknown> = {};
  if (args.effort) generationConfig.thinkingConfig = { thinkingLevel: THINKING[args.effort] };
  if (args.maxTokens) generationConfig.maxOutputTokens = args.maxTokens;
  if (args.schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = toGeminiSchema(args.schema);
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.gemini.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error || {}) as { message?: string; status?: string };
      // The message runs to several lines of quota advice; the first is the
      // part a person can act on.
      const message = (err.message || `The model returned ${res.status}.`).split("\n")[0];
      return {
        ...blank,
        error: message,
        hint: aiFixFor(err.status, err.message || message),
        // 429 is "not right now"; 5xx and 503 are the provider's own fault.
        retriable: res.status === 429 || res.status >= 500,
      };
    }

    const text = unfence(textOf(json));
    const usage = (json.usage || json.usageMetadata || {}) as {
      totalTokenCount?: number;
      thoughtsTokenCount?: number;
    };
    const candidate = (Array.isArray(json.candidates) ? json.candidates[0] : null) as {
      finishReason?: string;
    } | null;

    const out: AskResult<T> = {
      ok: true,
      data: null,
      text,
      model,
      tokens: Number(usage.totalTokenCount || 0),
      reasoningTokens: Number(usage.thoughtsTokenCount || 0),
    };

    /*
     * Cut off before it finished — checked before the reply is read, not only
     * when the reply is empty.
     *
     * A thinking model spends its output budget on thinking *and* writing.
     * Run out mid-sentence and the response still carries whatever was
     * written, so the text is not empty: it is half a JSON object. Parsing
     * that fails, and the failure used to be reported as "the reply was not
     * the JSON it was required to be" — which points at the schema, the one
     * thing that was working, and says nothing about the budget.
     *
     * Retriable: the same call with more room, or less thinking, succeeds.
     */
    if (candidate?.finishReason && candidate.finishReason !== "STOP") {
      return {
        ...out,
        ok: false,
        error:
          candidate.finishReason === "MAX_TOKENS"
            ? `The model ran out of room while thinking (${out.reasoningTokens} of ${out.tokens} tokens went on thinking). Raise maxTokens or lower the effort.`
            : `The model stopped early (${candidate.finishReason}).`,
        retriable: true,
      };
    }

    if (!text.trim()) {
      return { ...out, ok: false, error: "The model returned nothing.", retriable: true };
    }

    if (!args.schema) return out;
    try {
      return { ...out, data: realNewlines(JSON.parse(text)) as T };
    } catch {
      /*
       * With a schema and a reply that ran to completion this should be
       * impossible, so it is said plainly rather than papered over — but with
       * the start of what did come back, because "not JSON" alone is
       * unactionable and the first line is almost always the answer.
       */
      return {
        ...out,
        ok: false,
        error: `The reply was not the JSON it was required to be: ${text.trim().slice(0, 120)}`,
      };
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ...blank,
      error: aborted
        ? "The model took too long to answer."
        : err instanceof Error
          ? err.message
          : "Unknown error",
      retriable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What is said in a video, in the language it was said in.
 *
 * The same `generateContent` call as everything else, with the sound track
 * inline and one instruction. There is no separate transcription endpoint
 * here and no second model to keep in step — which also means the transcript
 * is read by something that understands the languages this agency's clients
 * actually speak, rather than by whatever a speech endpoint was trained on.
 */
export async function transcribe(
  url: string,
  filename = "video.mp4"
): Promise<{ text: string | null; error?: string }> {
  if (!env.gemini.enabled) return { text: null, error: "No GEMINI_API_KEY is configured." };
  try {
    const res = await fetch(url);
    if (!res.ok) return { text: null, error: `Couldn't fetch the video (HTTP ${res.status}).` };
    return transcribeBlob(await res.blob(), filename);
  } catch (err) {
    return { text: null, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * The ceiling on one transcription.
 *
 * Inline data is base64, which is a third bigger than the bytes it carries,
 * and the whole request has to stay under 20 MB. Fourteen leaves room for the
 * prompt and the framing — about seven minutes of the 16 kHz mono the browser
 * extracts, which is far more than any reel and worth knowing rather than
 * discovering.
 */
export const MAX_TRANSCRIBE_BYTES = 14 * 1024 * 1024;

/** What the audio is, decided by the file's extension. */
const AUDIO_TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  oga: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
  flac: "audio/flac",
};

/**
 * The same, for audio already in hand — a WhatsApp voice note.
 *
 * The extension decides the mime type, because that is the one thing every
 * caller here reliably has: the browser names its extracted audio, and
 * WhatsApp sends `audio/ogg; codecs=opus` under a name ending `.ogg`.
 */
export async function transcribeBlob(
  blob: Blob,
  filename: string
): Promise<{ text: string | null; error?: string }> {
  if (!env.gemini.enabled) return { text: null, error: "No GEMINI_API_KEY is configured." };
  if (blob.size > MAX_TRANSCRIBE_BYTES) {
    return {
      text: null,
      error: `${(blob.size / 1048576).toFixed(0)} MB is over the ${Math.round(
        MAX_TRANSCRIBE_BYTES / 1048576
      )} MB transcription limit.`,
    };
  }
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const mimeType = AUDIO_TYPES[ext] || blob.type || "audio/wav";

  try {
    const data = Buffer.from(await blob.arrayBuffer()).toString("base64");
    const res = await fetch(`${BASE}/models/${env.gemini.fastModel}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.gemini.apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data } },
              {
                text:
                  "Transcribe this audio verbatim, in the language it is spoken in. " +
                  "Write only the words that are said — no summary, no speaker labels, " +
                  "no timestamps, no commentary. If nothing is said, reply with nothing at all.",
              },
            ],
          },
        ],
        // No thinking: this is dictation, and thinking about it is paid for
        // and changes nothing.
        generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error || {}) as { message?: string };
      return {
        text: null,
        error: (err.message || `The model returned ${res.status}.`).split("\n")[0],
      };
    }
    return { text: unfence(textOf(json)) || null };
  } catch (err) {
    return { text: null, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
