import { Filter, X } from "lucide-react";
import Link from "next/link";
import type { ClientMini } from "@/lib/deliverables";
import { FILTER_STATUSES } from "@/lib/constants";
import { label } from "@/lib/utils";
import { buttonClasses } from "@/components/ui/button";

/**
 * Filters that sit in the columns they filter.
 *
 * A separate filter bar makes you translate between two layouts: the bar says
 * "All clients" and the table says "Organization", and you work out they are
 * the same thing. Putting the control under its own heading removes that step
 * — the column tells you what it filters, and the answer appears directly
 * below it.
 *
 * A plain GET form, so a filtered view is a URL: shareable, bookmarkable, and
 * still there after a refresh. The header row is the form; Apply is one
 * button at the end of it.
 */

const CELL =
  "h-8 w-full rounded border border-input bg-card px-1.5 text-xs text-foreground " +
  "focus:outline-none focus:ring-1 focus:ring-ring";

export function ColumnFilters({
  basePath,
  params,
  clients,
  categories,
  columns,
}: {
  basePath: string;
  params: Record<string, string>;
  clients: ClientMini[];
  categories: string[];
  /** How many columns precede the filtered ones, so the row lines up. */
  columns: { lead: number; trail: number };
}) {
  const active = ["client", "category", "status"].some((k) => params[k]);

  return (
    <tr className="border-b border-border bg-muted/20">
      {/* The row is one form. Hidden fields carry every filter this row does
          not show, so filtering by client does not silently drop the service
          tab or a date range set elsewhere. */}
      <th colSpan={columns.lead} className="px-2 py-1.5">
        <form id="colfilters" method="GET" action={basePath} />
        {Object.entries(params)
          .filter(([k]) => !["client", "category", "status"].includes(k))
          .map(([k, v]) => (
            <input key={k} form="colfilters" type="hidden" name={k} value={v} />
          ))}
      </th>

      <th className="px-2 py-1.5">
        <select form="colfilters" name="client" defaultValue={params.client || ""} className={CELL}>
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.company_name}
            </option>
          ))}
        </select>
      </th>

      <th className="px-2 py-1.5">
        <select form="colfilters" name="category" defaultValue={params.category || ""} className={CELL}>
          <option value="">All types</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </th>

      {/* Schedule date — filtered from the bar's range, not per column. */}
      <th className="px-2 py-1.5" />

      <th className="px-2 py-1.5">
        <select form="colfilters" name="status" defaultValue={params.status || ""} className={CELL}>
          <option value="">All statuses</option>
          {FILTER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
      </th>

      {/* Design status is derived from the same column as content status, so a
          second control here would be two ways to set one thing. */}
      <th className="px-2 py-1.5" />

      {/* Post status has no filter behind it in the query layer, and a
          control that silently does nothing is worse than none. */}
      <th className="px-2 py-1.5" />

      <th colSpan={Math.max(1, columns.trail - 1)} className="px-2 py-1.5" />

      <th className="px-2 py-1.5 text-right">
        <div className="flex items-center justify-end gap-1">
          {active ? (
            <Link
              href={basePath}
              title="Clear filters"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </Link>
          ) : null}
          <button
            type="submit"
            form="colfilters"
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            <Filter className="h-3.5 w-3.5" /> Apply
          </button>
        </div>
      </th>
    </tr>
  );
}
