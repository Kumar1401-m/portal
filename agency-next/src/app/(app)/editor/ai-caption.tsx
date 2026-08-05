"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Loader2,
  Check,
  TriangleAlert,
  Eye,
  RotateCw,
  ArrowDownToLine,
} from "lucide-react";
import { analyseVideoAction, applyCaptionAction, type AnalyseState } from "./actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";

export type AiCaptionData = {
  state: string;
  summary: string | null;
  spokenLanguage: string | null;
  topic: string | null;
  mood: string | null;
  onScreenText: string | null;
  caption: string | null;
  hook: string | null;
  hashtags: string | null;
  lastError: string | null;
  hasVideo: boolean;
  tokensUsed: number | null;
};

const STEP_LABEL: Record<string, string> = {
  queued: "Queued",
  uploading: "Sending the video to the AI",
  processing: "The AI is watching it",
  analysing: "Writing the caption",
  done: "Written from the video",
  failed: "Failed",
};

const TONE: Record<string, "success" | "warning" | "danger" | "muted"> = {
  done: "success",
  failed: "danger",
  queued: "muted",
  uploading: "warning",
  processing: "warning",
  analysing: "warning",
};

/**
 * The AI caption panel.
 *
 * Analysis is a multi-step job that can outlive a single serverless request,
 * so this drives it: it fires the action, and while the server reports there
 * is more to do it fires again. That keeps every individual request short
 * enough to survive, and means a killed request costs one poll rather than the
 * whole job.
 *
 * What the AI *saw* is shown above what it *wrote*, deliberately. When a
 * caption looks wrong the summary is how an editor tells "the model
 * misunderstood the video" from "the model understood it and phrased it
 * badly" — which are different problems with different fixes.
 */
export function AiCaption({
  deliverableId,
  data,
}: {
  deliverableId: number;
  data: AiCaptionData;
}) {
  const [analyse, analyseAction, analysing] = useActionState<AnalyseState, FormData>(
    analyseVideoAction,
    { ok: false }
  );
  const [applied, applyAction, applying] = useActionState<AnalyseState, FormData>(
    applyCaptionAction,
    { ok: false }
  );

  const formRef = useRef<HTMLFormElement>(null);
  const [autoRuns, setAutoRuns] = useState(0);

  /*
   * Continue a job the server says isn't finished.
   *
   * Capped: a job that keeps reporting "more" without progressing would
   * otherwise poll forever and quietly spend tokens. Twelve rounds is about
   * two minutes, comfortably longer than any video we accept takes.
   */
  useEffect(() => {
    if (!analyse.more || analysing || autoRuns >= 12) return;
    const t = setTimeout(() => {
      setAutoRuns((n) => n + 1);
      formRef.current?.requestSubmit();
    }, 2500);
    return () => clearTimeout(t);
  }, [analyse.more, analyse.state, analysing, autoRuns]);

  // Live state wins once the user has acted; otherwise show what the server
  // rendered, so an already-finished analysis appears immediately.
  const state = analyse.state || data.state;
  const busy = analysing || (analyse.more ?? false);
  const done = state === "done";
  const caption = analyse.caption ?? data.caption;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            AI caption
          </span>
          <Badge tone={TONE[state] ?? "muted"}>{STEP_LABEL[state] ?? state}</Badge>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {!data.hasVideo ? (
          <p className="flex items-start gap-2 text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Upload the finished video first — the AI writes the caption by watching it.</span>
          </p>
        ) : null}

        {busy ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {analyse.message || STEP_LABEL[state] || "Working…"}
            <span className="text-xs text-muted-foreground/70">this takes about 30 seconds</span>
          </p>
        ) : null}

        {/* What it understood, before what it wrote. */}
        {done && data.summary ? (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Eye className="h-3.5 w-3.5" /> What the AI saw
            </p>
            <p className="text-sm">{data.summary}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {data.spokenLanguage ? <span>Spoken: {data.spokenLanguage}</span> : null}
              {data.topic ? <span>Topic: {data.topic}</span> : null}
              {data.mood ? <span>Mood: {data.mood}</span> : null}
            </div>
            {data.onScreenText ? (
              <p className="text-xs text-muted-foreground">
                On screen: <span className="italic">{data.onScreenText}</span>
              </p>
            ) : null}
          </div>
        ) : null}

        {done && caption ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Suggested caption</p>
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-card p-3 font-sans text-sm leading-relaxed">
              {caption}
            </pre>
            {data.hashtags ? (
              <p className="text-xs text-muted-foreground">{data.hashtags}</p>
            ) : null}
          </div>
        ) : null}

        {state === "failed" && data.lastError ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{data.lastError}</span>
          </p>
        ) : null}
        {analyse.error ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{analyse.error}</span>
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <form ref={formRef} action={analyseAction}>
            <input type="hidden" name="deliverable_id" value={deliverableId} />
            {/* A rewrite reuses the already-uploaded file, so it costs one
                generation rather than another upload. */}
            <input type="hidden" name="force" value={done ? "1" : "0"} />
            <button
              type="submit"
              disabled={busy || !data.hasVideo}
              className={buttonClasses({ variant: done ? "secondary" : "default", size: "sm" })}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : done ? (
                <RotateCw className="h-4 w-4" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {busy ? "Working…" : done ? "Rewrite" : "Watch video & write caption"}
            </button>
          </form>

          {done && caption ? (
            <form action={applyAction}>
              <input type="hidden" name="deliverable_id" value={deliverableId} />
              <button
                type="submit"
                disabled={applying}
                className={buttonClasses({ size: "sm" })}
                title="Replace the task's caption with this one"
              >
                {applying ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowDownToLine className="h-4 w-4" />
                )}
                Use this caption
              </button>
            </form>
          ) : null}

          {data.tokensUsed ? (
            <span className="text-xs text-muted-foreground">
              {data.tokensUsed.toLocaleString("en-IN")} tokens
            </span>
          ) : null}
        </div>

        {applied.error ? <p className="text-xs text-destructive">{applied.error}</p> : null}
        {applied.ok && applied.message ? (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <Check className="h-3.5 w-3.5" /> {applied.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
