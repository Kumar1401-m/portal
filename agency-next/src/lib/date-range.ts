/**
 * The reporting periods, and what dates each one means.
 *
 * Plain module, no JSX and no "use client": the dropdown needs the labels and
 * the server needs the dates, and if those two ever computed the range
 * separately the board would eventually say "this month" over last month's
 * numbers. One function, both callers.
 */

export const RANGES = [
  { key: "this_month", label: "This month" },
  { key: "last_30", label: "Last 30 days" },
  { key: "last_month", label: "Last month" },
  { key: "last_7", label: "Last 7 days" },
  { key: "this_year", label: "This year" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** A named month, "2026-08" — the shape a client asks their questions in. */
const MONTH_KEY = /^(\d{4})-(\d{2})$/;

/** "2026-08" → "Aug 2026". */
export function monthRangeLabel(key: string): string {
  const m = MONTH_KEY.exec(key);
  if (!m) return key;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
  });
}

/**
 * The last `count` months, newest first, as range keys.
 *
 * Built from today rather than from what the data happens to hold: a month
 * with no spend is a real answer ("we ran nothing in June"), and a picker
 * that hides it makes that answer unaskable.
 */
export function recentMonths(count = 12, from = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(from.getFullYear(), from.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/**
 * A range key, or an explicit from/to, into two dates.
 *
 * Both ends inclusive. An ad day is Meta's day in the account's own timezone,
 * so these are plain dates and never timestamps — attaching a clock to them
 * would silently drop or double the edges.
 */
export function resolveRange(
  key?: string,
  from?: string,
  to?: string
): { from: string; to: string; key: string } {
  const ok = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const a = ok(from);
  const b = ok(to);
  // Dates the wrong way round are swapped rather than refused: it is obvious
  // what was meant, and an empty board would look like an empty month.
  if (a && b) return { from: a <= b ? a : b, to: a <= b ? b : a, key: "custom" };

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = iso(now);

  /*
   * A named month — "2026-08" — which is how a client asks: what did July
   * cost, what did June bring in. The relative ranges below answer "lately",
   * which is a different question and a worse one to reconcile against an
   * invoice.
   *
   * A month still running stops at today rather than at the 31st. Dividing
   * this month's spend by its whole length would report a cost per day that
   * has not happened yet.
   */
  const named = MONTH_KEY.exec(key ?? "");
  if (named) {
    const yy = Number(named[1]);
    const mm = Number(named[2]) - 1;
    if (mm >= 0 && mm <= 11) {
      const first = iso(new Date(Date.UTC(yy, mm, 1)));
      const last = iso(new Date(Date.UTC(yy, mm + 1, 0)));
      return { from: first, to: last > today ? today : last, key: key as string };
    }
  }

  switch (key) {
    case "last_7":
      // Seven days including today, so it reaches back six.
      return { from: iso(new Date(Date.now() - 6 * 86400000)), to: today, key };
    case "last_30":
      return { from: iso(new Date(Date.now() - 29 * 86400000)), to: today, key };
    case "last_month": {
      const first = new Date(Date.UTC(y, m - 1, 1));
      // Day 0 of this month is the last day of the previous one.
      const last = new Date(Date.UTC(y, m, 0));
      return { from: iso(first), to: iso(last), key };
    }
    case "this_year":
      return { from: iso(new Date(Date.UTC(y, 0, 1))), to: today, key };
    case "this_month":
    default:
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: today, key: "this_month" };
  }
}
