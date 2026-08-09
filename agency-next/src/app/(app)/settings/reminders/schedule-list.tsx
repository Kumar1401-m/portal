"use client";

import { useActionState, useState } from "react";
import { CalendarClock, ChevronDown, Loader2, X } from "lucide-react";
import { cancelReminderAction, type CancelState } from "./actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ScheduledItem = {
  id: number;
  kind: string;
  kindLabel: string;
  who: string;
  body: string;
  /** Already rendered in Indian time by the server — see the page. */
  whenLabel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  byWhom: string | null;
};

function CancelButton({ id }: { id: number }) {
  const [state, action, pending] = useActionState<CancelState, FormData>(cancelReminderAction, {});
  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        title={state.error || "Cancel this reminder"}
        className={cn(
          "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
          state.error
            ? "text-destructive"
            : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        )}
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
        {state.error ? "Too late" : "Cancel"}
      </button>
    </form>
  );
}

/**
 * One waiting message, folded shut.
 *
 * The full text is what makes cancelling a real decision rather than a guess,
 * so it is one click away — but ten open messages would be a wall of text, and
 * the line that matters when scanning is who and when.
 */
function Row({ item, cancellable }: { item: ScheduledItem; cancellable: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-border last:border-0">
      <div className="flex items-start gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex flex-wrap items-center gap-2">
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
            />
            <span className="text-sm font-medium">{item.who}</span>
            <Badge tone="muted">{item.kindLabel}</Badge>
            {item.status === "sent" ? <Badge tone="success">Sent</Badge> : null}
            {item.status === "failed" ? <Badge tone="danger">Failed</Badge> : null}
            {item.status === "cancelled" ? <Badge tone="muted">Cancelled</Badge> : null}
            {item.status === "sending" ? <Badge tone="warning">Sending</Badge> : null}
          </span>
          <span className="mt-0.5 block pl-5 text-xs tabular-nums text-muted-foreground">
            {item.whenLabel}
            {item.byWhom ? ` · ${item.byWhom}` : ""}
            {item.attempts > 1 ? ` · ${item.attempts} attempts` : ""}
          </span>
          {!open ? (
            <span className="mt-1 block truncate pl-5 text-xs text-muted-foreground">
              {item.body.replace(/\s+/g, " ").slice(0, 110)}
            </span>
          ) : null}
        </button>
        {cancellable ? <CancelButton id={item.id} /> : null}
      </div>

      {open ? (
        <pre className="mx-4 mb-3 ml-9 whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground">
          {item.body}
        </pre>
      ) : null}

      {item.lastError ? (
        <p className="px-4 pb-2.5 pl-9 text-xs text-destructive">{item.lastError}</p>
      ) : null}
    </li>
  );
}

export function ScheduleList({
  scheduled,
  history,
}: {
  scheduled: ScheduledItem[];
  history: ScheduledItem[];
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-5 w-5 text-primary" /> Waiting to go out
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Times are Indian time. Cancel any of these until the moment it sends.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {scheduled.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing scheduled.</p>
          ) : (
            <ul>
              {scheduled.map((s) => (
                <Row key={s.id} item={s} cancellable={s.status === "scheduled"} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Already sent</CardTitle>
          <p className="text-xs text-muted-foreground">
            The record of what went to which group, for when a client says they were never told.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul>
              {history.map((s) => (
                <Row key={s.id} item={s} cancellable={false} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
