import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Previous / next across a list that is already in memory.
 *
 * The board fetches its rows in one query and shows a slice, so paging is a
 * link that changes one number. No state, no fetch, and the page survives a
 * refresh or a shared URL — which a button holding the number in memory
 * would not.
 *
 * Every other filter travels in the link, so paging inside a filtered view
 * stays inside it.
 */
export function Pager({
  basePath,
  params,
  page,
  totalPages,
  totalItems,
  pageSize,
}: {
  basePath: string;
  params: Record<string, string>;
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
}) {
  if (totalPages <= 1) return null;

  const href = (p: number) => {
    const q = new URLSearchParams(params);
    // Page 1 is the bare URL: a "?page=1" that only ever means "the start"
    // is noise in a link someone might share.
    if (p > 1) q.set("page", String(p));
    else q.delete("page");
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalItems);

  const step = (to: number, label: string, disabled: boolean, icon: "prev" | "next") => {
    const body = (
      <>
        {icon === "prev" ? <ChevronLeft className="h-4 w-4" /> : null}
        {label}
        {icon === "next" ? <ChevronRight className="h-4 w-4" /> : null}
      </>
    );
    // A disabled link is a span, not an <a> with a dead href — otherwise it
    // takes keyboard focus and reads as clickable to a screen reader.
    return disabled ? (
      <span
        aria-disabled="true"
        className={cn(buttonClasses({ variant: "outline", size: "sm" }), "pointer-events-none opacity-40")}
      >
        {body}
      </span>
    ) : (
      <Link href={href(to)} scroll={false} className={buttonClasses({ variant: "outline", size: "sm" })}>
        {body}
      </Link>
    );
  };

  return (
    <nav
      aria-label="Pages"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"
    >
      <p className="text-xs text-muted-foreground tabular-nums">
        {first}–{last} of {totalItems}
      </p>
      <div className="flex items-center gap-2">
        {step(page - 1, "Previous", page <= 1, "prev")}
        <span className="text-xs text-muted-foreground tabular-nums">
          {page} / {totalPages}
        </span>
        {step(page + 1, "Next", page >= totalPages, "next")}
      </div>
    </nav>
  );
}
