import Link from "next/link";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { buttonClasses } from "@/components/ui/button";

/**
 * One box: type a client, a title or a caption and press Enter.
 *
 * What replaced the row of dropdowns. Five selects reading "all" took a strip
 * of screen to say nothing, and the one thing anyone actually wanted from them
 * — find that task — was the one thing they were slowest at. Typing three
 * letters of a client's name beats opening a list of every client.
 *
 * A plain GET form, so it works without JavaScript, the result is a URL worth
 * sharing, and the back button behaves. The active service tab rides along in
 * a hidden field: searching inside Videos should stay inside Videos.
 *
 * No `page` field, deliberately — a new search starts at page one, and
 * carrying "page 3" into a result set of two would land on nothing.
 */
export function SearchBox({
  basePath,
  params,
  placeholder = "Search a client, a title or a caption…",
}: {
  basePath: string;
  params: Record<string, string>;
  placeholder?: string;
}) {
  const q = params.q ?? "";
  const service = params.service ?? "";

  // Clearing keeps the tab you are on and drops everything else.
  const clearHref = service ? `${basePath}?service=${encodeURIComponent(service)}` : basePath;

  return (
    <form method="GET" action={basePath} className="flex items-center gap-2">
      {service ? <input type="hidden" name="service" value={service} /> : null}

      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={placeholder}
          aria-label="Search tasks"
          className="h-10 pl-9"
        />
      </div>

      <button type="submit" className={buttonClasses({ size: "sm" })}>
        Search
      </button>

      {q ? (
        <Link href={clearHref} className={buttonClasses({ variant: "ghost", size: "sm" })}>
          <X className="h-4 w-4" /> Clear
        </Link>
      ) : null}
    </form>
  );
}
