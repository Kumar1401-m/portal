/**
 * The shapes the content studio passes around.
 *
 * Its own module because the studio is a client component and `content-ai.ts`
 * is `server-only` — importing it for a type would drag the database driver
 * into the browser bundle and fail the build. Same split `lead-stages.ts` has
 * from `leads.ts` and `expense-kinds.ts` from `expenses.ts`.
 *
 * Types and one constant. No database, no model, no request.
 */

export const SCRIPT_LANGUAGES = ["English", "Telugu", "Tenglish"] as const;
export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

export type Strategy = {
  month: string;
  summary: string;
  pillars: { name: string; share: string; why: string }[];
  frequency: string;
  formats: string[];
  postingPlan: string[];
  /** False when there was not enough published history to ground the advice. */
  grounded: boolean;
};

export type Idea = {
  topic: string;
  hook: string;
  format: string;
  audience: string;
  cta: string;
  /** Why this one, in terms of the client's own numbers. The point of the tool. */
  why: string;
  /** high | medium | low — the model's estimate, labelled as one. */
  potential: string;
};

export type ScriptInput = {
  topic: string;
  platform?: string;
  seconds?: number;
  language?: ScriptLanguage;
  tone?: string;
  audience?: string;
  objective?: string;
};

export type Script = {
  hook: string;
  intro: string;
  body: string;
  examples: string;
  cta: string;
  /** The whole thing, as it would be read aloud. */
  full: string;
  /** Other openings, so a hook can be swapped without regenerating. */
  altHooks: string[];
  /** The clock: which seconds each section owns, and how long it came back. */
  segments: ScriptSegment[];
  /** Total words in the script, and what the requested length needs. */
  totalWords: number;
  targetWords: number;
  /** True when the draft came back short of the length that was asked for. */
  short: boolean;
};

export type ScriptSection = "hook" | "intro" | "body" | "examples" | "cta";

export type ThumbnailConcept = {
  title: string;
  hook: string;
  expression: string;
  layout: string;
  elements: string[];
  colors: string;
  aspect: string;
};

export type SeoPack = {
  keywords: string[];
  localKeywords: string[];
  titles: string[];
  metaDescriptions: string[];
  youtubeKeywords: string[];
  clusters: { name: string; topics: string[] }[];
};

/**
 * One timed part of a script.
 *
 * A reel is not five paragraphs, it is a clock — the hook has three seconds
 * and the body has thirty, and a script that ignores that is a script the
 * editor cuts down on the timeline. So every section carries the seconds it
 * owns and the words that fit in them.
 */
export type ScriptSegment = {
  key: ScriptSection;
  label: string;
  /** Seconds from the start of the video. */
  from: number;
  to: number;
  /** Words that fit in that time at a natural speaking pace. */
  targetWords: number;
  /** What the draft actually came back with. */
  words: number;
};

/** Words a person speaks in a second, at a natural pace. */
export const WORDS_PER_SECOND = 2.5;

/**
 * How a script of N seconds divides up.
 *
 * The hook gets a hard floor of three seconds because that is the whole of
 * its job — below that there is no hook, there is a first word. Everything
 * else scales, and the body takes the largest share because that is the part
 * a viewer stays for.
 *
 * Pure and exported so the test can check the arithmetic and the panel can
 * show the clock without asking the server.
 */
export function scriptPlan(seconds: number): Omit<ScriptSegment, "words">[] {
  const total = Math.min(180, Math.max(10, Math.round(seconds)));

  const share: { key: ScriptSection; label: string; pct: number }[] = [
    { key: "hook", label: "Hook", pct: 0.09 },
    { key: "intro", label: "Intro", pct: 0.13 },
    { key: "body", label: "Body", pct: 0.5 },
    { key: "examples", label: "Example", pct: 0.17 },
    { key: "cta", label: "Call to action", pct: 0.11 },
  ];

  const out: Omit<ScriptSegment, "words">[] = [];
  let at = 0;
  share.forEach((s, i) => {
    // The last section takes whatever is left, so the parts always add up to
    // the length asked for rather than to 59 or 61 after rounding.
    const span =
      i === share.length - 1 ? total - at : Math.max(s.key === "hook" ? 3 : 2, Math.round(total * s.pct));
    const to = Math.min(total, at + span);
    out.push({
      key: s.key,
      label: s.label,
      from: at,
      to,
      targetWords: Math.max(4, Math.round((to - at) * WORDS_PER_SECOND)),
    });
    at = to;
  });
  return out;
}

/** Words in a line of script — whitespace-separated, which holds for Telugu too. */
export const countWords = (s: string): number =>
  String(s ?? "").trim().split(/\s+/).filter(Boolean).length;

/**
 * The floor a script has to clear.
 *
 * Eighty-five per cent of the target, because a 60-second ask that comes back
 * as 40 seconds of speech is the complaint this exists to answer — over is
 * fine, an editor can trim, and under means reshooting or padding on the day.
 */
export const wordFloor = (seconds: number): number =>
  Math.round(seconds * WORDS_PER_SECOND * 0.85);
