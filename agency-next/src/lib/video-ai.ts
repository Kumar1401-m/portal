/**
 * Watching a video and writing its caption.
 *
 * The point of it: the brief someone typed weeks ago describes what the video
 * was *meant* to be, and the file describes what it actually became. On a real
 * 66 MB Telugu reel this identifies the topic, detects the spoken language,
 * reads the on-screen text and writes the caption in Telugu.
 *
 * The model has no video input — it takes images and audio and nothing else —
 * so the video arrives here already taken apart, by the browser that uploaded
 * it and had the file in hand:
 *
 *   frames decoded to R2  ┐
 *                         ├→  generate  →  caption, branding, topic
 *   audio decoded to WAV  ┘   (transcribed here, cached on the row)
 *
 * Structured as a resumable job rather than one function call, because a
 * serverless function can be killed partway through any of it. Each step
 * records what it achieved, so a retry picks up rather than paying twice —
 * the transcript in particular is kept, being the expensive half that never
 * changes.
 */
import "server-only";
import { query, queryOne, execute, hasColumn, type SqlParam } from "./db";
import { env } from "./env";
import { resolveVideoUrl, directDownloadUrl } from "./storage";
import { audioKey } from "./audio";
import { ask, modelReady, transcribe } from "./model";
import { MAX_FRAMES } from "./frames";
import { isPosterWork } from "./posting";
import { composeCaption } from "./instagram";
import { isGeneratedTitle, titleFromTopic } from "./title";
import {
  getClientContext,
  renderContext,
  renderTemplateRule,
  renderKnowledgeRules,
  groundingAvailable,
  allowedPhones,
  correctPhones,
} from "./client-context";

/**
 * How large a poster may be before it is left out of the prompt.
 *
 * A design is one image where a video is a dozen small frames, so it can be
 * far bigger than any of them. Four megabytes is generous for something meant
 * for a phone screen; past it the request is not worth making, and a caption
 * from the brief alone is better than a call that times out.
 */
const MAX_POSTER_BYTES = 4 * 1024 * 1024;

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
  /** The model's own reply, kept whole — the structured branding lives here. */
  raw_json: unknown;
  /** R2 keys of the frames the browser decoded, in order. */
  frames_json: unknown;
  /** What is said in the video, cached so a retry never re-hears it. */
  transcript: string | null;
  tokens_used: number | null;
  duration_ms: number | null;
  attempts: number;
  last_error: string | null;
  updated_at: string;
};

export async function videoAiReady(): Promise<boolean> {
  if (!modelReady()) return false;
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
 * The studio's "no contact details" box, as a rule.
 *
 * A caption carrying a phone number the client asked not to publish is not a
 * matter of style, so it is stated as flatly as the shape above it and given
 * somewhere to land instead.
 */
const NO_CONTACT = [
  "- NO contact details in this one: no phone number, no website, no address.",
  '  End with "DM us" or "link in bio" instead.',
].join(String.fromCharCode(10));

/**
 * The shape a caption takes when the client has not agreed one of their own.
 *
 * Used instead of a client template, never alongside it. Two shapes in one
 * prompt is two instructions to obey, and what comes back is neither.
 */
const HOUSE_SHAPE = [
  "- THREE lines about the video, and no more. Not a summary of the topic —",
  "  what is actually in this footage. Line two: the detail that makes it",
  "  worth watching — the process, the ingredient, the number, whatever the",
  "  video is proud of. Line three: who it is for, or what to do about it.",
  "- Then a contact line: the business name, and the phone, website or handle",
  "  ONLY if it is listed above or visible on screen. Add the city if you know",
  "  it. Leave out what you do not have — an invented number reaches a stranger.",
].join(String.fromCharCode(10));

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
  /** The client's fixed caption shape, when they have one. */
  templateRule: string | null;
  /** Their brand rules — banned words, restrictions, their own CTAs. */
  knowledgeRules: string | null;
  /** Picked in the studio for this one caption, not saved on the client. */
  goal: string | null;
  length: string | null;
  includeContact: boolean;
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

  /*
   * The client's rules and their template go last, immediately before the
   * JSON contract.
   *
   * Position is doing real work here. Instructions buried in the middle of a
   * long prompt get treated as background; the ones nearest the output format
   * are the ones actually followed. These two are the constraints the agency
   * is most likely to be held to by a client — the shape their captions take,
   * and the things they will not say — so they sit where they will be obeyed,
   * and the template is repeated in the caption rules below for the same
   * reason. Rules first: a banned word outranks a section heading.
   */
  const template =
    [brief.knowledgeRules, brief.templateRule].filter(Boolean).length
      ? `\n${[brief.knowledgeRules, brief.templateRule].filter(Boolean).join("\n\n")}\n`
      : "";
  /*
   * The shape of the caption — one answer, not two.
   *
   * These used to both be in the prompt: a client's template above, telling
   * the model to reproduce it exactly, and the house shape below, telling it
   * to write three lines and then a contact line. A model given two shapes
   * splits the difference, so a client with an agreed template got something
   * that was neither — which reads as the template being ignored, and is
   * really the template being argued with.
   *
   * The hook rule is deliberately NOT part of this. Whatever shape a caption
   * takes, its first line is the one that decides whether anybody reads the
   * second.
   */
  const shape = brief.templateRule
    ? "- FOLLOW THE TEMPLATE ABOVE EXACTLY. Its structure is the client's, not\n" +
      "  a suggestion — same sections, same order, same line breaks, same\n" +
      "  emoji. Only the wording that describes this video changes. Where the\n" +
      "  template has a contact line, fill it from what is listed above or\n" +
      "  visible on screen and from nothing else."
    : HOUSE_SHAPE;

  return `You are writing the Instagram caption for a video an agency has just edited for a client.

WHAT WE ALREADY KNOW ABOUT THE CLIENT
${context}
${template}
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
  "has_face": true or false — is a person visibly on camera at any point,
  "hook": "line one of the caption, repeated here on its own",
  "caption": "the full caption",
  "alternate_captions": ["four other complete captions, each a different angle"],
  "cta": "the call to action used in the caption",
  "seo_keywords": ["5 search phrases for this video, no # and no duplicates"],
  "video_keyword": "2-3 words for what this video is about"
}

The alternates are complete captions, not variations of a line — a different
angle each: one led by the offer, one by the story, one by the question, one by
the result. Same language, same template, same rules as the main one. They are
there so a caption can be *chosen* rather than regenerated.

Rules for the caption:
- Write it in the language the video is SPOKEN in. If the preferred caption
  language above disagrees with what you hear, follow what you hear — the
  audience is whoever the speaker is addressing.
- NEVER write a phone number, website or handle that is not either listed
  above or visible on screen in the video. If there is no number to give,
  end with "DM us" or "link in bio" — a made-up number reaches a stranger.
${brief.includeContact ? "" : NO_CONTACT}
- Write as the business the branding shows. If the video's footer says
  "loan provider", the caption should read like a loan provider wrote it.
- Describe what is genuinely in the video. Never invent offers, prices,
  interest rates, guarantees or claims that were not made — for a regulated
  business this is the difference between marketing and a false promise.
${shape}
- THE FIRST LINE IS THE HOOK, and it is the most important line you write. It has
  one job: stop the scroll and earn a reply. A description is not a hook.
  "Fresh biryani at ZZ Foods" is a label; "This biryani takes 6 hours — and
  it sells out by 1pm" is a hook. Use the sharpest thing the video actually
  has: the number, the price, the surprise, the mistake, the question it
  answers. Never a greeting, never "check out our", never the business name
  first.

  IS THIS REEL ASKING FOR A COMMENT? Look at how it ENDS — the last thing
  said, and the text on the final frames. A lead-magnet reel finishes by
  asking for one: "comment PRICE and I'll send the list", "comment GUIDE and
  we'll DM the PDF", "కామెంట్ చేయండి, పంపిస్తాను".

  If it does, that ask is the FIRST line of the caption:

      Comment "PRICE" and we'll send you the full list 👇

  Use the SAME word the video used. It is the word people will type and the
  word the business is watching for, so inventing a neater one breaks the
  thing it is there to do. If the video asks for a comment without naming a
  word, choose a short one from what is being offered.

  It goes first because that is where it gets read. The reel makes the ask at
  the end, by which point most people have already scrolled; the caption is
  what the ones who stayed are looking at. A comment is worth far more than a
  like — it is what makes Instagram show the reel to people who do not follow
  the account, and it opens a thread the business can reply in.

  EVERY OTHER REEL: no comment ask at all. Not "comment below", not "let us
  know" — write the sharpest hook the footage gives you and nothing else. A
  reel that never offered anything, captioned as though it did, costs the
  client the reply and the trust, and there is nothing to send the people who
  do comment.

- If the video is about food, NAME the dishes that appear in it. "Our menu"
  is not a caption for a biryani; the dish is the thing being searched for
  and the thing a viewer recognises.
- Use the branding you read off the screen. The logo, the footer bar and the
  business name are how this business presents itself; if the footer says
  "loan provider" the lines should read as one wrote them. Never attribute a
  logo or a footer to a business other than the one shown.
- USE EMOJI. A caption with none reads like a notice, and this is a feed. Two
  to five across the whole caption, each one earning its place:

    · the hook takes one that IS the subject — 🍟 chips, 💛 gold, 🏠 a house
    · the contact line takes the ones that label it — 📍 for the town,
      📞 for the phone, 🌐 for a website, 📩 for a DM
    · a list of points takes ✅ or ✨ at the start of each

  Not one per word, and never on a price, an interest rate, a guarantee or a
  medical or financial claim — an emoji makes a number look like an offer,
  and for a regulated business that is the line between marketing and a
  promise.

  If the client's template has emoji in it, use exactly those, in exactly
  those places. They are part of the shape they agreed.
- "video_keyword": two or three words for what this video is about, taken
  from the video itself — the dish, the service, the thing on screen. Not the
  business name, not its handle, not its city: those three are added
  afterwards from what the portal knows exactly, and this is the fourth.
- Do NOT write the keyword line and do NOT write any hashtags. Both blocks
  are built afterwards from those four, and anything you write is published
  twice.
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
/**
 * Which video a task currently points at.
 *
 * The storage key first: it changes whenever a new file is uploaded, even if
 * the deliverable link is rewritten to the same permalink afterwards.
 */
async function currentSourceRef(deliverableId: number): Promise<string | null> {
  const d = await queryOne<{
    cloud_video_key: string | null;
    cloud_video_url: string | null;
    edited_link: string | null;
  }>(
    "SELECT cloud_video_key, cloud_video_url, edited_link FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!d) return null;
  return d.cloud_video_key || d.cloud_video_url || d.edited_link || null;
}

/**
 * Forget an analysis whose video has been replaced.
 *
 * Deletes the row rather than nulling twenty columns: everything in it — the
 * summary, the caption, the branding, and the Gemini file URI — describes a
 * video that is no longer attached to this task, and a row that has to be
 * blanked field by field is one column away from leaking the old caption the
 * next time somebody adds a column.
 */
export async function invalidateAnalysis(deliverableId: number): Promise<void> {
  if (!(await hasColumn("video_analysis", "state"))) return;
  await execute("DELETE FROM video_analysis WHERE deliverable_id = ?", [deliverableId]);
}

/**
 * Drop the analysis if it belongs to a different video than the task now has.
 *
 * A NULL `source_ref` means "recorded before this was tracked" and is left
 * alone — the migration backfills those, and treating unknown as stale would
 * re-run every analysis in the database on first deploy.
 */
async function discardIfVideoChanged(deliverableId: number): Promise<void> {
  if (!(await hasColumn("video_analysis", "source_ref"))) return;

  const row = await queryOne<{ source_ref: string | null }>(
    "SELECT source_ref FROM video_analysis WHERE deliverable_id = ?",
    [deliverableId]
  );
  if (!row) return;

  const now = await currentSourceRef(deliverableId);
  if (row.source_ref === null) {
    // Adopt the current video, so the *next* replacement is detected.
    await execute("UPDATE video_analysis SET source_ref = ? WHERE deliverable_id = ?", [
      now,
      deliverableId,
    ]);
    return;
  }
  if (row.source_ref !== now) await invalidateAnalysis(deliverableId);
}

export async function queueAnalysis(deliverableId: number, force = false): Promise<void> {
  if (!(await hasColumn("video_analysis", "state"))) return;

  // Before anything else: is what we know about still the video on the task?
  await discardIfVideoChanged(deliverableId);

  if (force) {
    // A rewrite keeps the uploaded file — re-uploading 66 MB to get a second
    // opinion on footage Gemini already holds would be pure waste. Safe only
    // because the check above has already thrown the row away if the video
    // itself changed.
    /*
     * A fresh ask is a fresh budget.
     *
     * `attempts` survived a requeue, and four of them ends the job for good —
     * so a video that had spent them, for reasons long since fixed, was marked
     * failed on the next run before Gemini was called at all. Pressing the
     * button appeared to do nothing, and no amount of deploying could change
     * it, because nothing that was deployed ever ran.
     */
    await execute(
      `INSERT INTO video_analysis (deliverable_id, state, attempts)
       VALUES (?, 'queued', 0)
       ON DUPLICATE KEY UPDATE state = 'queued', last_error = NULL, locked_at = NULL,
         attempts = 0`,
      [deliverableId]
    );
    return;
  }

  /*
   * Asking again revives a job that failed; it never disturbs one in flight.
   *
   * This was `deliverable_id = deliverable_id` — a deliberate no-op, so that
   * queueing a video already being analysed did not restart it. True, and it
   * also meant a *failed* row could not be revived by anything: the button
   * sends `force` only for a rewrite of a finished caption, so every retry of
   * a failure ran this branch and changed nothing. The state stayed failed,
   * the attempts stayed spent, and the same error was shown back for ever.
   *
   * `state` is assigned last on purpose: MySQL evaluates the list in order
   * and later columns would see the new value, so the three tests above have
   * to run while it still reads 'failed'.
   */
  await execute(
    `INSERT INTO video_analysis (deliverable_id, state) VALUES (?, 'queued')
     ON DUPLICATE KEY UPDATE
       attempts   = IF(state = 'failed', 0, attempts),
       last_error = IF(state = 'failed', NULL, last_error),
       locked_at  = IF(state = 'failed', NULL, locked_at),
       state      = IF(state = 'failed', 'queued', state)`,
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
  /** Four other complete captions, so one can be chosen instead of re-paid for. */
  alternates?: string[];
  hashtags?: string | null;
  cta?: string | null;
};

/**
 * Per-run overrides from the caption studio.
 *
 * The client's saved settings are the default for every caption; these are
 * what somebody picks for *this* one, in the studio, when a particular video
 * wants a different tone or a shorter caption than usual. Absent everywhere
 * else, which is why every field is optional.
 */
export type CaptionOverrides = {
  tone?: string;
  language?: string;
  goal?: string;
  length?: string;
  /** False means the caption must not carry a phone number or a website. */
  includeContact?: boolean;
};

/**
 * Drive one analysis as far as it can get in a single invocation.
 *
 * Claims the job with a lease so two requests can't upload the same video
 * twice, then walks the steps. Returns `more: true` when there is further work
 * — the UI polls, which keeps any one request short enough to survive a
 * serverless timeout.
 */
export async function runAnalysis(
  deliverableId: number,
  overrides?: CaptionOverrides
): Promise<RunResult> {
  if (!modelReady()) {
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
    // Composed, like a fresh run's — the row keeps the body and the tag block
    // apart, and handing back the body alone made a second press look as
    // though the keywords and hashtags had been lost.
    return { ok: true, state: "done", caption: composeCaption(job.caption, job.hashtags), more: false };
  }
  if (claimed.affectedRows === 0) {
    // Someone else is working on it. Not an error — just report progress.
    return { ok: true, state: job.state, more: true };
  }

  /*
   * Three captions per video per 48 hours.
   *
   * Separate from the attempts ceiling below, and about a different thing.
   * Attempts stop a *broken* job looping; this stops a working one being
   * asked over and over. A generation reads a dozen high-detail frames at the
   * highest reasoning effort the portal buys anywhere — the most expensive
   * call it makes — and there is a Regenerate button beside it.
   *
   * Three is enough to get one reel's copy right. A fourth in two days is
   * someone hoping a different answer falls out of the same video, and the
   * cure for that is editing the caption settings, not paying again.
   */
  const spent = await captionsWritten(deliverableId);
  if (spent >= CAPTIONS_PER_WINDOW) {
    await setState(deliverableId, "failed", {
      last_error: `This video has had ${spent} captions in the last 48 hours, which is the limit. Edit the caption by hand, or try again later.`,
      locked_at: null,
    });
    return {
      ok: false,
      state: "failed",
      error: `Caption limit reached — ${CAPTIONS_PER_WINDOW} per video per 48 hours.`,
    };
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
    const eyes = await gatherEyes(deliverableId);
    if (!eyes.ok) {
      await setState(deliverableId, eyes.permanent ? "failed" : "queued", {
        last_error: eyes.error,
        locked_at: null,
      });
      return { ok: false, state: eyes.permanent ? "failed" : "queued", error: eyes.error };
    }

    return await generate(deliverableId, eyes.eyes, overrides);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await setState(deliverableId, "queued", { last_error: message, locked_at: null });
    return { ok: false, state: "queued", error: message, more: true };
  }
}

/* ------------------------------ The caption budget ----------------------------- */

/** How many captions one video may be given, and over how long. */
const CAPTIONS_PER_WINDOW = 3;
const WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * How many more captions this video may be given, for showing on screen.
 *
 * The number is worth saying out loud rather than discovering by pressing the
 * button. A generation is the most expensive call the portal makes, and
 * finding out you have run out *after* deciding the caption needs one more
 * pass is the worst moment to learn there is a limit at all.
 */
export async function captionBudget(
  deliverableId: number
): Promise<{ used: number; left: number; limit: number }> {
  const used = await captionsWritten(deliverableId);
  return { used, left: Math.max(0, CAPTIONS_PER_WINDOW - used), limit: CAPTIONS_PER_WINDOW };
}

/**
 * How many captions this video has been given inside the window.
 *
 * The times are written by the app in UTC and compared here, never in SQL.
 * This database's clock runs on Indian time, so `NOW()` sits five and a half
 * hours ahead of anything the app stored — a window compared against it
 * would let two extra generations through every time.
 *
 * Fails open. A database without the column yet should caption videos, not
 * refuse to; the limit starts working the moment the column is applied.
 */
async function captionsWritten(deliverableId: number): Promise<number> {
  if (!(await hasColumn("video_analysis", "gen_log"))) return 0;
  const row = await queryOne<{ gen_log: string | null }>(
    "SELECT gen_log FROM video_analysis WHERE deliverable_id = ?",
    [deliverableId]
  );
  return readTimes(row?.gen_log).filter((t) => Date.now() - t < WINDOW_MS).length;
}

/** Record that a caption was written, keeping only what the window can use. */
async function recordCaption(deliverableId: number): Promise<void> {
  if (!(await hasColumn("video_analysis", "gen_log"))) return;
  const row = await queryOne<{ gen_log: string | null }>(
    "SELECT gen_log FROM video_analysis WHERE deliverable_id = ?",
    [deliverableId]
  );
  const kept = readTimes(row?.gen_log)
    .filter((t) => Date.now() - t < WINDOW_MS)
    // Trimmed so the column cannot grow without bound on a video that is
    // re-cut and re-captioned for months.
    .slice(-CAPTIONS_PER_WINDOW * 2);
  kept.push(Date.now());
  await execute("UPDATE video_analysis SET gen_log = ? WHERE deliverable_id = ?", [
    JSON.stringify(kept.map((t) => new Date(t).toISOString())),
    deliverableId,
  ]).catch(() => {});
}

/** Stored ISO strings back to milliseconds, ignoring anything unreadable. */
function readTimes(raw: string | null | undefined): number[] {
  if (!raw) return [];
  let val: unknown;
  try {
    val = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(val)) return [];
  return val
    .map((v) => (typeof v === "string" ? Date.parse(v) : NaN))
    .filter((t) => Number.isFinite(t));
}

/* ------------------------- Step 1: what it will look at ------------------------ */

/**
 * The frames, as data URIs, and what was said.
 *
 * ## Why frames at all
 *
 * The model has no video input — it takes images and audio and nothing else.
 * That is not a limitation to route around; it is the shape of the problem.
 * A video *is* a sequence of images with a sound track, and the two questions
 * anybody asks about a finished reel are answered by different halves of it:
 * the logo, the footer, the phone number and the on-screen text are visual,
 * and the pitch is spoken.
 *
 * So both are gathered, and gathered where each is cheapest. The frames were
 * decoded in the browser at upload time, from a file it was already holding —
 * no server, no ffmpeg, no second copy of a 60 MB reel crossing the network.
 * The speech is read straight out of the same mp4 by the transcription
 * endpoint, which accepts the container whole.
 *
 * ## Sampled across the whole runtime, in order
 *
 * Evenly spaced from first second to last, and handed over in that order, so
 * "what happens at the end" is a question the model can answer. A branding
 * footer usually appears in the last two seconds and nowhere else; frames
 * taken from the first few seconds — which is what a cheap sampler does —
 * would miss the single most important thing this is asked to read.
 *
 * ## Nothing is invented when a half is missing
 *
 * A video with no frames yet (linked rather than uploaded, or uploaded before
 * this existed) is analysed from its transcript alone, and one whose audio is
 * over the 25 MB limit from its frames alone. Both are said plainly in the
 * prompt, so the model reports what it could not see or hear instead of
 * filling it in.
 */
type Eyes = {
  frames: string[];
  transcript: string | null;
  /** What we could not get, in words the prompt can use. */
  missing: string[];
};

async function gatherEyes(deliverableId: number): Promise<
  { ok: true; eyes: Eyes } | { ok: false; error: string; permanent?: boolean }
> {
  const job = await getAnalysis(deliverableId);
  const d = await queryOne<{
    title: string;
    cloud_video_key: string | null;
    cloud_video_url: string | null;
    edited_link: string | null;
    service: string | null;
    video_type: string | null;
  }>(
    `SELECT title, cloud_video_key, cloud_video_url, edited_link, service, video_type
       FROM deliverables WHERE id = ?`,
    [deliverableId]
  );
  if (!d) return { ok: false, error: "Task not found.", permanent: true };

  const poster = isPosterWork(d);

  await setState(deliverableId, "uploading", { model: env.gemini.model });

  /* ---- the frames the browser decoded ---- */
  const keys = readFrameKeys(job?.frames_json);
  const frames: string[] = [];
  for (const key of keys.slice(0, MAX_FRAMES)) {
    const url = await resolveVideoUrl(key, null, 30 * 60).catch(() => null);
    if (!url) continue;
    const got = await fetch(url).catch(() => null);
    if (!got?.ok) continue;
    const buf = Buffer.from(await got.arrayBuffer());
    // Straight into the request rather than left as a link. The model would
    // fetch a URL itself, but then a frame it cannot reach fails the whole
    // analysis for a reason no log here would ever show.
    frames.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
  }

  /*
   * A poster's frame is the poster.
   *
   * `frames_json` is written by the browser as it decodes an uploaded video,
   * so a poster has none and this writer was being handed nothing to look at.
   * It then wrote the caption from the brief alone — words somebody typed
   * before the design existed — and was told, correctly, to say nothing about
   * what was on screen. So the caption for a poster could never mention the
   * offer, the price, or the words actually printed on the thing being posted.
   *
   * The design is one image and this model reads images. Fetched here the same
   * way a frame is, for the same reason: handing over a URL would let a file
   * the model cannot reach fail the whole analysis for a cause no log of ours
   * would show.
   */
  if (poster && !frames.length) {
    const url =
      (await resolveVideoUrl(d.cloud_video_key, d.cloud_video_url, 30 * 60).catch(() => null)) ||
      directDownloadUrl(d.edited_link);
    const got = url ? await fetch(url).catch(() => null) : null;
    if (got?.ok) {
      const type = (got.headers.get("content-type") || "").split(";")[0].trim();
      const buf = Buffer.from(await got.arrayBuffer());
      /*
       * Image bytes, and not too many of them. A Canva or Drive link that
       * serves an HTML page arrives here as `text/html`, and base64ing a web
       * page into the prompt would have the model describing a login screen.
       */
      if (/^image\//.test(type) && buf.byteLength <= MAX_POSTER_BYTES) {
        frames.push(`data:${type};base64,${buf.toString("base64")}`);
      }
    }
  }

  /* ---- and what was said, once, kept ---- */
  let transcript = job?.transcript ?? null;
  let heardNothing: string | null = null;
  /*
   * A poster is not listened to.
   *
   * This branch resolves "the file" and sends it to speech-to-text. On a
   * poster that file is a PNG, so every poster caption spent a transcription
   * call on an image that could only ever come back empty — quota, latency and
   * a confusing error, for a question a poster cannot answer.
   */
  if (poster) {
    heardNothing = "a poster has no sound";
  } else if (transcript === null) {
    /*
     * The extracted speech first, the video only if there is none.
     *
     * Transcription refuses anything over 25 MB, and a finished reel passes
     * that on picture alone — so a good video was captioned from its frames
     * and never mentioned a word anybody said. Nothing failed; the caption
     * just quietly got worse. The browser now decodes the audio track to a
     * mono 16 kHz WAV as the video uploads, which is a fraction of the size
     * and is the rate speech recognition resamples to anyway.
     *
     * The video stays as the fallback, unchanged, for everything uploaded
     * before this and for any file the browser could not decode.
     */
    const linked = d.edited_link && /^https?:\/\//i.test(d.edited_link) ? d.edited_link : null;
    const speech = await resolveVideoUrl(audioKey(deliverableId), null, 60 * 60);
    const url = (await resolveVideoUrl(d.cloud_video_key, d.cloud_video_url, 60 * 60)) || linked;
    if (speech || url) {
      const fromVideo = () =>
        url
          ? transcribe(url, `${d.title.slice(0, 60) || "video"}.mp4`)
          : Promise.resolve({ text: null, error: "there is no video file to listen to" });
      // A key that was never written presigns perfectly happily and 404s on
      // collection, so "no extracted speech" arrives here as a failed fetch
      // rather than as a missing URL.
      const heard = speech
        ? await transcribe(speech, "speech.wav").then((r) => (r.text ? r : fromVideo()))
        : await fromVideo();
      if (heard.text) {
        transcript = heard.text;
        /*
         * Stored the moment it arrives. Transcription is the expensive half
         * and it does not change; a retry that paid for it again would spend
         * a small balance re-hearing videos it had already heard.
         */
        await execute("UPDATE video_analysis SET transcript = ? WHERE deliverable_id = ?", [
          transcript,
          deliverableId,
        ]).catch(() => {});
      } else {
        heardNothing = heard.error || "nothing audible";
      }
    } else {
      heardNothing = "there is no video file to listen to";
    }
  }

  /*
   * Nothing to look at is not a failure — it is a thinner brief.
   *
   * This used to stop here, which is why the portal grew a second caption
   * writer: something had to serve a poster, and a task whose video is not
   * uploaded yet, and those are ordinary cases rather than errors. Two
   * writers then meant two prompts, two sets of brand rules, and a caption
   * that followed the client's agreed structure only if you happened to press
   * the right button.
   *
   * One writer, told plainly what it was and was not given. A caption written
   * from the brief alone is worth having; what is not worth having is a model
   * inventing what is on screen, and `missing` is what prevents that.
   */
  const missing: string[] = [];
  if (!frames.length) {
    missing.push(
      poster
        ? "You were NOT shown the poster — say nothing about what is on it."
        : "You were given NO frames — say nothing about what is on screen."
    );
  }
  if (!transcript) {
    missing.push(
      `You were given NO transcript${heardNothing ? ` (${heardNothing})` : ""} — say nothing about what was said.`
    );
  }

  return { ok: true, eyes: { frames, transcript, missing } };
}

/** The stored keys, whatever shape MySQL handed the JSON column back in. */
function readFrameKeys(raw: unknown): string[] {
  if (!raw) return [];
  const val = typeof raw === "string" ? safeJson(raw) : raw;
  return Array.isArray(val) ? val.filter((k): k is string => typeof k === "string") : [];
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/**
 * One word or phrase as a hashtag: letters and digits only, lower case.
 *
 * Its class had at some point lost the two backslashes off its property
 * escapes. Written without them those are five literal characters, not a
 * unicode property — so the negated set kept only p, {, L, } and N and
 * deleted everything else. "Freskos" came out empty, "Liverpool" came out
 * "Lp", and a tag that comes out empty returns null.
 *
 * Every keyword was therefore dropped, the array was empty, and captions
 * published with no keyword line and no hashtags at all — silently, for every
 * client, because an empty tag list is indistinguishable from one nobody
 * asked for.
 *
 * Marks are kept as well as letters, and that is not decoration. A Telugu
 * word is letters plus its vowel signs: strip the marks from బిర్యానీ and
 * what is left is బరయన, which is not a misspelling of biryani so much as a
 * different string of consonants. Letters and digits alone would have quietly
 * mangled the hashtags of every client this portal actually has.
 *
 * A module-level function rather than a closure, so a test can run it on real
 * strings. A source-text assertion would have read the regex back and agreed
 * with it.
 */
export function hashTag(v: string | null | undefined): string | null {
  const clean = String(v ?? "").replace(/[^\p{L}\p{N}\p{M}]/gu, "");
  return clean ? `#${clean.toLowerCase()}` : null;
}

/* ------------------------------ Step 2: generate ------------------------------ */

/**
 * The finished-analysis UPDATE, built so a value cannot lose its column.
 *
 * The column names come from the literal above and never from anything a
 * model or a client sent, which is what makes interpolating them safe; the
 * values stay parameters.
 */
export function buildCaptionUpdate(
  deliverableId: number,
  fields: Record<string, SqlParam>
): { sql: string; params: SqlParam[] } {
  const columns = Object.keys(fields);
  return {
    sql: `UPDATE video_analysis
             SET state = 'done', ${columns.map((c) => `${c} = ?`).join(", ")},
                 last_error = NULL, locked_at = NULL
           WHERE deliverable_id = ?`,
    params: [...columns.map((c) => fields[c]), deliverableId],
  };
}

/**
 * The shape the reply is *made* to take.
 *
 * This is the same shape the prompt asks for in words, and asking in words was
 * all that was happening: the call passed no schema, and `ask` only fills in
 * `data` when it is given one. So `res.data` came back null every single time,
 * the caller read that as a parse failure, and every video in the portal
 * reported "the reply was not the JSON it was required to be" — on a reply
 * that was, in fact, perfectly good JSON that nobody parsed.
 *
 * Written out in full because `strict` mode has no shorthand: every property
 * has to appear in `required`, every object has to say
 * `additionalProperties: false`, and anything that may be absent says so as a
 * null in its type rather than by being optional. In return the decoder
 * guarantees the shape — the model cannot wrap it in a code fence, cannot
 * drop a key, and cannot answer in prose.
 */
export const CAPTION_SCHEMA: Record<string, unknown> = (() => {
  /** A field the video may simply not show — a logo with no phone number in it. */
  const maybe = { type: ["string", "null"] };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "spoken_language",
      "on_screen_text",
      "branding",
      "scenes",
      "topic",
      "mood",
      "has_face",
      "hook",
      "caption",
      "alternate_captions",
      "cta",
      "seo_keywords",
      "video_keyword",
    ],
    properties: {
      summary: { type: "string" },
      spoken_language: { type: "string" },
      on_screen_text: { type: "array", items: { type: "string" } },
      branding: {
        type: "object",
        additionalProperties: false,
        required: [
          "logo_text",
          "footer_text",
          "phone",
          "website",
          "handle",
          "tagline",
          "business_name_seen",
        ],
        properties: {
          logo_text: maybe,
          footer_text: maybe,
          phone: maybe,
          website: maybe,
          handle: maybe,
          tagline: maybe,
          business_name_seen: maybe,
        },
      },
      scenes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["start", "end", "label"],
          properties: {
            start: { type: "string" },
            end: { type: "string" },
            label: { type: "string" },
          },
        },
      },
      topic: { type: "string" },
      mood: { type: "string" },
      has_face: { type: "boolean" },
      hook: { type: "string" },
      caption: { type: "string" },
      /*
       * Five more, so the editor picks rather than regenerates.
       *
       * This is the whole reason the second writer existed: a page of
       * alternates to choose from. Choosing costs nothing; regenerating costs
       * a dozen high-detail frames at high reasoning effort, and one of only
       * three attempts in two days.
       */
      alternate_captions: { type: "array", items: { type: "string" } },
      cta: { type: "string" },
      seo_keywords: { type: "array", items: { type: "string" } },
      /*
       * Two or three words for what this video is about, and the only part
       * of the keyword line the model supplies.
       *
       * The other three — the business name, the handle and the town — are
       * things the portal knows exactly, and a model asked for any of them
       * returns something plausible: a handle spelled almost right is a tag
       * belonging to a stranger, posted on this client's account.
       */
      video_keyword: { type: "string" },
    },
  };
})();

async function generate(
  deliverableId: number,
  eyes: Eyes,
  overrides?: CaptionOverrides
): Promise<RunResult> {
  await setState(deliverableId, "analysing");
  const started = Date.now();

  const d = await queryOne<{
    title: string;
    description: string | null;
    client_id: number;
    caption_settings: unknown;
    company_name: string | null;
    ig_username: string | null;
  }>(
    `SELECT d.title, d.description, d.client_id, c.caption_settings,
            c.company_name, c.ig_username
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
    language: overrides?.language || str(cs.language),
    tone: overrides?.tone || str(cs.tone),
    cta: str(cs.cta),
    goal: overrides?.goal || null,
    length: overrides?.length || null,
    // The studio's "no contact details" box. A caption that carries a phone
    // number the client did not want published is not a style problem.
    includeContact: overrides?.includeContact !== false,
    // Stored on the client and, until now, read by nothing in this portal —
    // the template someone wrote for a client was quietly having no effect.
    templateRule: ctx ? renderTemplateRule(ctx) : null,
    // The brand rules somebody wrote down on the client's page. Read through
    // the context rather than fetched again, so a caption, a script and a
    // thumbnail all obey the same list without each remembering to ask.
    knowledgeRules: ctx ? renderKnowledgeRules(ctx) : null,
  });

  /*
   * What it is looking at, said before the task.
   *
   * The frames arrive as an ordered strip covering the whole runtime, and the
   * model has no way of knowing that unless it is told — shown eight pictures
   * with no explanation it will describe eight separate images rather than one
   * video. Saying "these are frames 1..8, evenly spaced, first to last" is
   * what turns a pile of stills back into something with a beginning and an
   * end, which is the difference between reading the footer and not.
   */
  const sightNote = eyes.frames.length
    ? `You are looking at ${eyes.frames.length} frames taken from ONE video, in order, ` +
      `evenly spaced from its first second to its last. Frame 1 is the opening; the final ` +
      `frame is how it ends — branding, a logo lock-up and a footer usually appear only there. ` +
      `Read every word visible in every frame, including small print along the bottom.`
    : "";
  const heardNote = eyes.transcript
    ? `\n\nWHAT IS SAID IN THE VIDEO (transcribed from its own audio, verbatim):\n${eyes.transcript.slice(0, 6000)}`
    : "";
  const missingNote = eyes.missing.length ? `\n\nIMPORTANT:\n- ${eyes.missing.join("\n- ")}` : "";

  const res = await ask<Record<string, unknown>>({
    system:
      "You are a senior social-media editor who watches a client's finished video and reports " +
      "exactly what is in it. You never invent a detail you were not shown or told.",
    user: `${sightNote}${heardNote}${missingNote}\n\n${prompt}`,
    images: eyes.frames.map((url) => ({
      url,
      // The whole point is reading small text — a logo lock-up, a phone number
      // along a footer. Low detail downsamples exactly that away.
      detail: "high" as const,
    })),
    /*
     * The most thinking the portal buys anywhere, and the one place it is
     * plainly worth it.
     *
     * This is not a chat reply: it reads a dozen frames, reconciles them with
     * a transcript and a page of brand rules, and produces copy that goes onto
     * a paying client's feed. The failure mode of a model that glances is a
     * fluent caption about a video it did not really look at — which is
     * indistinguishable from a good one until the client reads it.
     */
    effort: "high",
    // Without this the reply is never parsed at all — see CAPTION_SCHEMA.
    schema: CAPTION_SCHEMA,
    schemaName: "video_caption",
    model: env.gemini.model,
    /*
     * Room for the thinking *and* the reply, which come out of the same
     * budget. At 12,000 this ran out mid-JSON on a busy video: the response
     * still carried the half of the object it had managed to write, so it
     * did not read as an empty reply, and the parse failure was reported as
     * a broken schema. Twice the room, and nothing extra is charged for room
     * that goes unused.
     */
    maxTokens: 24_000,
    // A dozen high-detail frames at high effort is not a quick call.
    timeoutMs: 180_000,
  });

  if (!res.ok) {
    const message = res.error || "The model returned nothing.";
    /*
     * Retriable failures cost no attempt.
     *
     * The claim raises the count before anything is known, and four of them
     * ends the job for good — so spending that budget on rate limits and
     * outages, which analysed no video and burned no tokens, is how a working
     * video reaches "gave up after repeated failures" without ever having
     * been read once.
     */
    if (res.retriable) {
      await execute(
        "UPDATE video_analysis SET attempts = GREATEST(attempts - 1, 0) WHERE deliverable_id = ?",
        [deliverableId]
      ).catch(() => {});
    }
    await setState(deliverableId, res.retriable ? "queued" : "failed", {
      last_error: message,
      locked_at: null,
    });
    return { ok: false, state: res.retriable ? "queued" : "failed", error: message, more: res.retriable };
  }

  const parsed = res.data;
  if (!parsed) {
    await setState(deliverableId, "queued", {
      last_error: "The reply was not the JSON it was required to be.",
      locked_at: null,
    });
    return { ok: false, state: "queued", error: "The reply was not valid JSON.", more: true };
  }

  const usedModel = res.model;
  const tokensUsed = res.tokens;
  const out = { usageMetadata: { totalTokenCount: res.tokens } };

  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  const tag = hashTag;

  /*
   * Who, and where. Both from the portal, neither from the model.
   *
   * The name and the handle it knows exactly; the city and country come off
   * the client's own record. A model asked for any of them returns something
   * plausible — a handle spelled almost right is a tag belonging to a
   * stranger, posted on this client's account, and a guessed city is worse
   * because it looks correct to everyone who does not live there.
   *
   * Location earns its place: "near me" is how this kind of business is
   * actually searched for, and a reel about a dosa shop that never says which
   * town it is in is competing with every dosa shop.
   */
  const chosen = [
    tag(d.company_name),
    tag(d.ig_username),
    tag(ctx?.city),
    tag(s(parsed.video_keyword)),
  ].filter((t): t is string => Boolean(t));

  /*
   * The same terms twice: once as words, once as tags.
   *
   * Instagram reads the caption for what a post is about, and a hashtag is a
   * link rather than a word — so the terms worth being found for have to
   * appear as text too. One bracket with commas, not a bracket each: seven
   * separate parentheses under a caption reads as debris, one list reads as
   * a label.
   *
   * Both off one array on purpose. Written apart they drift the first time
   * somebody changes how many there are, and a post whose keywords and tags
   * disagree is being optimised for two different things.
   */
  const hashtags = [
    chosen.length ? `(${chosen.map((t) => t.slice(1)).join(", ")})` : "",
    chosen.join(" "),
  ]
    .filter(Boolean)
    .join(String.fromCharCode(10));

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
  /*
   * Whether a person is on camera — the one feature the portal could not
   * answer for itself, and the one an agency argues about most. The model is
   * watching the whole video anyway, so this is a field in a reply that was
   * being made regardless.
   */
  const hasFace = await hasColumn("video_analysis", "has_face");

  /*
   * Columns and values written as one thing.
   *
   * They used to be two lists — a SQL string with `?` in it and an array of
   * values — with two optional groups spliced into each. The optional groups
   * were spliced in at *different points* in the two, so the moment the
   * `has_face` column existed every value after it shifted one place: the
   * on-screen text went into `scenes_json`, which is a JSON column, and MySQL
   * refused it with `Invalid JSON text: "Invalid value." at position 0`.
   *
   * Every caption failed, and the message named a column nothing was wrong
   * with. Worse, it only appeared once the database was migrated — so the
   * feature broke on the machines that were most up to date.
   *
   * Keyed by column name, the value cannot be separated from the column it
   * belongs to. Insertion order is what MySQL sees, and it does not matter
   * what that order is.
   */
  const fields: Record<string, SqlParam> = {
    summary: s(parsed.summary),
    spoken_language: s(parsed.spoken_language),
    topic: s(parsed.topic),
    mood: s(parsed.mood),
    on_screen_text: arr(parsed.on_screen_text).join("\n") || null,
    scenes_json: JSON.stringify(parsed.scenes ?? []),
    caption: checked.caption,
    hook: s(parsed.hook),
    hashtags: hashtags || null,
    raw_json: JSON.stringify(parsed),
    tokens_used: tokensUsed,
    duration_ms: Date.now() - started,
    // Which model actually answered. On a busy day the first one is out of
    // quota and the caption came from the fallback — worth being able to see
    // rather than guess at from the timing.
    model: usedModel,
  };
  if (hasFace) {
    fields.has_face = typeof parsed.has_face === "boolean" ? (parsed.has_face ? 1 : 0) : null;
  }
  if (audit) {
    fields.brand_seen = brandSeen;
    // Kept so a caption can be traced to the briefing it was written from,
    // including which sources were reachable at the time.
    fields.context_used = ctx ? `${contextBlock}\n\n[sources: ${ctx.sources.join(", ")}]` : null;
    fields.grounded = 0;
  }

  const written = buildCaptionUpdate(deliverableId, fields);
  await execute(written.sql, written.params);

  /*
   * Name it here, the moment we know what it is.
   *
   * This used to happen only in `applyCaption`, which is a button somebody
   * has to press — so a video could be uploaded, analysed, sent and approved
   * while the board still called it "Video 7". The topic is the one thing the
   * analysis is certain about by now (it had to be, to write the caption),
   * and waiting for a click to spend it was the whole bug.
   */
  await nameFromTopic(deliverableId, s(parsed.topic));

  /*
   * Counted here, not at the start of the call.
   *
   * A rate limit, a timeout or a truncated reply produced no caption and cost
   * the client nothing they can use — charging those against a budget of
   * three would leave a video with no caption and no way to ask for one.
   */
  await recordCaption(deliverableId);

  /*
   * The alternates get the same phone check as the caption itself.
   *
   * They are one click from being the caption — the studio lists them to be
   * picked — so an invented number surviving in one of them is exactly as bad
   * as one surviving in the main copy, and much easier to miss.
   */
  const alternates = arr(parsed.alternate_captions)
    .map((alt) => correctPhones(alt, phones, ctx?.phone ?? null).caption)
    .filter((alt): alt is string => Boolean(alt && alt.trim()));

  /*
   * Composed on the way out, kept apart on the way in.
   *
   * The row keeps the body and the tag block in separate columns, because
   * that is what lets a re-apply be idempotent and what stops the publisher
   * appending the same tags a second time. But everything that *shows* a
   * caption — the studio, the task modal, the Copy button — wants the thing
   * that will actually be posted, and showing the body alone read as the
   * keywords and hashtags simply never having been written.
   */
  return {
    ok: true,
    state: "done",
    caption: composeCaption(checked.caption, hashtags),
    alternates,
    hashtags: hashtags || null,
    cta: s(parsed.cta),
    more: false,
  };
}

/**
 * Replace a portal-written title with what the footage turned out to be about.
 *
 * Safe to call twice — the second call sees a real title and leaves it alone,
 * which is also what protects a name somebody typed.
 */
async function nameFromTopic(deliverableId: number, topic: string | null): Promise<void> {
  const fresh = titleFromTopic(topic);
  if (!fresh) return;
  const current = await queryOne<{ title: string }>(
    "SELECT title FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!current || !isGeneratedTitle(current.title)) return;
  await execute("UPDATE deliverables SET title = ? WHERE id = ?", [fresh, deliverableId]);
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

  /*
   * Name the task after the video, when nobody has named it themselves.
   *
   * A generated month arrives as "Video 1" through "Video 20", which tells a
   * board nothing and makes two clients' work indistinguishable at a glance.
   * Normally the analysis has already done this on finishing; this covers a
   * row analysed before it did, and costs one query to find out.
   */
  await nameFromTopic(deliverableId, a.topic);

  /*
   * The task gets the whole caption; the analysis row keeps the halves.
   *
   * Stored apart, the caption panel showed the three lines and the contact
   * line and nothing else — so the keyword line and the hashtags read as
   * never having been written, and Copy handed over an incomplete post.
   *
   * They are still stored apart on the analysis row, which is what makes
   * re-applying idempotent, and `hashtags` still goes in its own column so
   * the publisher can put them back if somebody edits them out of the body.
   * Composing twice is harmless: `composeCaption` returns a body that already
   * ends in its own tag block untouched, which is the guard that stopped
   * every published reel carrying the same hashtags twice.
   */
  await execute("UPDATE deliverables SET caption = ?, hashtags = ? WHERE id = ?", [
    composeCaption(a.caption, a.hashtags),
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

/**
 * Name the ones that were analysed before anybody thought to name them.
 *
 * The rename now happens as the analysis finishes, but every video analysed
 * before that is still called "Video 7" and never will be — its analysis is
 * done, so nothing runs over it again. Those are exactly the videos on the
 * board today, which makes this worth draining rather than leaving as a
 * footnote.
 *
 * No model and no network: the topic was written months ago and is sitting in
 * the row. Bounded because this runs on a page visit, and after the backlog
 * clears it matches nothing and costs one indexed query.
 */
export async function nameAnalysedVideos(limit = 25): Promise<number> {
  if (!(await hasColumn("video_analysis", "state"))) return 0;

  const rows = await query<{ id: number; title: string; topic: string | null }>(
    `SELECT d.id, d.title, v.topic
       FROM video_analysis v JOIN deliverables d ON d.id = v.deliverable_id
      WHERE v.state = 'done' AND v.topic IS NOT NULL AND v.topic <> ''
      ORDER BY v.updated_at DESC LIMIT ${Number(limit) || 25}`
  );

  let named = 0;
  for (const r of rows) {
    // Filtered here rather than in SQL: "is this a title somebody typed" is a
    // rule with three shapes to it, and it is already written down once.
    if (!isGeneratedTitle(r.title)) continue;
    const fresh = titleFromTopic(r.topic);
    if (!fresh) continue;
    await execute("UPDATE deliverables SET title = ? WHERE id = ?", [fresh, r.id]);
    named++;
  }
  return named;
}
