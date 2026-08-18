"use client";

import Link from "next/link";
import { MonthStepper } from "@/components/ui/month-stepper";
import { thisMonthKey } from "@/lib/date-range";

/**
 * Which period the board is reporting on.
 *
 * A month at a time, stepped. The board used to offer five rolling windows —
 * this month, last 30 days, last month, last 7 days, this year — which is
 * five ways of saying "lately" and no way of saying "July". A client is
 * billed for a month and asks about a month, and a thirty-day window gives a
 * number that cannot be put beside an invoice.
 *
 * "This year" is kept as a link rather than dropped, because it is the one
 * period a month cannot express and it is what the board opens on when
 * somebody wants the total. The rest went: they were each a month under
 * another name, or a window nobody reconciles against anything.
 *
 * The dates themselves are worked out in `lib/date-range`, which the page
 * imports too — so what this control says and what the board counts cannot
 * drift apart.
 */
export function RangePicker({
  current,
  basePath = "/ads",
}: {
  current: string;
  /**
   * Which board it is narrowing — the client page and the analytics board
   * reuse it. May already carry a query (`/analytics?client=3`), so the range
   * is appended with the right separator rather than a second `?`.
   */
  basePath?: string;
}) {
  const to = (range: string) => `${basePath}${basePath.includes("?") ? "&" : "?"}range=${range}`;
  const onYear = current === "this_year";
  // A rolling key, or a bookmarked one that no longer parses, steps from the
  // current month rather than leaving the arrows with nothing to move from.
  const month = /^\d{4}-\d{2}$/.test(current) ? current : thisMonthKey();

  return (
    <div className="flex items-center gap-2">
      <MonthStepper month={month} href={to} />
      <Link
        href={to(onYear ? month : "this_year")}
        aria-pressed={onYear}
        className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
          onYear
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
      >
        This year
      </Link>
    </div>
  );
}
