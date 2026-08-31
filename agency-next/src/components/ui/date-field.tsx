"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

/**
 * The panel's own size in pixels, so it can be placed before it is rendered.
 *
 * The width is `w-[17.5rem]` at the default root size. The height is only used
 * to decide whether to open upwards, so being a few pixels out there costs
 * nothing — being wrong about the width would push it off the screen.
 */
const PANEL_W = 280;
const PANEL_H = 340;

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
  compact = false,
  align = "left",
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
  /**
   * Just the calendar, at icon size.
   *
   * The full control is a button wide enough to read "26 Aug 2026" off, which
   * is right where the date is the thing being edited. Dropped into a table's
   * actions column — twenty units wide, shared with a pencil — it rendered as
   * "26" with the rest cut off: a fragment of a date that cannot be read,
   * beside a Schedule date column already printing the whole thing.
   *
   * So this is the icon alone, sized to sit next to the pencil. The date it
   * holds is on the tooltip and in the label.
   */
  compact?: boolean;
  /** Which edge the calendar hangs from — see `place`. */
  align?: "left" | "right";
  "aria-label"?: string;
}) {
  const [value, setValue] = useState(defaultValue ? defaultValue.slice(0, 10) : "");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => parse(defaultValue) ?? new Date());
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const hidden = useRef<HTMLInputElement>(null);

  /**
   * Where the calendar goes, measured against the window.
   *
   * It was `absolute` inside this component's own box, which is right
   * everywhere except the place it is now used most: a cell of a dense table.
   * Those carry `overflow-hidden` — `table-fixed` needs it so a long value is
   * clipped rather than widening its column — inside a wrapper that is
   * `overflow-x-auto`. Between them the panel was cropped to the height of a
   * table row, so the picker opened and there was nothing to see. That reads
   * exactly like a button that does not work.
   *
   * So it is measured off the trigger and rendered into `document.body`, where
   * no ancestor can crop it. Fixed rather than absolute, because
   * `getBoundingClientRect` is already in viewport coordinates.
   */
  const place = useCallback(() => {
    const b = trigger.current?.getBoundingClientRect();
    if (!b) return;
    // Hung from whichever edge was asked for, and never off either one.
    const wanted = align === "right" ? b.right - PANEL_W : b.left;
    const left = Math.min(Math.max(8, wanted), window.innerWidth - PANEL_W - 8);
    // Below, unless there is more room above — a row near the foot of a long
    // board would otherwise open past the bottom of the window.
    const below = window.innerHeight - b.bottom;
    const top = below < PANEL_H && b.top > below ? b.top - PANEL_H - 4 : b.bottom + 4;
    setAt({ top, left });
  }, [align]);

  // Close on a click elsewhere or Escape. Without both, a picker left open
  // sits on top of the next thing you try to click. The panel is no longer a
  // descendant of `box`, so a click inside it has to be recognised separately
  // or picking a date would count as clicking away.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Detached from its trigger the moment anything moves, so it follows one.
    // Captured, to catch scrolling inside the table wrapper and not only the page.
    const follow = () => place();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open, place]);

  /**
   * Take the picked date, and make sure the form can see it.
   *
   * The imperative write to the hidden input is the whole point, and without
   * it the monthly plan silently did nothing.
   *
   * `setValue` is a React state update: it is batched and applied when the
   * event handler finishes. `onChange` fires inside that handler, and the
   * caller's handler is `form.requestSubmit()` — which serialises the form
   * straight out of the DOM, before React has written anything. So the submit
   * carried the *previous* value. Picking a date for the first time submitted
   * an empty string, which the action reads as "clear the date"; every later
   * pick saved the date before it. Either way the date on screen was never the
   * date that was saved.
   *
   * Setting `.value` here is not a second source of truth. React renders the
   * same string a moment later, so the two agree — this only closes the gap
   * between them.
   */
  const commit = (v: string) => {
    if (hidden.current) hidden.current.value = v;
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
      <input ref={hidden} type="hidden" name={name} value={value} readOnly />
      <button
        ref={trigger}
        id={id}
        type="button"
        disabled={disabled}
        // Measured before it is shown, so it never appears in the wrong place
        // for a frame and then jumps.
        onClick={() => {
          if (!open) place();
          setOpen((o) => !o);
        }}
        // The compact one does not carry the date on its face, so it has to be
        // somewhere: the tooltip, and the label a screen reader gets.
        title={compact ? (value ? pretty(value) : placeholder) : undefined}
        aria-label={
          ariaLabel ? (value ? `${ariaLabel} — ${pretty(value)}` : ariaLabel) : "Pick a date"
        }
        aria-expanded={open}
        className={cn(
          "flex h-9 items-center rounded-md transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          "disabled:cursor-not-allowed disabled:opacity-50",
          compact
            ? "w-9 justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
            : "w-full gap-2 border border-input bg-card px-3 text-left text-sm shadow-sm hover:bg-accent/40"
        )}
      >
        <CalendarDays
          className={cn(
            "h-4 w-4 shrink-0",
            // A date that is set is worth seeing at a glance; an empty one
            // should look like the empty thing it is.
            compact ? value && "text-foreground" : "text-muted-foreground"
          )}
        />
        {compact ? null : (
          <span className={cn("tabular-nums", !value && "text-muted-foreground")}>
            {value ? pretty(value) : placeholder}
          </span>
        )}
      </button>

      {open && at ? (
        createPortal(
        <div
          ref={panel}
          role="dialog"
          style={{ top: at.top, left: at.left, width: PANEL_W }}
          className="fixed z-50 rounded-lg border border-border bg-card p-3 shadow-lg"
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
        </div>,
        document.body
        )
      ) : null}
    </div>
  );
}
