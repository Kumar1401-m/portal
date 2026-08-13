"use client";

import Link from "next/link";
import { Search, X } from "lucide-react";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { buttonClasses } from "@/components/ui/button";

/**
 * From and To, applied on submit.
 *
 * A plain GET form: the range is a URL either way, so the report can be
 * shared, bookmarked and reloaded, and the back button behaves. Applied on
 * submit rather than on change, because picking a From date usually means a To
 * date is coming and reloading in between shows a range nobody asked for.
 *
 * Clear returns to the default month rather than an empty range — a report of
 * no days is not a useful place to land.
 */
export function DateFilter({ from, to }: { from: string; to: string }) {
  return (
    <form method="GET" action="/team" className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="from">From date</Label>
        <DateField id="from" name="from" defaultValue={from} className="h-10 w-44" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="to">To date</Label>
        <DateField id="to" name="to" defaultValue={to} className="h-10 w-44" />
      </div>
      <button type="submit" className={buttonClasses({ size: "sm" })}>
        <Search className="h-4 w-4" /> Apply
      </button>
      <Link href="/team" className={buttonClasses({ variant: "ghost", size: "sm" })}>
        <X className="h-4 w-4" /> Clear
      </Link>
    </form>
  );
}
