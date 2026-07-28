import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "default" | "success" | "warning" | "danger" | "info" | "muted";

const tones: Record<Tone, string> = {
  default: "bg-accent text-accent-foreground",
  success:
    "bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-success",
  warning:
    "bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning",
  danger:
    "bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] text-destructive",
  info: "bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-primary",
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
