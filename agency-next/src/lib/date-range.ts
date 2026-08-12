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
