"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";
import { RANGES } from "@/lib/date-range";

/**
 * Which period the board is reporting on.
 *
 * The dates themselves are worked out in `lib/date-range`, which the page
 * imports too — so the label in this dropdown and the range behind it cannot
 * drift apart. Navigates rather than posting: the period is a URL either way,
 * and a router push keeps the scroll position.
 */
export function RangePicker({ current }: { current: string }) {
  const router = useRouter();
  return (
    <Select
      aria-label="Date range"
      value={RANGES.some((r) => r.key === current) ? current : "this_month"}
      onChange={(e) => router.push(`/ads?range=${e.target.value}`, { scroll: false })}
      className="h-9 w-40 text-sm"
    >
      {RANGES.map((r) => (
        <option key={r.key} value={r.key}>
          {r.label}
        </option>
      ))}
    </Select>
  );
}
