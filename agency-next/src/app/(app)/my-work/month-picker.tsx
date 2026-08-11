"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";

/** "August 2026" from "2026-08". */
function label(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

/**
 * Which month the page is reporting on.
 *
 * Only months this person actually has work in, so the list cannot offer a
 * choice that comes back empty. Navigates rather than posting: the month is a
 * URL either way, and a router push keeps the scroll position.
 */
export function MonthPicker({ months, current }: { months: string[]; current: string }) {
  const router = useRouter();
  if (months.length <= 1) return null;

  return (
    <Select
      aria-label="Month"
      value={current}
      onChange={(e) => router.push(`/my-work?month=${e.target.value}`, { scroll: false })}
      className="h-9 w-44 text-sm"
    >
      {months.map((m) => (
        <option key={m} value={m}>
          {label(m)}
        </option>
      ))}
    </Select>
  );
}
