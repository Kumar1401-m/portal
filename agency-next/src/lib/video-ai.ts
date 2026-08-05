/**
 * Watching a video and writing its caption.
 *
 * Gemini can genuinely watch the file — not guess from a thumbnail. On a real
 * 66 MB Telugu reel it identified the topic, detected the spoken language,
 * read the on-screen text, and wrote the caption in Telugu. That is the whole
 * reason this exists: the brief someone typed weeks ago describes what the
 * video was *meant* to be, and the file describes what it actually became.
 *
 * Structured as a resumable job rather than one function call, because the
 * work is four steps across ~30 seconds:
 *
 *   fetch from R2 → upload to Gemini → wait for processing → generate
 *
 * A serverless function can be killed partway through any of them. Each step
 * records what it achieved, so a retry resumes rather than re-uploading a
 * video that is already sitting on Gemini's servers.
 */
import "server-only";
import { query, queryOne, execute, hasColumn } from "./db";
import { env } from "./env";
import { resolveVideoUrl } from "./storage";
import {
  getClientContext,
  renderContext,
  groundingAvailable,
  allowedPhones,
  correctPhones,
} from "./client-context";

const BASE = "https://generativelanguage.googleapis.com";

/**
 * `gemini-flash-lite-latest` — the model the caption studio uses — does not
 * accept video. This one does, and is the cheapest that does.
 */
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || "gemini-flash-latest";

/**
 * Gemini's Files API accepts up to 2 GB, but everything in between has to pass
 * through this process's memory twice — once down from R2, once up to Gemini.
 * A cap well under the serverless memory limit turns "the function died" into
 * a sentence someone can act on.
 */
const MAX_VIDEO_BYTES = Number(process.env.VIDEO_AI_MAX_BYTES || 100 * 1024 * 1024);

/** A job whose lease is older than this was killed mid-run and may be retaken. */
const LEASE_MINUTES = 10;

/** Uploaded files are deleted by Google after ~48h; re-upload after that. */
const FILE_TTL_HOURS = 40;

export type AnalysisState =
  | "queued"
  | "uploading"
  | "processing"
  | "analysing"
  | "done"
  | "failed";

export type VideoAnalysis = {
  deliverable_id: number;
  state: AnalysisState;
  summary: string | null;
  spoken_language: string | null;
  topic: string | null;
  mood: string | null;
  on_screen_text: string | null;
  scenes_json: unknown;
  caption: string | null;
  hook: string | null;
  hashtags: string | null;
  brand_seen: string | null;
  context_used: string | null;
  grounded: number;
  tokens_used: number | null;
  duration_ms: number | null;
  attempts: number;
  last_error: string | null;
  updated_at: string;
};

export async function videoAiReady(): Promise<boolean> {
  if (!env.gemini.enabled) return false;
  return hasColumn("video_analysis", "state");
}

export async function getAnalysis(deliverableId: number): Promise<VideoAnalysis | null> {
  if (!(await hasColumn("video_analysis", "state"))) return null;
  return queryOne<VideoAnalysis>("SELECT * FROM video_analysis WHERE deliverable_id = ?", [
    deliverableId,
  ]);
}

/* --------------------------------- Prompting -------------------------------- */

/**
 * What the model is asked for.
 *
 * Deliberately asks it to describe what it saw *before* writing anything. A
 * model told only "write a caption" invents a plausible one; made to summarise
 * and transcribe first, the caption it then writes is anchored to the actual
 * footage — and the summary is what a human checks when the caption looks off.
 */
function buildPrompt(brief: {
  clientContext: string;
  title: string;
  description: string | null;
  language: string | null;
  tone: string | null;
  cta: string | null;
}): string {
  const context = [
    brief.clientContext,
    `Task title: ${brief.title}`,
    brief.description ? `Brief from the team: ${brief.description}` : null,
    brief.tone ? `House tone: ${brief.tone}` : null,
    brief.language ? `Preferred caption language: ${brief.language}` : null,
    brief.cta ? `Usual call to action: ${brief.cta}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `You are writing the Instagram caption for a video an agency has just edited for a client.

WHAT WE ALREADY KNOW ABOUT THE CLIENT
${context}

Now WATCH the video. Pay attention to the branding as well as the content —
logos, watermarks, the footer bar, and any phone number, website, handle or
tagline shown on screen. That is how the business presents itself, and the
caption should sound like the same business.

Reply with JSON only:

{
  "summary": "2-3 sentences on what actually happens in the video",
  "spoken_language": "the language spoken, e.g. Telugu, Hindi, English, or 'none'",
  "on_screen_text": ["all text visible on screen, verbatim"],
  "branding": {
    "logo_text": "text in the logo or watermark, or null",
    "footer_text": "text in any footer or lower-third bar, or null",
    "phone": "phone number shown, or null",
    "website": "website shown, or null",
    "handle": "social handle shown, or null",
    "tagline": "any slogan or designation shown, e.g. 'loan provider', or null",
    "business_name_seen": "the business name as it appears on screen, or null"
  },
  "scenes": [{"start":"00:00","end":"00:12","label":"what happens"}],
  "topic": "the subject in 3-6 words",
  "mood": "one word: informative, energetic, emotional, promotional, calm",
  "hook": "the strongest opening line, taken from what is actually said or shown",
  "caption": "the full caption",
  "hashtags": ["#tag", "..."]
}

Rules for the caption:
- Write it in the language the video is SPOKEN in. If the preferred caption
  language above disagrees with what you hear, follow what you hear — the
  audience is whoever the speaker is addressing.
- Open with the hook, then 2-3 short lines, then one clear call to action.
- NEVER write a phone number, website or handle that is not either listed
  above or visible on screen in the video. If there is no number to give,
  end with "DM us" or "link in bio" — a made-up number reaches a stranger.
- Write as the business the branding shows. If the video's footer says
  "loan provider", the caption should read like a loan provider wrote it.
- Describe what is genuinely in the video. Never invent offers, prices,
  interest rates, guarantees or claims that were not made — for a regulated
  business this is the difference between marketing and a false promise.
- 8-12 hashtags: a few broad, several specific to the business and its city.
- No preamble, no explanation, JSON only.`;
}

/* ------------------------------- The job steps ------------------------------- */

type StepResult = { ok: true } | { ok: false; error: string; permanent?: boolean };

async function setState(
  deliverableId: number,
  state: AnalysisState,
  patch: Record<string, string | number | null> = {}
): Promise<void> {
  const cols = Object.keys(patch);
  const sets = ["state = ?", ...cols.map((c) => `${c} = ?`)].join(", ");
  await execute(`UPDATE video_analysis SET ${sets} WHERE deliverable_id = ?`, [
    state,
    ...cols.map((c) => patch[c]),
    deliverableId,
  ]);
}

/**
 * Start (or restart) an analysis.
 *
 * Returns immediately after creating the row. The caller then drives it with
 * `runAnalysis`, which is the part that can take half a minute.
 */
export async function queueAnalysis(deliverableId: number, force = false): Promise<void> {
  if (!(await hasColumn("video_analysis", "state"))) return;

  if (force) {
    // A rewrite keeps the uploaded file — re-uploading 66 MB to get a second
    // opinion on footage Gemini already holds would be pure waste.
    await execute(
      `INSERT INTO video_analysis (deliverable_id, state, attempts)
       VALUES (?, 'queued', 0)
       ON DUPLICATE KEY UPDATE state = 'queued', last_error = NULL, locked_at = NULL`,
      [deliverableId]
    );
    return;
  }

  await execute(
    `INSERT INTO video_analysis (deliverable_id, state) VALUES (?, 'queued')
     ON DUPLICATE KEY UPDATE deliverable_id = deliverable_id`,
    [deliverableId]
  );
}

export type RunResult = {
  ok: boolean;
  state: AnalysisState;
  error?: string;
  caption?: string | null;
  /** True when the caller should call again to continue a multi-step job. */
  more?: boolean;
};

/**
 * Drive one analysis as far as it can get in a single invocation.
 *
 * Claims the job with a lease so two requests can't upload the same video
 * twice, then walks the steps. Returns `more: true` when there is further work
 * — the UI polls, which keeps any one request short enough to survive a
 * serverless timeout.
 */
export async function runAnalysis(deliverableId: number): Promise<RunResult> {
  if (!env.gemini.enabled) {
    return { ok: false, state: "failed", error: "No GEMINI_API_KEY is configured." };
  }
  if (!(await hasColumn("video_analysis", "state"))) {
    return { ok: false, state: "failed", error: "The video_analysis table is missing." };
  }

  // Claim: only proceed if nobody else holds a live lease.
  const claimed = await execute(
    `UPDATE video_analysis
        SET locked_at = NOW(), attempts = attempts + 1
      WHERE deliverable_id = ?
        AND state NOT IN ('done')
        AND (locked_at IS NULL OR locked_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))`,
    [deliverableId, LEASE_MINUTES]
  );

  const job = await getAnalysis(deliverableId);
  if (!job) return { ok: false, state: "failed", error: "No analysis queued for this video." };
  if (job.state === "done") {
    return { ok: true, state: "done", caption: job.caption, more: false };
  }
  if (claimed.affectedRows === 0) {
    // Someone else is working on it. Not an error — just report progress.
    return { ok: true, state: job.state, more: true };
  }

  // Give up rather than burn tokens on something that keeps failing.
  if (job.attempts > 4) {
    await setState(deliverableId, "failed", {
      last_error: job.last_error || "Gave up after repeated failures.",
      locked_at: null,
    });
    return { ok: false, state: "failed", error: job.last_error || "Repeated failures." };
  }

  try {
    const fileUri = await ensureUploaded(deliverableId);
    if (!fileUri.ok) {
      await setState(deliverableId, fileUri.permanent ? "failed" : "queued", {
        last_error: fileUri.error,
        locked_at: null,
      });
      return { ok: false, state: fileUri.permanent ? "failed" : "queued", error: fileUri.error };
    }

    const ready = await waitForProcessing(deliverableId, fileUri.uri, fileUri.name);
    if (!ready.ok) {
      await setState(deliverableId, ready.permanent ? "failed" : "processing", {
        last_error: ready.error,
        locked_at: null,
      });
      // Still processing is normal — tell the caller to come back.
      return {
        ok: !ready.permanent,
        state: ready.permanent ? "failed" : "processing",
        error: ready.permanent ? ready.error : undefined,
        more: !ready.permanent,
      };
    }

    return await generate(deliverableId, fileUri.uri, fileUri.mimeType);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await setState(deliverableId, "queued", { last_error: message, locked_at: null });
    return { ok: false, state: "queued", error: message, more: true };
  }
}

/* ----------------------------- Step 1: get it there ---------------------------- */

async function ensureUploaded(
  deliverableId: number
): Promise<{ ok: true; uri: string; name: string; mimeType: string } | (StepResult & { ok: false })> {
  const existing = await queryOne<{
    file_uri: string | null;
    file_name: string | null;
    file_expires_at: string | null;
  }>("SELECT file_uri, file_name, file_expires_at FROM video_analysis WHERE deliverable_id = ?", [
    deliverableId,
  ]);

  // Reuse an upload that Google hasn't expired yet.
  if (existing?.file_uri && existing.file_name) {
    const expired =
      existing.file_expires_at && new Date(existing.file_expires_at + "Z").getTime() < Date.now();
    if (!expired) {
      return {
        ok: true,
        uri: existing.file_uri,
        name: existing.file_name,
        mimeType: "video/mp4",
      };
    }
  }

  const d = await queryOne<{
    title: string;
    cloud_video_key: string | null;
    cloud_video_url: string | null;
    edited_link: string | null;
  }>(
    `SELECT title, cloud_video_key, cloud_video_url, edited_link
       FROM deliverables WHERE id = ?`,
    [deliverableId]
  );
  if (!d) return { ok: false, error: "Task not found.", permanent: true };

  /*
   * Prefer our own storage, then fall back to a directly-linked file — an
   * editor who pastes a link rather than uploading should still get a caption.
   *
   * The fallback is only taken for an http(s) URL, and the content-type check
   * after fetching is what catches a Google Drive share link: those return an
   * HTML page, not video bytes, and would otherwise be uploaded to Gemini as a
   * "video" that it then can't read.
   */
  const linked =
    d.edited_link && /^https?:\/\//i.test(d.edited_link) ? d.edited_link : null;
  const url = (await resolveVideoUrl(d.cloud_video_key, d.cloud_video_url, 60 * 60)) || linked;

  if (!url) {
    return {
      ok: false,
      error: "No video to analyse. Upload the finished file, or add a direct video link.",
      permanent: true,
    };
  }

  await setState(deliverableId, "uploading", { model: VIDEO_MODEL });

  const res = await fetch(url);
  if (!res.ok) {
    return { ok: false, error: `Couldn't fetch the video (HTTP ${res.status}).` };
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_VIDEO_BYTES) {
    return {
      ok: false,
      // Permanent: the same file will be the same size next time.
      permanent: true,
      error: `Video is ${(bytes.byteLength / 1048576).toFixed(0)} MB; the limit for AI analysis is ${(
        MAX_VIDEO_BYTES / 1048576
      ).toFixed(0)} MB.`,
    };
  }

  const mimeType = res.headers.get("content-type")?.split(";")[0] || "video/mp4";

  // A Drive/Dropbox "share" link serves an HTML page. Uploading that to Gemini
  // succeeds and then fails much later with an opaque error, so it is caught
  // here where the cause can actually be named.
  if (!/^(video|application\/octet-stream)/.test(mimeType)) {
    return {
      ok: false,
      permanent: true,
      error:
        `That link returns ${mimeType}, not a video file. ` +
        `Share links (Google Drive, Dropbox) serve a web page — upload the video instead.`,
    };
  }

  // Resumable upload: start, then send the bytes.
  const init = await fetch(`${BASE}/upload/v1beta/files?key=${env.gemini.apiKey}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: d.title.slice(0, 100) } }),
  });

  const uploadUrl = init.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    return { ok: false, error: `Gemini refused the upload (HTTP ${init.status}).` };
  }

  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: new Uint8Array(bytes),
  });
  const upJson = (await up.json()) as { file?: { uri: string; name: string; mimeType: string } };
  if (!upJson.file?.uri) {
    return { ok: false, error: "Gemini did not return an uploaded file." };
  }

  const expires = new Date(Date.now() + FILE_TTL_HOURS * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  await setState(deliverableId, "processing", {
    file_uri: upJson.file.uri,
    file_name: upJson.file.name,
    file_expires_at: expires,
    video_bytes: bytes.byteLength,
  });

  return {
    ok: true,
    uri: upJson.file.uri,
    name: upJson.file.name,
    mimeType: upJson.file.mimeType || mimeType,
  };
}

/* --------------------------- Step 2: wait for Gemini -------------------------- */

async function waitForProcessing(
  deliverableId: number,
  _uri: string,
  name: string
): Promise<{ ok: true } | (StepResult & { ok: false })> {
  // Polled here for a few seconds rather than looped to completion: a long
  // video can take a minute, and holding a serverless request open that long
  // risks the platform killing it mid-wait. The caller polls instead.
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/v1beta/${name}?key=${env.gemini.apiKey}`);
    const file = (await res.json()) as { state?: string; error?: { message?: string } };

    if (file.error) return { ok: false, error: file.error.message || "Gemini error", permanent: true };
    if (file.state === "ACTIVE") return { ok: true };
    if (file.state === "FAILED") {
      return {
        ok: false,
        permanent: true,
        error: "Gemini could not process this video — the format may be unsupported.",
      };
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  await setState(deliverableId, "processing", { locked_at: null });
  return { ok: false, error: "Still processing." };
}

/* ------------------------------ Step 3: generate ------------------------------ */

async function generate(
  deliverableId: number,
  fileUri: string,
  mimeType: string
): Promise<RunResult> {
  await setState(deliverableId, "analysing");
  const started = Date.now();

  const d = await queryOne<{
    title: string;
    description: string | null;
    client_id: number;
    caption_settings: unknown;
  }>(
    `SELECT d.title, d.description, d.client_id, c.caption_settings
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
    [deliverableId]
  );
  if (!d) return { ok: false, state: "failed", error: "Task not found." };

  const asObj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const cs = asObj(d.caption_settings);
  const str = (v: unknown) => (v == null ? null : String(v));

  // Everything we know about the business: the record, their Instagram bio,
  // their website. Gathered here rather than in the prompt builder so the
  // exact briefing can be stored alongside the caption it produced.
  const ctx = await getClientContext(d.client_id);
  const contextBlock = ctx ? renderContext(ctx) : "Business: (unknown)";

  const prompt = buildPrompt({
    clientContext: contextBlock,
    title: d.title,
    description: d.description,
    language: str(cs.language),
    tone: str(cs.tone),
    cta: str(cs.cta),
  });

  /*
   * Grounded web search when the tier allows it.
   *
   * Off by default: Gemini's `google_search` tool is a paid-tier feature and
   * returns a quota error on the free one, which would fail every caption. The
   * context above is the client's own words and is better material anyway —
   * search adds reach, not accuracy.
   */
  const useGrounding = groundingAvailable();

  const res = await fetch(
    `${BASE}/v1beta/models/${VIDEO_MODEL}:generateContent?key=${env.gemini.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ file_data: { mime_type: mimeType, file_uri: fileUri } }, { text: prompt }],
          },
        ],
        ...(useGrounding ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: {
          temperature: 0.7,
          // Grounding and forced-JSON output are mutually exclusive in the
          // API, so the JSON is parsed out of the text when searching is on.
          ...(useGrounding ? {} : { responseMimeType: "application/json" }),
        },
      }),
    }
  );

  const out = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { totalTokenCount?: number };
    error?: { message?: string; code?: number };
  };

  if (out.error) {
    const permanent = out.error.code === 400 || /not available|not found/i.test(out.error.message || "");
    await setState(deliverableId, permanent ? "failed" : "queued", {
      last_error: out.error.message || "Gemini error",
      locked_at: null,
    });
    return { ok: false, state: permanent ? "failed" : "queued", error: out.error.message };
  }

  const text = (out.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  let parsed: Record<string, unknown>;
  try {
    // With grounding on, the reply is prose that contains JSON rather than
    // pure JSON, so the object is extracted before parsing.
    const json = useGrounding ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : text;
    parsed = JSON.parse(json);
  } catch {
    await setState(deliverableId, "queued", {
      last_error: "Gemini's reply wasn't valid JSON.",
      locked_at: null,
    });
    return { ok: false, state: "queued", error: "Gemini's reply wasn't valid JSON.", more: true };
  }

  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  const hashtags = arr(parsed.hashtags)
    .map((h) => (h.startsWith("#") ? h : `#${h}`))
    .join(" ");

  // Flatten the branding block into readable lines. Stored as text rather than
  // JSON because its only reader is a human checking why a caption came out
  // the way it did.
  const b = asObj(parsed.branding);
  const brandSeen =
    [
      s(b.business_name_seen) ? `Name on screen: ${s(b.business_name_seen)}` : null,
      s(b.tagline) ? `Tagline: ${s(b.tagline)}` : null,
      s(b.logo_text) ? `Logo: ${s(b.logo_text)}` : null,
      s(b.footer_text) ? `Footer: ${s(b.footer_text)}` : null,
      s(b.phone) ? `Phone: ${s(b.phone)}` : null,
      s(b.website) ? `Website: ${s(b.website)}` : null,
      s(b.handle) ? `Handle: ${s(b.handle)}` : null,
    ]
      .filter(Boolean)
      .join("\n") || null;

  /*
   * Check the contact details before storing them.
   *
   * Asked to end on a call to action with no number to hand, the model invents
   * a ten-digit one that reads exactly like a real number — observed on the
   * very first run against a loan consultancy. The instruction above tells it
   * not to; this makes sure. Any number the client doesn't actually own is
   * swapped for one they do, or the line goes.
   */
  const phones = allowedPhones(ctx, s(b.phone));
  const rawCaption = s(parsed.caption);
  const checked = rawCaption
    ? correctPhones(rawCaption, phones, ctx?.phone ?? null)
    : { caption: null, changed: 0 };
  if (checked.changed) {
    console.warn(
      `[video-ai] deliverable ${deliverableId}: corrected ${checked.changed} invented phone number(s)`
    );
  }

  /*
   * The audit columns are written only if they exist.
   *
   * They arrived after the table did, and a hosted database gets them when
   * someone opens Settings and presses the button. Naming them unconditionally
   * would mean an unmigrated install downloads the video, uploads it to Gemini,
   * pays for the generation and *then* dies on "Unknown column" — losing the
   * caption it had already written. Better to store the caption and skip the
   * provenance.
   */
  const audit = await hasColumn("video_analysis", "brand_seen");

  await execute(
    `UPDATE video_analysis
        SET state = 'done', summary = ?, spoken_language = ?, topic = ?, mood = ?,
            on_screen_text = ?, scenes_json = ?, caption = ?, hook = ?, hashtags = ?,
            ${audit ? "brand_seen = ?, context_used = ?, grounded = ?," : ""}
            raw_json = ?, tokens_used = ?, duration_ms = ?, last_error = NULL, locked_at = NULL
      WHERE deliverable_id = ?`,
    [
      s(parsed.summary),
      s(parsed.spoken_language),
      s(parsed.topic),
      s(parsed.mood),
      arr(parsed.on_screen_text).join("\n") || null,
      JSON.stringify(parsed.scenes ?? []),
      checked.caption,
      s(parsed.hook),
      hashtags || null,
      ...(audit
        ? [
            brandSeen,
            // Kept so a caption can be traced to the briefing it was written
            // from, including which sources were reachable at the time.
            ctx ? `${contextBlock}\n\n[sources: ${ctx.sources.join(", ")}]` : null,
            useGrounding ? 1 : 0,
          ]
        : []),
      JSON.stringify(parsed),
      out.usageMetadata?.totalTokenCount ?? null,
      Date.now() - started,
      deliverableId,
    ]
  );

  return { ok: true, state: "done", caption: checked.caption, more: false };
}

/* -------------------------------- Applying it -------------------------------- */

/**
 * Copy the AI draft onto the deliverable.
 *
 * Deliberately a separate, explicit step. The analysis writes to its own row
 * and never touches `deliverables.caption` on its own — otherwise a rewrite
 * would silently discard whatever a human had edited since.
 */
export async function applyCaption(deliverableId: number): Promise<{ ok: boolean; error?: string }> {
  const a = await getAnalysis(deliverableId);
  if (!a || a.state !== "done" || !a.caption) {
    return { ok: false, error: "There's no finished caption to apply yet." };
  }

  const withTags = a.hashtags ? `${a.caption}\n\n${a.hashtags}` : a.caption;
  await execute("UPDATE deliverables SET caption = ?, hashtags = ? WHERE id = ?", [
    withTags,
    a.hashtags,
    deliverableId,
  ]);
  return { ok: true };
}

/** Jobs still in flight — used by the editor dashboard to show progress. */
export async function getPendingAnalyses(limit = 20): Promise<
  { deliverable_id: number; title: string; state: string; attempts: number }[]
> {
  if (!(await hasColumn("video_analysis", "state"))) return [];
  return query(
    `SELECT v.deliverable_id, d.title, v.state, v.attempts
       FROM video_analysis v JOIN deliverables d ON d.id = v.deliverable_id
      WHERE v.state NOT IN ('done','failed')
      ORDER BY v.updated_at DESC LIMIT ${Number(limit) || 20}`
  );
}
