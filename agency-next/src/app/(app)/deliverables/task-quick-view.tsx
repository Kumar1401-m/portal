"use client";

import Link from "next/link";
import { useState } from "react";
import { Building2, Calendar, Link2, MessageSquareWarning, ArrowUpRight } from "lucide-react";
import type { DeliverableListRow } from "@/lib/deliverables";
import { Modal } from "@/components/ui/modal";
import { Badge, statusTone } from "@/components/ui/badge";
import { ServiceBadge } from "@/components/ui/service-badge";
import { buttonClasses } from "@/components/ui/button";
import { contentStatusLabel, editorStatusLabel, editorStatusTone } from "@/lib/constants";
import { fmtDate, label } from "@/lib/utils";

function Field({ label: l, value }: { label: string; value: React.ReactNode }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{l}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-sm">{value}</dd>
    </div>
  );
}

/**
 * Opens a task in an animated popup straight from the list, so you can read the
 * brief without losing your place. The full page is one click away.
 */
export function TaskQuickView({
  deliverable: d,
  children,
}: {
  deliverable: DeliverableListRow;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Open ${d.title}`}
        className="text-left font-medium text-foreground transition-colors hover:text-primary hover:underline"
      >
        {children}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={d.title}>
        {/* min-h-0 lets this flex child shrink so it actually scrolls; without
            it the panel's overflow-hidden clips long briefs. */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-4 w-4" /> {d.company_name}
            </span>
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-4 w-4" /> {fmtDate(d.due_date)}
            </span>
            {d.platform ? <span>{label(d.platform)}</span> : null}
            <ServiceBadge task={d} category={d.content_category} />
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge tone={statusTone(d.status)}>{contentStatusLabel(d.status)}</Badge>
            <Badge tone={editorStatusTone(d.status)}>{editorStatusLabel(d.status)}</Badge>
            <Badge tone="muted">{label(d.priority)} priority</Badge>
          </div>

          <dl className="space-y-4">
            <Field label="Content in video" value={d.content_hook} />
            <Field label="Description / script" value={d.description} />
            <Field label="Caption" value={d.caption} />
            <Field label="Content writer inputs" value={d.writer_notes} />
            <Field label="Assigned to" value={d.assignee_name} />
          </dl>

          {d.raw_drive_link || d.edited_link ? (
            <div className="space-y-2 border-t border-border pt-4">
              {d.raw_drive_link ? (
                <a
                  href={d.raw_drive_link}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 text-sm text-primary hover:underline"
                >
                  <Link2 className="h-4 w-4" /> Raw footage ↗
                </a>
              ) : null}
              {d.edited_link ? (
                <a
                  href={d.edited_link}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 text-sm text-primary hover:underline"
                >
                  <Link2 className="h-4 w-4" /> Edited / design link ↗
                </a>
              ) : null}
            </div>
          ) : null}

          {d.reject_reason ? (
            <div className="flex gap-3 rounded-md border border-[color-mix(in_srgb,var(--destructive)_35%,var(--border))] p-4">
              <MessageSquareWarning className="h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-medium text-destructive">Client&apos;s requested change</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{d.reject_reason}</p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-4">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className={buttonClasses({ variant: "secondary" })}
          >
            Close
          </button>
          <Link href={`/deliverables/${d.id}`} className={buttonClasses()}>
            <ArrowUpRight className="h-4 w-4" /> Open full task
          </Link>
        </div>
      </Modal>
    </>
  );
}
