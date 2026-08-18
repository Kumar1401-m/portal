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

/**
 * Three sections, not five.
 *
 * An intro and a worked example were two more places for a short reel to lose
 * its viewer — on a 30-second cut the intro is the hook repeated and the
 * example is the body again. The body now carries the substance, including
 * whatever example belongs in it, and the seconds they used to hold go to the
 * two parts that do the work: getting somebody to stay, and getting them to
 * act.
 */
export type Script = {
  hook: string;
  body: string;
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

export type ScriptSection = "hook" | "body" | "cta";

/**
 * What the closing line has to ask for.
 *
 * "Follow us" on its own is the weakest ending a reel can have — it asks a
 * stranger for a commitment before they have any reason to give one. Save,
 * share and comment cost nothing, they are what the algorithm actually counts,
 * and a comment prompt is the only one of the four that reliably produces a
 * reply worth answering. So the CTA asks for two or three of these by name,
 * and the follow is the one that comes last.
 */
export const ENGAGEMENT_ASKS = ["save", "share", "comment", "follow"] as const;

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

  /*
   * The two ends get floors; the body takes what is left.
   *
   * Taking a percentage of each in order and giving the remainder to the last
   * one put the CTA on one second at fifteen seconds — too short to ask for a
   * save, let alone a comment. So the hook and the CTA are sized first, each
   * with a minimum that keeps them able to do their job, and the body absorbs
   * the rest. It is the longest section at every length, which is right: it is
   * the only part somebody stays for.
   */
  const hook = Math.max(3, Math.round(total * 0.1));
  const cta = Math.max(4, Math.round(total * 0.18));
  const body = Math.max(3, total - hook - cta);

  const spans: { key: ScriptSection; label: string; span: number }[] = [
    { key: "hook", label: "Hook", span: hook },
    { key: "body", label: "Body", span: body },
    { key: "cta", label: "Call to action", span: cta },
  ];

  const out: Omit<ScriptSegment, "words">[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    // The last section runs to the end, so the parts always add up to the
    // length asked for rather than to 59 or 61 after rounding.
    const to = i === spans.length - 1 ? at + s.span : Math.min(total, at + s.span);
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
