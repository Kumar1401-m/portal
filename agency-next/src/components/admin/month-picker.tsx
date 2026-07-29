import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";

/** "2026-07" -> "2026-06" / "2026-08". */
function shift(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

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
}: {
  month: string;
  basePath: string;
  extra?: Record<string, string | undefined>;
}) {
  const href = (m: string) => {
    const q = new URLSearchParams({ month: m });
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    return `${basePath}?${q.toString()}`;
  };

  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1">
      <Link
        href={href(shift(month, -1))}
        aria-label="Previous month"
        className={buttonClasses({ variant: "ghost", size: "icon", className: "h-8 w-8" })}
      >
        <ChevronLeft className="h-4 w-4" />
      </Link>
      <span className="min-w-40 px-2 text-center text-sm font-medium tabular-nums">
        {LONG(month)}
      </span>
      <Link
        href={href(shift(month, 1))}
        aria-label="Next month"
        className={buttonClasses({ variant: "ghost", size: "icon", className: "h-8 w-8" })}
      >
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
