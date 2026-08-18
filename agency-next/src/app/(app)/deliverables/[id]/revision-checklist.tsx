"use client";

import { useState, useTransition } from "react";
import { ListChecks, Loader2, Sparkles, Check } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { label } from "@/lib/utils";
import type { RevisionItem } from "@/lib/revision-kinds";
import { splitFeedbackAction, saveItemsAction, toggleItemAction } from "./revision-actions";

/**
 * The client's change request, as a checklist.
 *
 * Sits directly under their own words, which stay on the page unchanged —
 * the checklist is a reading of what they said, not a replacement for it, and
 * when the two disagree the client's sentence is the one that counts.
 *
 * Proposed items are held in the browser until somebody accepts them. That
 * gap is deliberate: this is the one feature here where a model interprets
 * rather than counts, and an editor silently handed a job the client never
 * asked for is exactly what it must not do.
 */
export function RevisionChecklist({
  deliverableId,
  initial,
}: {
  deliverableId: number;
  initial: RevisionItem[];
}) {
  const [items, setItems] = useState<RevisionItem[]>(initial);
  const [proposed, setProposed] = useState<RevisionItem[] | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();

  const saved = items.length > 0;
  const done = items.filter((i) => i.done).length;

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ListChecks className="h-3.5 w-3.5" />
          {saved ? `Checklist — ${done} of ${items.length} done` : "Break it into jobs"}
        </p>
        {!proposed ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await splitFeedbackAction(deliverableId);
                if (res.ok) setProposed(res.items);
                else toast({ title: "Not split", description: res.error, tone: "error", ack: true });
              })
            }
            className={buttonClasses({ variant: "outline", size: "sm" })}
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {saved ? "Split again" : "Split into jobs"}
          </button>
        ) : null}
      </div>

      {/* Proposed — not yet anybody's work. */}
      {proposed ? (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <p className="text-xs text-muted-foreground">
            Read these against what the client wrote above. Accepting replaces the current
            checklist; anything already ticked off is kept.
          </p>
          {proposed.map((p, i) => (
            <div key={i} className="rounded-md border border-border bg-card p-2.5">
              <p className="text-sm font-medium">{p.title}</p>
              {p.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{p.detail}</p> : null}
              {p.role ? (
                <p className="mt-1 text-xs text-muted-foreground">For the {label(p.role)}</p>
              ) : null}
            </div>
          ))}
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setProposed(null)}
              className={buttonClasses({ variant: "ghost", size: "sm" })}
            >
              Discard
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await saveItemsAction(deliverableId, proposed);
                  toast({
                    title: res.ok ? res.message : "Not saved",
                    description: res.ok ? undefined : res.message,
                    tone: res.ok ? undefined : "error",
                  });
                  if (res.ok) {
                    setItems([...items.filter((x) => x.done), ...proposed]);
                    setProposed(null);
                  }
                })
              }
              className={buttonClasses({ size: "sm" })}
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Accept
            </button>
          </div>
        </div>
      ) : null}

      {items.map((item) => (
        <label
          key={item.id}
          className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 transition-colors hover:bg-muted/50"
        >
          <input
            type="checkbox"
            checked={Boolean(item.done)}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.checked;
              setItems((cur) => cur.map((x) => (x.id === item.id ? { ...x, done: next } : x)));
              start(async () => {
                const res = await toggleItemAction(deliverableId, item.id!, next);
                if (!res.ok) {
                  // Put it back rather than leaving the box showing something
                  // the database does not agree with.
                  setItems((cur) => cur.map((x) => (x.id === item.id ? { ...x, done: !next } : x)));
                  toast({ title: res.message, tone: "error" });
                }
              });
            }}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-[var(--primary)]"
          />
          <span className="min-w-0">
            <span className={`block text-sm ${item.done ? "text-muted-foreground line-through" : ""}`}>
              {item.title}
            </span>
            {item.detail ? (
              <span className="block text-xs text-muted-foreground">{item.detail}</span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  );
}
