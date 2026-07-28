"use client";

import { useState, useActionState } from "react";
import { Upload, Loader2, CheckCircle2 } from "lucide-react";
import { submitRawFootage, type PortalActionState } from "./actions";
import { Modal } from "@/components/ui/modal";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const INIT: PortalActionState = { ok: false };

function FootageItemForm({
  id,
  title,
  category,
}: {
  id: number;
  title: string;
  category: string | null;
}) {
  const [state, action, pending] = useActionState(submitRawFootage, INIT);

  if (state.ok) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-4">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-xs text-success">{state.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <p className="truncate text-sm font-medium">{title}</p>
      {category ? <p className="text-xs text-muted-foreground">{category}</p> : null}
      <form action={action} className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input type="hidden" name="deliverable_id" value={id} />
        <Input name="raw_drive_link" placeholder="https://drive.google.com/…" className="flex-1" />
        <Button type="submit" size="sm" disabled={pending} className="sm:w-auto">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Submit
        </Button>
      </form>
      {state.error ? <p className="mt-1 text-xs text-destructive">{state.error}</p> : null}
    </div>
  );
}

/**
 * Grabs the client's attention the moment they land on the dashboard: a
 * full-screen popup (dark backdrop + centered dialog — same Modal used
 * elsewhere) listing every task waiting on their raw footage, so they can
 * submit right there instead of hunting through the task list.
 */
export function RawFootagePopup({
  items,
}: {
  items: { id: number; title: string; content_category: string | null }[];
}) {
  const [open, setOpen] = useState(items.length > 0);
  if (items.length === 0) return null;

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="We need your raw footage">
      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <p className="text-sm text-muted-foreground">
          {items.length === 1
            ? "This task is ready for editing — share your raw footage link below."
            : `${items.length} tasks are ready for editing — share the raw footage link for each.`}
        </p>
        <div className="space-y-3">
          {items.map((it) => (
            <FootageItemForm key={it.id} id={it.id} title={it.title} category={it.content_category} />
          ))}
        </div>
      </div>
      <div className="flex shrink-0 justify-end border-t border-border p-4">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={buttonClasses({ variant: "outline" })}
        >
          I&apos;ll do this later
        </button>
      </div>
    </Modal>
  );
}
