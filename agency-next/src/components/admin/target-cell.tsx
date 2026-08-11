"use client";

import { useRef, useState, useTransition } from "react";
import { Loader2, Pencil, TriangleAlert } from "lucide-react";
import { setMonthlyTarget } from "@/app/(app)/dashboard/actions";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/**
 * The monthly video target, changed where it is read.
 *
 * It shows as plain text until clicked, because this column is scanned far
 * more often than it is edited and a row of input boxes reads as a form
 * somebody forgot to submit. Clicking turns the one number into a field.
 *
 * Saving creates and deletes real tasks, so the outcome is reported rather
 * than assumed — the toast says what happened to the month, including when it
 * did less than asked because work had already started.
 */
export function TargetCell({
  clientId,
  clientName,
  value,
}: {
  clientId: number;
  clientName: string;
  value: number;
}) {
  const [editing, setEditing] = useState(false);
  const [shown, setShown] = useState(value);
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  /*
   * The value React rendered last, so a save elsewhere still lands here.
   *
   * Without it this cell would keep showing the number it saved after the
   * client's own edit form changed it — the local copy is the newer render's
   * loser. Adjusted during render, not from an effect.
   */
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setShown(value);
  }

  function save(next: number) {
    setEditing(false);
    if (next === shown) return;

    const previous = shown;
    setShown(next); // optimistic: the number is what was typed
    setFailed(false);

    start(async () => {
      const res = await setMonthlyTarget(clientId, next);
      if (res.error) {
        setShown(previous); // put it back — nothing was saved
        setFailed(true);
        toast({ title: `Couldn't change ${clientName}`, description: res.error, tone: "error" });
        return;
      }
      toast({
        title: `${clientName} — ${next} video${next === 1 ? "" : "s"} this month`,
        description: res.note
          ? `${res.note}.`
          : "The month already matched, so no tasks changed.",
      });
    });
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setEditing(true);
          // Focus and select after the input exists, so typing replaces the
          // number rather than appending to it.
          requestAnimationFrame(() => input.current?.select());
        }}
        disabled={pending}
        title={`Change ${clientName}'s monthly video target`}
        className={cn(
          "group inline-flex items-center gap-1 rounded px-1.5 py-0.5 tabular-nums transition-colors",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          failed && "text-destructive"
        )}
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : failed ? (
          <TriangleAlert className="h-3 w-3" />
        ) : (
          <Pencil className="h-3 w-3 text-transparent transition-colors group-hover:text-muted-foreground" />
        )}
        {shown || "—"}
      </button>
    );
  }

  return (
    <input
      ref={input}
      type="number"
      min={0}
      max={200}
      defaultValue={shown}
      autoFocus
      aria-label={`Monthly videos for ${clientName}`}
      // Blur commits, so clicking away is a save rather than a silent discard —
      // the number is already visible, and losing an edit to a stray click is
      // the more annoying of the two mistakes.
      onBlur={(e) => save(Number(e.currentTarget.value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setEditing(false);
      }}
      className="w-16 rounded border border-input bg-card px-1.5 py-0.5 text-center text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

/** The same number, for anyone who may not change it. */
export function TargetText({ value }: { value: number }) {
  return <span className="tabular-nums">{value || "—"}</span>;
}
