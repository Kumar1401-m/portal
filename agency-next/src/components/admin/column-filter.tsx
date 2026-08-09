"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Filter, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A filter that lives on its column heading and stays out of the way.
 *
 * The row of always-open selects was six controls competing with twelve
 * headings for the same strip of screen, and five of them were set to "all"
 * at any moment. This shows a funnel instead, filled in when that column is
 * actually filtered, and opens the control only when asked.
 *
 * Navigates rather than submitting a form: the filter is a URL either way,
 * but a router push keeps the scroll position, and a table you have scrolled
 * down should not jump to the top because you narrowed it.
 */
export function ColumnFilter({
  label,
  name,
  value,
  options,
  basePath,
  params,
}: {
  label: string;
  /** The query-string key this column filters on. */
  name: string;
  value: string;
  options: { value: string; label: string }[];
  basePath: string;
  /** Every filter currently set, so changing one keeps the rest. */
  params: Record<string, string>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const active = Boolean(value);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const go = (next: string) => {
    const q = new URLSearchParams(params);
    if (next) q.set(name, next);
    else q.delete(name);
    // A filtered view always starts at its first page; page 3 of the old
    // result set means nothing once the set has changed.
    q.delete("page");
    const s = q.toString();
    setOpen(false);
    router.push(s ? `${basePath}?${s}` : basePath, { scroll: false });
  };

  const current = options.find((o) => o.value === value);

  return (
    <div ref={box} className="relative inline-flex items-center gap-1">
      <span>{label}</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Filter by ${label}`}
        aria-expanded={open}
        title={active ? `Filtered: ${current?.label ?? value}` : `Filter by ${label}`}
        className={cn(
          "rounded p-0.5 transition-colors",
          active
            ? "text-primary"
            : "text-muted-foreground/40 hover:bg-accent hover:text-foreground"
        )}
      >
        <Filter className={cn("h-3 w-3", active && "fill-current")} />
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border border-border bg-card p-1 shadow-lg">
          <ul className="max-h-64 overflow-y-auto">
            <li>
              <button
                type="button"
                onClick={() => go("")}
                className={cn(
                  "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs font-normal normal-case hover:bg-accent",
                  !active && "font-medium text-primary"
                )}
              >
                All
                {!active ? <span aria-hidden>✓</span> : null}
              </button>
            </li>
            {options.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  onClick={() => go(o.value)}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs font-normal normal-case hover:bg-accent",
                    o.value === value && "font-medium text-primary"
                  )}
                >
                  <span className="truncate">{o.label}</span>
                  {o.value === value ? <span aria-hidden>✓</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {active ? (
            <button
              type="button"
              onClick={() => go("")}
              className="mt-1 flex w-full items-center gap-1 border-t border-border px-2 py-1.5 text-left text-xs font-normal normal-case text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" /> Clear this filter
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
