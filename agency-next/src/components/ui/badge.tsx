import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Eight tones, because six made different things look the same.
 *
 * The task boards carry three status columns side by side, and with only six
 * tones "approved" and "changes requested" both came out orange — the two
 * outcomes it matters most to tell apart, at a glance, in a column you scan
 * rather than read.
 *
 * `waiting` and `active` are the two additions, and they carry the distinction
 * the boards actually turn on: work sitting with a person for a decision, and
 * work someone is doing right now.
 */
type Tone =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "waiting"
  | "active"
  | "muted";

const tones: Record<Tone, string> = {
  default: "bg-accent text-accent-foreground",
  success:
    "bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-success",
  warning:
    "bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning",
  danger:
    "bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] text-destructive",
  info: "bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-primary",
  // Sitting with someone, waiting on a decision that is not ours.
  waiting:
    "bg-violet-500/15 text-violet-700 ring-1 ring-inset ring-violet-500/25 dark:text-violet-300",
  // Being worked on right now.
  active: "bg-sky-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/25 dark:text-sky-300",
  muted: "bg-muted text-muted-foreground",
};

export function Badge({
  tone = "default",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}

/** Map a deliverable/pipeline status to a badge tone. */
export function statusTone(status: string): Tone {
  const s = (status || "").toLowerCase();
  if (["approved", "scheduled", "posted", "completed", "paid", "active"].includes(s))
    return "success";
  if (["changes_requested", "rejected", "cancelled", "overdue", "churned"].includes(s))
    return "danger";
  if (["review", "content_review", "caption_ready", "pending"].includes(s))
    return "warning";
  return "muted";
}
