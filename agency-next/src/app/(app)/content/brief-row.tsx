"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2, PenLine, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { fmtDate } from "@/lib/utils";
import { saveBriefAction, type ContentState } from "./actions";

export type CardRow = {
  id: number;
  title: string;
  dueDate: string | null;
  description: string | null;
  assigneeName: string | null;
  /** What it is about — a property, a project. "" when it belongs to none. */
  property: string;
};

/**
 * One brief, as a line — with the writing done in a popup.
 *
 * Every brief used to carry its own open textarea. For one piece that reads
 * as convenient; for a client's month it is eight full-height editors stacked
 * down the page, and finding the third one means scrolling past two you were
 * not working on. The tasks already exist by this point — this screen is for
 * filling them in, which is one at a time.
 *
 * So the row says what it is and whether it is written, and the popup is
 * where the writing happens. Same on every other board in the portal, which
 * is the other half of the reason.
 */
export function BriefRow({ row }: { row: CardRow }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [body, setBody] = useState(row.description ?? "");
  const [property, setProperty] = useState(row.property);
  const [saved, setSaved] = useState(Boolean((row.description ?? "").trim()));
  const [pending, start] = useTransition();
  const toast = useToast();

  const save = () => {
    start(async () => {
      const fd = new FormData();
      fd.set("deliverable_id", String(row.id));
      fd.set("description", body);
      fd.set("campaign", property);
      const res: ContentState = await saveBriefAction({ ok: false }, fd);
      if (res.ok) {
        setSaved(Boolean(body.trim()));
        // The server names an unnamed piece from the copy. Reflected here so
        // the row updates without a reload — and so the person who wrote it
        // sees what it was called while they can still change it.
        if (res.title) setTitle(res.title);
        setOpen(false);
        toast({ title: res.message ?? "Saved." });
      } else {
        toast({ title: res.error ?? "Could not save.", tone: "error" });
      }
    });
  };

  const preview = body.trim().replace(/\s+/g, " ");

  return (
    <>
      <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <Link
              href={`/deliverables/${row.id}`}
              className="truncate text-sm font-medium hover:text-primary hover:underline"
            >
              {title}
            </Link>
            {saved ? <Badge tone="info">Written</Badge> : <Badge tone="active">To write</Badge>}
          </div>
          {/* The first line of the copy, or the date. Enough to tell two rows
              apart without opening either. */}
          <p className="truncate text-xs text-muted-foreground">
            {row.dueDate ? fmtDate(row.dueDate) : "no date"}
            {row.assigneeName ? ` · ${row.assigneeName}` : ""}
            {preview ? ` · ${preview.slice(0, 70)}${preview.length > 70 ? "…" : ""}` : ""}
          </p>
        </div>
        <Button size="sm" variant={saved ? "ghost" : "default"} onClick={() => setOpen(true)}>
          <PenLine className="h-3.5 w-3.5" />
          {saved ? "Edit" : "Write"}
        </Button>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={title}>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`body-${row.id}`}>Content for this piece</Label>
            <Textarea
              id={`body-${row.id}`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              autoFocus
              placeholder="Exactly as the client should read it."
            />
            {/* Said once, here, because it happens on save and would otherwise
                look like the portal renaming things on its own. */}
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
              Pieces still called &ldquo;Video 6&rdquo; get a proper name from this copy when you
              save. Rename it yourself on the task page and we&apos;ll leave it alone.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`prop-${row.id}`}>Property or project</Label>
            <Input
              id={`prop-${row.id}`}
              value={property}
              onChange={(e) => setProperty(e.target.value)}
              placeholder="Optional — groups this with the rest of that property's content"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
