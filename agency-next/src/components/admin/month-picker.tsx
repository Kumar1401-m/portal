import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
// The third copy of "one month either way" in this codebase, now the same one
// the ads board and the client plan use. Verified identical to the UTC version
// it replaces across every month of 2023–2028.
import { shiftMonth as shift } from "@/lib/date-range";

const LONG = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

/**
 * Month stepper. Arrows are plain links so the month survives a refresh and can
 * be shared; `basePath` keeps any other query the page cares about.
 */
export function MonthPicker({
  month,
  basePath,
  extra = {},
  label = "Month and Year",
}: {
  month: string;
  basePath: string;
  extra?: Record<string, string | undefined>;
  label?: string;
}) {
  const href = (m: string) => {
    const q = new URLSearchParams({ month: m });
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    return `${basePath}?${q.toString()}`;
  };
  const [y, m] = month.split("-");

  return (
    // An outlined field with the label notched into its border — the shape the
    // old report used, so it reads as one control rather than three buttons.
    <div className="relative inline-flex items-center gap-1 rounded border border-border px-2 py-1.5">
      <span className="absolute -top-2 left-2 bg-card px-1 text-[11px] text-muted-foreground">
        {label}
      </span>
      <Link
        href={href(shift(month, -1))}
        aria-label="Previous month"
        // Bigger than they look on a laptop: 28px is under every phone
        // platform's minimum, and these two sit a thumb's width apart.
        className={buttonClasses({ variant: "ghost", size: "icon", className: "h-10 w-10 sm:h-7 sm:w-7" })}
      >
        <ChevronLeft className="h-4 w-4" />
      </Link>
      <span
        className="min-w-28 px-2 text-center text-sm tabular-nums"
        title={LONG(month)}
      >
        {m}/{y}
      </span>
      <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Link
        href={href(shift(month, 1))}
        aria-label="Next month"
        className={buttonClasses({ variant: "ghost", size: "icon", className: "h-10 w-10 sm:h-7 sm:w-7" })}
      >
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
