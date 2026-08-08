"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A date picker that looks like the rest of the portal.
 *
 * The browser's own is cramped, styles itself, ignores the theme, and looks
 * different in every browser — on a page where dates are the main thing being
 * edited, that is the control people touch most and trust least.
 *
 * Drop-in for `<input type="date">`: same `name`, same `YYYY-MM-DD` value, and
 * a real hidden input carries it, so plain form submits and server actions
 * keep working untouched. `onChange` fires with the value, matching the
 * pattern the monthly plan already uses to save on pick.
 */

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Local YYYY-MM-DD. Not toISOString, which shifts the day across a timezone. */
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function parse(v: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function pretty(v: string): string {
  const d = parse(v);
  return d
    ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";
}

export function DateField({
  id,
  name,
  defaultValue = "",
  onChange,
  className,
  placeholder = "Pick a date",
  disabled,
  "aria-label": ariaLabel,
}: {
  /** Paired with a <Label htmlFor>, so the label still focuses the control. */
  id?: string;
  name: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const [value, setValue] = useState(defaultValue ? defaultValue.slice(0, 10) : "");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => parse(defaultValue) ?? new Date());
  const box = useRef<HTMLDivElement>(null);

  // Close on a click elsewhere or Escape. Without both, a picker left open
  // sits on top of the next thing you try to click.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const commit = (v: string) => {
    setValue(v);
    setOpen(false);
    onChange?.(v);
  };

  const todayIso = iso(new Date());
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const lead = first.getDay();
  const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const shift = (by: number) =>
    setView(new Date(view.getFullYear(), view.getMonth() + by, 1));

  return (
    <div ref={box} className={cn("relative", className)}>
      <input type="hidden" name={name} value={value} />
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel || "Pick a date"}
        aria-expanded={open}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-card px-3 text-left text-sm",
          "shadow-sm transition-colors hover:bg-accent/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className={cn("tabular-nums", !value && "text-muted-foreground")}>
          {value ? pretty(value) : placeholder}
        </span>
      </button>

      {open ? (
        <div
          role="dialog"
          className="absolute left-0 top-full z-50 mt-1 w-[17.5rem] rounded-lg border border-border bg-card p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shift(-1)}
              aria-label="Previous month"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium">
              {MONTHS[view.getMonth()]} {view.getFullYear()}
            </span>
            <button
              type="button"
              onClick={() => shift(1)}
              aria-label="Next month"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center">
            {DAYS.map((d) => (
              <span key={d} className="py-1 text-[0.7rem] font-medium text-muted-foreground">
                {d}
              </span>
            ))}
            {Array.from({ length: lead }).map((_, i) => (
              <span key={`x${i}`} />
            ))}
            {Array.from({ length: days }).map((_, i) => {
              const d = new Date(view.getFullYear(), view.getMonth(), i + 1);
              const v = iso(d);
              const selected = v === value;
              const isToday = v === todayIso;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => commit(v)}
                  className={cn(
                    "rounded-md py-1.5 text-sm tabular-nums transition-colors",
                    "hover:bg-accent",
                    selected && "bg-primary font-medium text-primary-foreground hover:bg-primary",
                    !selected && isToday && "font-semibold text-primary ring-1 ring-primary/40"
                  )}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
            <button
              type="button"
              onClick={() => commit("")}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                setView(new Date());
                commit(todayIso);
              }}
              className="text-xs font-medium text-primary hover:underline"
            >
              Today
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
