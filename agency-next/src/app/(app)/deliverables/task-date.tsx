"use client";

import { useActionState, useRef } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { DateField } from "@/components/ui/date-field";
import { moveTaskDateAction, type TaskDateState } from "./task-date-actions";

/**
 * One task's date, changed where the task is.
 *
 * Sits beside the pencil on every row that has one. The pencil opens the whole
 * task; this is the one field on it that changes weekly, and it should not
 * cost a modal — still less a trip into the client, which is where the only
 * other way to do it lived.
 *
 * Saves as soon as a date is picked rather than behind a button. The row is
 * already the thing being edited, and a save button per row is fifteen buttons
 * on a full board, fourteen of which are always wrong to press.
 *
 * The date and the posting slot move together — see `setTaskDate`. Two
 * controls for "which day does this go out" is the shape of bug where a board
 * says Thursday and the publisher still thinks Tuesday.
 */
export function TaskDate({
  taskId,
  title,
  dueDate,
  compact = true,
  className,
}: {
  taskId: number;
  /** Only for the screen-reader label, so a row of these is distinguishable. */
  title: string;
  dueDate: string | null;
  /**
   * The calendar alone, sized to sit beside the pencil. True on the boards,
   * where the actions column is twenty units wide and the whole date is
   * already printed two columns over — a readable date field does not fit and
   * would only repeat one that does. False on the monthly plan, where the
   * date is the thing being read.
   */
  compact?: boolean;
  className?: string;
}) {
  const [state, action, pending] = useActionState<TaskDateState, FormData>(moveTaskDateAction, {});
  const form = useRef<HTMLFormElement>(null);

  return (
    <form ref={form} action={action} className="flex items-center">
      <input type="hidden" name="task_id" value={taskId} />
      <DateField
        name="due_date"
        defaultValue={dueDate ? String(dueDate).slice(0, 10) : ""}
        onChange={() => form.current?.requestSubmit()}
        aria-label={`Date for ${title}`}
        placeholder="Set date"
        compact={compact}
        // Last column of a table: a panel hung from the left edge opens off
        // the side of the page.
        align={compact ? "right" : "left"}
        className={className ?? (compact ? undefined : "w-[11rem]")}
      />
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
      {!pending && state.ok ? <Check className="h-3.5 w-3.5 text-success" /> : null}
      {!pending && state.error ? (
        <span title={state.error}>
          <TriangleAlert className="h-3.5 w-3.5 text-destructive" />
        </span>
      ) : null}
    </form>
  );
}
