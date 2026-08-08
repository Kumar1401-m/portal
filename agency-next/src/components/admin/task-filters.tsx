import Link from "next/link";
import { Search, Filter, X } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Select } from "@/components/ui/select";
import { FILTER_STATUSES } from "@/lib/constants";
import type { ClientMini, Assignee } from "@/lib/deliverables";
import { cn, label } from "@/lib/utils";

const fieldClass = "h-9 text-sm";

/**
 * The task filter bar shared by every service tab: Category · Client · Status ·
 * Due date · Assigned to (plus optional search and month).
 *
 * One compact row — no stacked labels above each control (the placeholder /
 * first option already says what it is), and the due-date range is a single
 * merged from–to control instead of two separate fields. A plain GET form —
 * no JS needed, and every filtered view is a shareable URL. The active
 * service rides along in a hidden field so filtering never knocks you back
 * to "All tasks".
 */
export function TaskFilters({
  basePath,
  params,
  categories,
  clients,
  assignees,
  showSearch = true,
  showMonth = true,
}: {
  basePath: string;
  params: Record<string, string>;
  categories: string[];
  clients: ClientMini[];
  assignees: Assignee[];
  showSearch?: boolean;
  showMonth?: boolean;
}) {
  const get = (k: string) => params[k] ?? "";
  const active = Object.entries(params).filter(
    ([k, v]) => v && k !== "service"
  ).length;

  const clearHref = get("service")
    ? `${basePath}?service=${encodeURIComponent(get("service"))}`
    : basePath;

  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
      method="GET"
    >
      {/* Keep the current tab when applying filters. */}
      {get("service") ? <input type="hidden" name="service" value={get("service")} /> : null}

      {showSearch ? (
        <div className="relative w-40 flex-1 sm:w-48">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={get("q")}
            placeholder="Search…"
            aria-label="Search title or caption"
            className={cn(fieldClass, "pl-8")}
          />
        </div>
      ) : null}

      <Select
        name="category"
        defaultValue={get("category")}
        aria-label="Category"
        className={cn(fieldClass, "w-36")}
      >
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>

      <Select
        name="client"
        defaultValue={get("client")}
        aria-label="Client"
        className={cn(fieldClass, "w-36")}
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.company_name}
          </option>
        ))}
      </Select>

      <Select
        name="status"
        defaultValue={get("status")}
        aria-label="Status"
        className={cn(fieldClass, "w-32")}
      >
        <option value="">All statuses</option>
        {FILTER_STATUSES.map((s) => (
          <option key={s} value={s}>
            {label(s)}
          </option>
        ))}
      </Select>

      <Select
        name="assignee"
        defaultValue={get("assignee")}
        aria-label="Assigned to"
        className={cn(fieldClass, "w-32")}
      >
        <option value="">Anyone</option>
        {assignees.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>

      {/* Due date range — one merged control instead of two stacked fields. */}
      <div className="flex h-9 items-center gap-1 rounded-md border border-input bg-card px-1.5 shadow-sm">
        <DateField name="due_from" defaultValue={get("due_from")} aria-label="Due from" className="h-7 w-[8.25rem] border-0 p-0 text-xs shadow-none focus-visible:ring-0" />
        <span className="text-muted-foreground">–</span>
        <DateField name="due_to" defaultValue={get("due_to")} aria-label="Due to" className="h-7 w-[8.25rem] border-0 p-0 text-xs shadow-none focus-visible:ring-0" />
      </div>

      {showMonth ? (
        <Input
          type="month"
          name="month"
          defaultValue={get("month")}
          aria-label="Month"
          className={cn(fieldClass, "w-32")}
        />
      ) : null}

      <div className="flex items-center gap-1">
        <button type="submit" className={buttonClasses({ variant: "secondary", size: "sm" })}>
          <Filter className="h-3.5 w-3.5" /> Apply
        </button>
        {active > 0 ? (
          <Link href={clearHref} className={buttonClasses({ variant: "ghost", size: "sm" })}>
            <X className="h-3.5 w-3.5" /> Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}
