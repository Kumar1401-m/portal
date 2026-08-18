"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";
import { RANGES, recentMonths, monthRangeLabel } from "@/lib/date-range";

/**
 * Which period the board is reporting on.
 *
 * Months first, because that is the unit the business runs in: a client is
 * billed for a month, a plan is written for a month, and "what did July cost"
 * is the question actually asked. The relative ranges answer "lately", which
 * is a fine thing to want and an awkward thing to reconcile against an
 * invoice — so they stay, below the months, rather than leading.
 *
 * The dates themselves are worked out in `lib/date-range`, which the page
 * imports too — so the label in this dropdown and the range behind it cannot
 * drift apart. Navigates rather than posting: the period is a URL either way,
 * and a router push keeps the scroll position.
 */
export function RangePicker({
  current,
  basePath = "/ads",
}: {
  current: string;
  /** Which board it is narrowing — the client page reuses it. */
  basePath?: string;
}) {
  const router = useRouter();
  const months = recentMonths(12);
  // A hand-typed or bookmarked key that is neither a month nor a known range
  // would otherwise select nothing and show a blank control.
  const known = months.includes(current) || RANGES.some((r) => r.key === current);

  return (
    <Select
      aria-label="Period"
      value={known ? current : months[0]}
      onChange={(e) => router.push(`${basePath}?range=${e.target.value}`, { scroll: false })}
      className="h-9 w-40 text-sm"
    >
      <optgroup label="Month">
        {months.map((m) => (
          <option key={m} value={m}>
            {monthRangeLabel(m)}
          </option>
        ))}
      </optgroup>
      {/* Kept, and kept second. "This year" is the only one of these that
          answers a question a month cannot. */}
      <optgroup label="Or a rolling period">
        {RANGES.filter((r) => r.key !== "this_month" && r.key !== "last_month").map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </optgroup>
    </Select>
  );
}
