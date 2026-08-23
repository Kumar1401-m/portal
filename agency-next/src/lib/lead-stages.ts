/**
 * The lead pipeline's vocabulary — stages, sources, and the arithmetic the
 * board's header is built from.
 *
 * Its own module because the board is a client component and `leads.ts` is
 * `server-only`: importing the queries there to reach a stage label would
 * fail the build. Same split `expense-kinds.ts` has from `expenses.ts`, and
 * for the same reason.
 *
 * Pure: no database, no request, and no clock of its own — `today` is always
 * handed in.
 */
/* ------------------------------ The pipeline ------------------------------ */

export type StageKey = "new" | "contacted" | "qualified" | "proposal" | "won" | "lost";

export const LEAD_STAGES: { key: StageKey; label: string; hint: string }[] = [
  { key: "new", label: "New", hint: "Came in, nobody has spoken to them yet" },
  { key: "contacted", label: "Contacted", hint: "Reached out, waiting to hear back" },
  { key: "qualified", label: "Qualified", hint: "Real budget, real need" },
  { key: "proposal", label: "Proposal sent", hint: "Quoted — this is the one that goes cold" },
  { key: "won", label: "Won", hint: "Signed" },
  { key: "lost", label: "Lost", hint: "Not happening, and why" },
];

/** Stages a lead is still live in. Won and lost are where it stops moving. */
export const OPEN_STAGES: StageKey[] = ["new", "contacted", "qualified", "proposal"];

export const isStage = (v: string): v is StageKey =>
  LEAD_STAGES.some((s) => s.key === v);

export const stageLabel = (v: string): string =>
  LEAD_STAGES.find((s) => s.key === v)?.label ?? v;

export const LEAD_SOURCES = [
  "instagram",
  "facebook",
  "whatsapp",
  "referral",
  "website",
  "walk-in",
  "ads",
  "manual",
] as const;

export type Source = (typeof LEAD_SOURCES)[number];
export const isSource = (v: string): v is Source =>
  (LEAD_SOURCES as readonly string[]).includes(v);

export const sourceLabel = (v: string): string =>
  v === "walk-in" ? "Walk-in" : v.charAt(0).toUpperCase() + v.slice(1);

export type Lead = {
  id: number;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  stage: StageKey;
  value: number;
  owner_user_id: number | null;
  owner_name: string | null;
  /** Whose ads produced this lead, when it came from a client's campaign. */
  client_name: string | null;
  next_follow_up: string | null;
  note: string | null;
  lost_reason: string | null;
  client_id: number | null;
  created_at: string;
  updated_at: string;
};

/**
 * A follow-up that has come and gone.
 *
 * Compared as plain YYYY-MM-DD strings against the day passed in, never
 * against `new Date()` inside the function — the database clock here runs on
 * Indian time and the app writes UTC, and a lead going red at 6:30pm because
 * of that difference is exactly the sort of thing nobody would ever debug.
 */
export function isOverdue(followUp: string | null, today: string): boolean {
  if (!followUp) return false;
  return followUp.slice(0, 10) < today;
}

export function isDueToday(followUp: string | null, today: string): boolean {
  return Boolean(followUp) && followUp!.slice(0, 10) === today;
}

export type Funnel = {
  stages: { key: StageKey; label: string; count: number; value: number }[];
  /** Money attached to everything still open. */
  openValue: number;
  wonValue: number;
  /** Won ÷ (won + lost), as a percentage. Null until something has closed. */
  conversion: number | null;
  overdue: number;
  dueToday: number;
};

/** Everything the header of the board shows, from the rows it already has. */
export function funnel(leads: Lead[], today: string): Funnel {
  const stages = LEAD_STAGES.map((s) => ({ key: s.key, label: s.label, count: 0, value: 0 }));
  const at = new Map(stages.map((s) => [s.key, s]));

  let openValue = 0;
  let wonValue = 0;
  let overdue = 0;
  let dueToday = 0;

  for (const l of leads) {
    const bucket = at.get(l.stage);
    if (bucket) {
      bucket.count++;
      bucket.value += l.value;
    }
    if (l.stage === "won") wonValue += l.value;
    else if (l.stage !== "lost") {
      openValue += l.value;
      // Only an open lead can be overdue. A lost one whose follow-up date
      // passed is not a task anybody has to do.
      if (isOverdue(l.next_follow_up, today)) overdue++;
      else if (isDueToday(l.next_follow_up, today)) dueToday++;
    }
  }

  const won = at.get("won")?.count ?? 0;
  const lost = at.get("lost")?.count ?? 0;
  const closed = won + lost;

  return {
    stages,
    openValue,
    wonValue,
    // Against everything that has *closed*, not against every lead ever — a
    // pipeline full of live enquiries would otherwise drag the rate down for
    // the crime of being busy.
    conversion: closed ? (won / closed) * 100 : null,
    overdue,
    dueToday,
  };
}
