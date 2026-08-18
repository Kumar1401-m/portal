/**
 * How warm a lead is, and why.
 *
 * Computed, never generated. A score a model produced is a number nobody can
 * argue with and nobody can check, and this one decides who gets called back
 * today — so every point is added or removed by a rule written here, and the
 * reasons list adds up to the score exactly.
 *
 * The signals are the ones a person actually uses when they look at a
 * pipeline: how far it has come, where it came from, whether anybody has
 * spoken to them lately, and whether there is a date on it. Nothing about the
 * person, only about the enquiry.
 *
 * Pure — no database, no clock of its own. `today` is handed in, because this
 * database runs on Indian time and the app writes UTC, and a lead going cold
 * at half past six in the evening is a bug nobody would ever find.
 */
import type { Lead } from "./lead-stages";

export type Band = "hot" | "warm" | "cold";

export type LeadScore = {
  score: number;
  band: Band;
  /** What moved it, largest effect first. The score is their sum plus the base. */
  reasons: { label: string; delta: number }[];
  /** One line, for the row. */
  summary: string;
};

/** Everything starts here, so a brand-new lead is neither hot nor written off. */
export const BASE = 40;

/**
 * Where a lead came from, as points.
 *
 * A referral converts at a different rate from a cold form fill, and pretending
 * otherwise is how a pipeline gets worked in the wrong order. These are
 * deliberately modest — source is a prior, not a verdict.
 */
const SOURCE_POINTS: Record<string, number> = {
  referral: 12,
  "walk-in": 8,
  whatsapp: 5,
  instagram: 3,
  facebook: 3,
  website: 2,
  ads: 0,
  manual: 0,
};

const STAGE_POINTS: Record<string, number> = {
  new: 0,
  contacted: 8,
  qualified: 18,
  proposal: 25,
};

const daysBetween = (from: string, to: string): number => {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
};

export function scoreLead(lead: Lead, today: string): LeadScore {
  // Closed leads are not scored, they are decided. A "72% hot" badge on a
  // signed client is noise, and on a lost one it is worse — an invitation to
  // keep working something that is over.
  if (lead.stage === "won") {
    return { score: 100, band: "hot", reasons: [], summary: "Signed." };
  }
  if (lead.stage === "lost") {
    return {
      score: 0,
      band: "cold",
      reasons: [],
      summary: lead.lost_reason ? `Lost — ${lead.lost_reason}` : "Lost.",
    };
  }

  const reasons: { label: string; delta: number }[] = [];
  const add = (label: string, delta: number) => {
    if (delta !== 0) reasons.push({ label, delta });
  };

  const stage = STAGE_POINTS[lead.stage] ?? 0;
  add(`Reached ${lead.stage.replace(/_/g, " ")}`, stage);

  const source = SOURCE_POINTS[lead.source] ?? 0;
  add(`Came from ${lead.source}`, source);

  // Both ways of reaching them. A lead you can only email is one you will
  // chase twice and then forget.
  if (lead.phone && lead.email) add("Phone and email on file", 5);

  // A budget on the record means somebody asked and they answered — which is
  // a real conversation, whatever the number is.
  if (lead.value > 0) add("Budget discussed", 5);

  // Notes long enough to be a conversation rather than a name and a number.
  if ((lead.note ?? "").trim().length >= 40) add("Detailed notes recorded", 6);

  /*
   * Going cold.
   *
   * Measured from the last time the row changed, which is the closest thing
   * the table has to "when did somebody last touch this". It is not perfect —
   * an unrelated edit resets it — and it is still the difference between a
   * pipeline that is worked and one that is a list.
   */
  const idle = daysBetween(lead.updated_at || lead.created_at, today);
  if (idle >= 30) add(`Nothing for ${idle} days`, -20);
  else if (idle >= 14) add(`Quiet for ${idle} days`, -10);

  if (lead.next_follow_up) {
    const due = daysBetween(lead.next_follow_up, today);
    if (due > 0) add(`Follow-up ${due} day${due === 1 ? "" : "s"} overdue`, -Math.min(15, 5 + due));
    else add("Follow-up booked", 5);
  } else {
    // The single strongest predictor of a lead going nowhere is that nobody
    // has decided when to speak to them next.
    add("No follow-up planned", -8);
  }

  const score = Math.max(0, Math.min(100, BASE + reasons.reduce((t, r) => t + r.delta, 0)));
  const band: Band = score >= 65 ? "hot" : score >= 35 ? "warm" : "cold";

  return { score, band, reasons: reasons.sort((a, b) => b.delta - a.delta), summary: summarise(band, reasons) };
}

/** The one line on the row: the biggest reason it is where it is. */
function summarise(band: Band, reasons: { label: string; delta: number }[]): string {
  const worst = [...reasons].sort((a, b) => a.delta - b.delta)[0];
  const best = reasons[0];
  if (band === "hot") return best ? `${best.label} — call them.` : "Worth calling today.";
  if (band === "cold") return worst && worst.delta < 0 ? `${worst.label}.` : "Little to go on yet.";
  return worst && worst.delta < 0 ? `${worst.label}.` : best ? `${best.label}.` : "Keep working it.";
}

export const BAND_TEXT: Record<Band, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
};

/** Sort a board by what to do first: hottest, then whoever has waited longest. */
export function byPriority(
  leads: Lead[],
  today: string
): { lead: Lead; score: LeadScore }[] {
  return leads
    .map((lead) => ({ lead, score: scoreLead(lead, today) }))
    .sort(
      (a, b) =>
        b.score.score - a.score.score ||
        daysBetween(b.lead.updated_at || b.lead.created_at, today) -
          daysBetween(a.lead.updated_at || a.lead.created_at, today)
    );
}
