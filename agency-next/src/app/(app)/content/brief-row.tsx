"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2, PenLine, Send, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { fmtDate } from "@/lib/utils";
import { saveBriefAction, submitForApprovalAction, type ContentState } from "./actions";

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

  /**
   * Save, and optionally keep going.
   *
   * "Save" and "save then send" were two trips through this dialog and back —
   * write it, close, find the row again, press send. They are one thought, so
   * they are one press: the copy is written to be sent, and stopping halfway
   * is the exception rather than the shape of the job.
   *
   * The save has to land first either way. Sending reads the description from
   * the database, so sending what is still only in this textarea would put an
   * empty brief in front of a client — or refuse, having just saved nothing.
   */
  const run = (then: "close" | "send") => {
    start(async () => {
      const fd = new FormData();
      fd.set("deliverable_id", String(row.id));
      fd.set("description", body);
      fd.set("campaign", property);
      const res: ContentState = await saveBriefAction({ ok: false }, fd);
      if (!res.ok) {
        toast({ title: res.error ?? "Could not save.", tone: "error" });
        return;
      }
      setSaved(Boolean(body.trim()));
      // The server names an unnamed piece from the copy. Reflected here so
      // the row updates without a reload — and so the person who wrote it
      // sees what it was called while they can still change it.
      if (res.title) setTitle(res.title);

      if (then === "close") {
        setOpen(false);
        toast({ title: res.message ?? "Saved." });
        return;
      }

      const out = new FormData();
      out.set("deliverable_id", String(row.id));
      const sent: ContentState = await submitForApprovalAction({ ok: false }, out);
      if (sent.ok) {
        setOpen(false);
        toast({ title: sent.message ?? "Sent for approval." });
      } else {
        // Saved but not submitted, and said so — the copy is safe either way.
        toast({ title: `Saved, but not submitted: ${sent.error}`, tone: "error" });
      }
    });
  };

  const save = () => run("close");
  /*
   * The only bar is having written something.
   *
   * It used to also require the right role and a linked WhatsApp group,
   * because the button sent to the client. It does not any more — it hands
   * the piece to the super admin, and whether it then goes to the client or
   * straight to the team is their decision, made on the Approvals page where
   * those two buttons live.
   */
  const canSendThis = body.trim().length > 0;

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

          {/* One row, and the hint above it rather than hanging off the
              right-hand edge under a button. */}
          <div className="space-y-2 border-t border-border pt-3">
            {!canSendThis ? (
              <p className="text-xs text-muted-foreground">
                Write the content before sending it for approval.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Goes to Approvals for a super admin to read. They decide whether it goes to the
                client or straight to the team.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              {/* Kept, because writing half a month before submitting any of
                  it is a real way to work — and because a piece may need a
                  second pass before anyone else reads it. */}
              <Button variant="outline" onClick={save} disabled={pending}>
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Save
              </Button>
              <Button onClick={() => run("send")} disabled={pending || !canSendThis}>
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Save &amp; send for approval
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
