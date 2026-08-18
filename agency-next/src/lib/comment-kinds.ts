/**
 * What a comment is, and what a competitor comparison looks like.
 *
 * Its own module so the studio's client components can read these without
 * pulling `sentiment.ts` and `competitors.ts` — both `server-only` — into the
 * browser bundle. Fourth time, after `lead-stages`, `content-kinds` and
 * `revision-kinds`.
 */

/**
 * The six kinds a comment can be.
 *
 * `lead` and `complaint` are separated from positive/negative deliberately:
 * both need a person today, and both would otherwise disappear into a bar
 * chart that says "mostly positive".
 */
export const KINDS = ["lead", "question", "complaint", "negative", "positive", "neutral"] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<Kind, string> = {
  lead: "Wants to buy",
  question: "Asking something",
  complaint: "Complaint",
  negative: "Negative",
  positive: "Positive",
  neutral: "Neutral",
};

/** Which ones a person has to act on, in the order they should. */
export const NEEDS_A_PERSON: Kind[] = ["lead", "complaint", "question"];

export const isKind = (v: string): v is Kind => (KINDS as readonly string[]).includes(v);

export type Comment = {
  id: number;
  commentId: string;
  mediaId: string;
  username: string | null;
  text: string;
  postedAt: string | null;
  kind: Kind | null;
  suggestedReply: string | null;
  handled: boolean;
  permalink?: string | null;
};

export type SentimentBoard = {
  counts: Record<Kind, number>;
  total: number;
  unclassified: number;
  needsAttention: Comment[];
  /** Share of classified comments that are positive. Null with none. */
  positiveShare: number | null;
};

export type Comparison = {
  handle: string;
  label: string | null;
  followers: number | null;
  /** Posts per week, from the timestamps Meta returned. */
  perWeek: number | null;
  /** Average likes + comments per post — a rival's reach is not public. */
  avgEngagement: number | null;
  /** Engagement against their followers, the only rate computable for them. */
  ratePerFollower: number | null;
  checkedAt: string | null;
  error: string | null;
};

export type Gap = {
  headline: string;
  detail: string;
  /** A specific piece of content, never "post more". */
  suggestion: string;
};
