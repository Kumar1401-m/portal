"use client";

import { useTransition } from "react";
import { Play, Loader2 } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  runInsightsSyncAction,
  queueReportsAction,
  runPublisherAction,
  type RunState,
} from "./actions";

const JOBS = {
  insights_sync: runInsightsSyncAction,
  monthly_reports: queueReportsAction,
  publishing: runPublisherAction,
} as const;

/** Kick one of the portal's own jobs off by hand. */
export function RunNow({ job, label }: { job: keyof typeof JOBS; label: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res: RunState = await JOBS[job]();
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
