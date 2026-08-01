import Link from "next/link";
import { Filter, X } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { RANGE_OPTIONS, type ParsedFilters } from "@/lib/analytics-filters";
import type { AnalyticsClient } from "@/lib/analytics";

const fieldClass = "h-9 text-sm";

/**
 * One filter row, above everything it scopes — every chart on the page
 * re-renders against the same slice. Never a filter inside a chart card.
 *
 * A plain GET form, like the rest of the portal's filter bars: no client
 * JavaScript, and every filtered view is a shareable URL.
 *
 * The custom date inputs are always present rather than revealed by the range
 * select. Showing them conditionally would need client state, and a disabled-
 * looking pair of dates that spring to life when you pick "Custom range" is
 * more confusing than two fields that are simply ignored until then.
 */
export function AnalyticsFilterBar({
  basePath,
  filters,
  clients,
  campaigns,
}: {
  basePath: string;
  filters: ParsedFilters;
  clients: AnalyticsClient[];
  campaigns: string[];
}) {
  const active =
    (filters.clientId ? 1 : 0) +
    (filters.campaign ? 1 : 0) +
    (filters.range !== "30d" ? 1 : 0) +
    (filters.platform !== "instagram" ? 1 : 0);

  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
      method="GET"
      action={basePath}
    >
      <Select
        name="client"
        defaultValue={filters.clientId ? String(filters.clientId) : ""}
        aria-label="Client"
        className={cn(fieldClass, "w-44")}
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.company_name}
          </option>
        ))}
      </Select>

      <Select
        name="range"
        defaultValue={filters.range}
        aria-label="Date range"
        className={cn(fieldClass, "w-36")}
      >
        {RANGE_OPTIONS.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </Select>

      {/* Only read when the range above is "Custom range". */}
      <div className="flex h-9 items-center gap-1 rounded-md border border-input bg-card px-1.5 shadow-sm">
        <Input
          type="date"
          name="from"
          defaultValue={filters.from}
          aria-label="From date (used with Custom range)"
          className="h-7 w-[8.25rem] border-0 p-0 text-xs shadow-none focus-visible:ring-0"
        />
        <span className="text-muted-foreground">–</span>
        <Input
          type="date"
          name="to"
          defaultValue={filters.to}
          aria-label="To date (used with Custom range)"
          className="h-7 w-[8.25rem] border-0 p-0 text-xs shadow-none focus-visible:ring-0"
        />
      </div>

      <Select
        name="platform"
        defaultValue={filters.platform}
        aria-label="Platform"
        className={cn(fieldClass, "w-32")}
      >
        {/* Instagram is the only platform collected today. The others are
            listed because the schema is platform-keyed and the filter is part
            of the contract — they return empty until a collector exists. */}
        <option value="instagram">Instagram</option>
        <option value="facebook">Facebook</option>
        <option value="youtube">YouTube</option>
      </Select>

      <Select
        name="campaign"
        defaultValue={filters.campaign || ""}
        aria-label="Campaign"
        className={cn(fieldClass, "w-36")}
      >
        <option value="">All campaigns</option>
        {campaigns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>

      <div className="flex items-center gap-1">
        <button type="submit" className={buttonClasses({ variant: "secondary", size: "sm" })}>
          <Filter className="h-3.5 w-3.5" /> Apply
        </button>
        {active > 0 ? (
          <Link href={basePath} className={buttonClasses({ variant: "ghost", size: "sm" })}>
            <X className="h-3.5 w-3.5" /> Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}
