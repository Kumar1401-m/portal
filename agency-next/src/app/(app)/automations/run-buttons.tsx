"use client";

import { useTransition } from "react";
import { Play, Loader2 } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { runInsightsSyncAction, queueReportsAction, type RunState } from "./actions";

/** Kick one of the portal's own jobs off by hand. */
export function RunNow({ job, label }: { job: "insights_sync" | "monthly_reports"; label: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res: RunState =
            job === "insights_sync" ? await runInsightsSyncAction() : await queueReportsAction();
          toast({
            title: res.ok ? label : "That didn't finish",
            description: res.message,
            tone: res.ok ? undefined : "error",
            // A queued batch of client-facing reports is a thing to go and
            // read, not a thing to watch fade away.
            ack: job === "monthly_reports" || !res.ok,
          });
        })
      }
      className={buttonClasses({ variant: "outline", size: "sm" })}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
      {pending ? "Running…" : "Run now"}
    </button>
  );
}
