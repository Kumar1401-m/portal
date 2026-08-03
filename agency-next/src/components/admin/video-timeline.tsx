import { Check, Circle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimelineStep } from "@/lib/whatsapp-approvals";

function when(at: string | null): string {
  if (!at) return "";
  const d = new Date(at.replace(" ", "T") + (at.includes("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * A video's journey, for the client to read.
 *
 * Deliberately shows future steps greyed rather than hiding them: a client
 * looking at this wants to know what happens next as much as what has already
 * happened, and a list that grows one item at a time gives no sense of how
 * much is left.
 */
export function VideoTimeline({ steps }: { steps: TimelineStep[] }) {
  // The first not-yet-done step is "current" — highlighted so the eye lands on
  // where things actually are.
  const currentIndex = steps.findIndex((s) => !s.done);

  return (
    <ol className="space-y-0">
      {steps.map((step, i) => {
        const isCurrent = i === currentIndex;
        const isLast = i === steps.length - 1;

        return (
          <li key={step.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 transition-colors",
                  step.done
                    ? "border-success bg-success text-white"
                    : isCurrent
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground"
                )}
              >
                {step.done ? (
                  <Check className="h-3.5 w-3.5" />
                ) : isCurrent ? (
                  <Clock className="h-3.5 w-3.5" />
                ) : (
                  <Circle className="h-2 w-2 fill-current" />
                )}
              </span>
              {/* The connector stops at the last step, so the line doesn't
                  trail off into nothing. */}
              {!isLast ? (
                <span
                  className={cn(
                    "w-0.5 flex-1 transition-colors",
                    step.done ? "bg-success/40" : "bg-border"
                  )}
                  style={{ minHeight: "1.75rem" }}
                />
              ) : null}
            </div>

            <div className={cn("pb-6", isLast && "pb-0")}>
              <p
                className={cn(
                  "text-sm font-medium",
                  !step.done && !isCurrent && "text-muted-foreground"
                )}
              >
                {step.label}
              </p>
              {step.at ? (
                <p className="text-xs text-muted-foreground">{when(step.at)}</p>
              ) : isCurrent ? (
                <p className="text-xs text-primary">In progress</p>
              ) : null}
              {step.detail ? (
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                  {step.detail}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
