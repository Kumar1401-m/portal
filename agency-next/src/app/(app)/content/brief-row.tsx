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
  // Only worth saying while it is still true — once it has a name, the notice
  // is a sentence about something that already happened.
  const isPlaceholder = /^(video|poster|reel|post)\s*\d+$/i.test(title.trim());
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

      {/*
        Body and footer, the way every other dialog in the portal is built.

        `Modal` renders its children with no padding of its own — it owns the
        header and nothing else — so a caller that just drops a stack of
        fields in gets exactly what this one had: labels and inputs flush
        against the edges, and the footer text running off the right of the
        card. The body scrolls and the buttons stay put, which matters here
        because the textarea is the tallest thing in the portal.
      */}
      <Modal open={open} onClose={() => setOpen(false)} title={title}>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor={`body-${row.id}`}>Content for this piece</Label>
              {/* Counted because it goes out on WhatsApp, where length is the
                  difference between one message and three. */}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {body.trim().length} characters
              </span>
            </div>
            <Textarea
              id={`body-${row.id}`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={9}
              autoFocus
              placeholder="Exactly as the client should read it."
              className="min-h-[12rem] resize-y leading-relaxed"
            />
            {/* Said once, here, because it happens on save and would otherwise
                look like the portal renaming things on its own. */}
            {isPlaceholder ? (
              <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span>
                  This piece is still called <span className="font-medium">{title}</span>. Saving
                  gives it a proper name from what you write here — rename it yourself on the task
                  page and we&apos;ll leave it alone.
                </span>
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`prop-${row.id}`}>
              Property or project{" "}
              <span className="font-normal text-muted-foreground">— optional</span>
            </Label>
            <Input
              id={`prop-${row.id}`}
              value={property}
              onChange={(e) => setProperty(e.target.value)}
              placeholder="Green Meadows"
            />
            <p className="text-xs text-muted-foreground">
              Groups this with the rest of that property&apos;s content, and names the message the
              client receives.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {canSendThis
              ? "Sending puts this on Approvals for a super admin to read."
              : "Write the content before sending it for approval."}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            {/* Kept, because writing half a month before submitting any of it
                is a real way to work — and because a piece may need a second
                pass before anyone else reads it. */}
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
              Send for approval
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
