/**
 * Expense categories, intervals, and the date a repeating one next falls due.
 *
 * Its own module because the ledger table is a client component and
 * `expenses.ts` is `server-only` — importing the queries there to reach a
 * label would fail the build. Same split `raw-footage.ts` has from
 * `portal.ts`, and for the same reason.
 *
 * Pure: no database, no request, no clock of its own.
 */

/**
 * Where an agency's money actually goes.
 *
 * A fixed list rather than free text: the whole point of a category is that
 * two months can be compared, and "Adobe" typed three different ways is three
 * categories that each look small.
 */
export const EXPENSE_CATEGORIES = [
  { key: "salaries", label: "Salaries & freelancers" },
  { key: "software", label: "Software & subscriptions" },
  { key: "ads", label: "Ad budget" },
  { key: "equipment", label: "Equipment" },
  { key: "office", label: "Office & rent" },
  { key: "travel", label: "Travel & shoots" },
  { key: "taxes", label: "Tax & compliance" },
  { key: "other", label: "Other" },
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["key"];

export const isCategory = (v: string): v is ExpenseCategory =>
  EXPENSE_CATEGORIES.some((c) => c.key === v);

export const categoryLabel = (key: string): string =>
  EXPENSE_CATEGORIES.find((c) => c.key === key)?.label ?? "Other";

/** How often it comes back. `once` is the default and the majority. */
export const REPEATS = ["once", "monthly", "quarterly", "yearly"] as const;
export type Repeat = (typeof REPEATS)[number];
export const isRepeat = (v: string): v is Repeat => (REPEATS as readonly string[]).includes(v);

export type ExpenseRow = {
  id: number;
  title: string;
  category: string;
  amount: number;
  vendor: string | null;
  due_on: string;
  paid_on: string | null;
  repeats: string;
  remind: number;
  remind_days: number;
  client_id: number | null;
  company_name: string | null;
  note: string | null;
};

/**
 * The date a repeating expense next falls due.
 *
 * Calendar months, not thirty days: a subscription billed on the 31st is
 * billed on the 30th in April and the 28th in February, and adding days drifts
 * the date a little further every month until a yearly one lands in the wrong
 * one. `setMonth` on a rolled-over day overflows into the next month — the 31st
 * of February becomes the 3rd of March — so it is clamped back to the last day
 * the target month actually has.
 */
export function nextDue(from: string, repeats: Repeat): string | null {
  if (repeats === "once") return null;
  const months = repeats === "monthly" ? 1 : repeats === "quarterly" ? 3 : 12;

  const [y, m, d] = String(from).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;

  const targetMonth = m - 1 + months;
  const year = y + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);

  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
