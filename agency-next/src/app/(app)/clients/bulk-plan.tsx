"use client";

import { useActionState } from "react";
import { CalendarPlus, Check, TriangleAlert, Loader2 } from "lucide-react";
import { generateForAllAction, type BulkPlanState } from "./bulk-actions";
import { buttonClasses } from "@/components/ui/button";

/**
 * This month's tasks for every client already on the books.
 *
 * Adding a client generates their first month, which does nothing for the
 * clients who were here before that existed, and nothing for the month after.
 * Doing it one client at a time is the same typing one level up.
 *
 * It says what it will create before it creates it, because "add tasks for
 * everyone" is a sentence that deserves a number attached.
 */
export function BulkPlanButton({
  month,
  clients,
  videos,
  posters,
}: {
  month: string;
  clients: number;
  videos: number;
  posters: number;
}) {
  const [state, action, pending] = useActionState<BulkPlanState, FormData>(
    generateForAllAction,
    {}
  );

  const nothing = clients === 0;
  const bits = [
    videos ? `${videos} video${videos > 1 ? "s" : ""}` : "",
    posters ? `${posters} poster${posters > 1 ? "s" : ""}` : "",
  ].filter(Boolean);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={action}>
        <input type="hidden" name="month" value={month} />
        <button
          type="submit"
          disabled={pending || nothing}
          className={buttonClasses({ variant: "outline" })}
          title={
            nothing
              ? "Every client already has this month's tasks"
              : `Adds ${bits.join(" and ")} across ${clients} client${clients > 1 ? "s" : ""}`
          }
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CalendarPlus className="h-4 w-4" />
          )}
          {nothing ? "Month is full" : `Add this month's tasks (${bits.join(" + ")})`}
        </button>
      </form>

      {state.ok && state.message ? (
        <p className="flex items-center gap-1 text-xs text-success">
          <Check className="h-3.5 w-3.5" /> {state.message}
        </p>
      ) : null}
      {state.error ? (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <TriangleAlert className="h-3.5 w-3.5" /> {state.error}
        </p>
      ) : null}
    </div>
  );
}
