"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
// The month arithmetic lives in the lib, where it can be tested without a
// JSX loader and where the ads board reads it too.
import { shiftMonth, monthRangeLabel } from "@/lib/date-range";

/**
 * One month at a time, with an arrow either side.
 *
 * Reading a month means walking through them in order — last month, this one,
 * the one before — and a dropdown makes every one of those steps a hunt
 * through a list for the entry immediately next to the one you are on. Two
 * arrows are the movement itself.
 *
 * The second use of this shape rather than the first: the client's monthly
 * plan got it, the ads board wanted the same thing, and two copies of a
 * control that navigates by URL is two places for the year to stop rolling
 * over correctly.
 */

export function MonthStepper({
  month,
  href,
  className = "",
}: {
  /** The month on show, "YYYY-MM". */
  month: string;
  /** Where an arrow goes. Given the month it lands on. */
  href: (month: string) => string;
  className?: string;
}) {
  const router = useRouter();
  const go = (delta: number) =>
    router.push(href(shiftMonth(month, delta)), { scroll: false });

  return (
    <div className={`flex items-center rounded-lg border border-border ${className}`}>
      <button
        type="button"
        aria-label="Previous month"
        onClick={() => go(-1)}
        className="flex h-8 w-8 items-center justify-center rounded-l-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {/* Fixed width, so the row does not shift as the label changes between
          "May 2026" and "Sept 2026". */}
      <span className="w-24 text-center text-xs font-medium tabular-nums">
        {monthRangeLabel(month)}
      </span>
      <button
        type="button"
        aria-label="Next month"
        onClick={() => go(1)}
        className="flex h-8 w-8 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
