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
