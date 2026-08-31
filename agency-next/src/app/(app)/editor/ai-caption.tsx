"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  Loader2,
  Check,
  TriangleAlert,
  Eye,
  BadgeCheck,
  RotateCw,
  ArrowDownToLine,
} from "lucide-react";
import { analyseVideoAction, applyCaptionAction, type AnalyseState } from "./actions";
import { saveFrames } from "../deliverables/save-frames";
import { saveAudio } from "../deliverables/save-audio";
import { extractFrames, MAX_FRAMES, FRAME_EDGE } from "@/lib/frames";
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
  /** Logo, footer and contact details the AI read off the video itself. */
  brandSeen: string | null;
  /** The briefing it was given about the business, and where each part came from. */
  contextUsed: string | null;
  caption: string | null;
  hook: string | null;
  hashtags: string | null;
  lastError: string | null;
  hasVideo: boolean;
  /**
   * Whether the AI has anything to LOOK at, as opposed to listen to.
   *
   * The model reads images and hears audio; it cannot take a video. Frames are
   * decoded in the browser as a video uploads — so a video uploaded before that
   * existed has none, and its analysis runs on the sound track alone. That is a
   * real answer and a much weaker one: everything visual — the logo, the footer,
   * the phone number burned into the last frame — is only in the picture.
   *
   * Shown rather than silently tolerated, because a caption written from audio
   * alone looks exactly like one written from the whole video.
   */
  hasFrames: boolean;
  /** The permanent address of the video, so the browser can go and read it. */
  videoHref: string | null;
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
  const router = useRouter();
  const [applied, applyAction, applying] = useActionState<AnalyseState, FormData>(
    applyCaptionAction,
    { ok: false }
  );

  /*
   * The task page is a server component; this is not.
   *
   * Applying writes the caption to the task and the action revalidates —
   * but the caption box beside this panel is a client component holding its
   * own state, initialised once. Without this the caption lands in the
   * database and the box keeps showing what it showed before, which reads
   * as the button having done nothing at all.
   */
  useEffect(() => {
    if (applied.ok) router.refresh();
  }, [applied, router]);

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

  const [reading, setReading] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  /**
   * Read frames out of a video that is already in the bucket.
   *
   * The same decoder the uploader uses, pointed at a file that went up before
   * frames existed. Two details make it possible at all:
   *
   * **The bytes come through the portal**, not straight from R2. A canvas that
   * has had a cross-origin frame drawn on it is tainted, and `toDataURL`
   * throws rather than returning an image — so pixels can only be read back
   * from a same-origin source. `?bytes=1` is that source.
   *
   * **Then the analysis is re-run.** Storing frames changes nothing on its
   * own; the caption was written without them and is still the one on screen.
   * `force` is what makes it look again rather than returning the finished
   * answer it already has.
   */
  async function readFrames() {
    if (!data.videoHref) return;
    setReadError(null);
    try {
      setReading("Fetching the video…");
      const res = await fetch(`${data.videoHref}${data.videoHref.includes("?") ? "&" : "?"}bytes=1`);
      if (!res.ok) throw new Error(`the video could not be fetched (HTTP ${res.status})`);
      const blob = await res.blob();

      setReading("Reading the frames…");
      const frames = await extractFrames(blob, MAX_FRAMES, FRAME_EDGE, (done, total) =>
        setReading(`Reading frame ${done} of ${total}…`)
      );
      if (!frames.length) {
        throw new Error("this browser could not decode that video — try Chrome, or re-upload it");
      }

      setReading("Saving what it saw…");
      const saved = await saveFrames(deliverableId, frames);
      if (!saved.ok) throw new Error(saved.error || "the frames could not be saved");

      // The same blob holds the sound track, and a video this size is very
      // likely one the server could not have transcribed itself.
      setReading("Reading the sound…");
      await saveAudio(deliverableId, blob);

      // Look again, now that there is something to look at.
      setReading("Watching it…");
      setAutoRuns(0);
      const fd = new FormData();
      fd.set("deliverable_id", String(deliverableId));
      fd.set("force", "1");
      analyseAction(fd);
      router.refresh();
    } catch (err) {
      setReadError(err instanceof Error ? err.message : "Something went wrong reading the video.");
    } finally {
      setReading(null);
    }
  }

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

        {/*
          * The AI can hear this one but has never seen it.
          *
          * Frames are decoded as a video uploads, so anything uploaded before
          * that existed has none and its caption is written from the sound
          * track alone. Said out loud rather than left to be discovered,
          * because that caption reads exactly like one written from the whole
          * video — and everything the branding rules are about (the logo, the
          * footer, the number burned into the last frame) is only in the
          * picture.
          */}
        {data.hasVideo && !data.hasFrames && data.videoHref ? (
          <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
            <p className="flex items-start gap-2">
              <Eye className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <b>The AI has not seen this video, only heard it.</b>
                <br />
                <span className="text-muted-foreground">
                  It was uploaded before the AI could read frames. Reading it now takes a few
                  seconds and happens in this tab — nothing is re-uploaded.
                </span>
              </span>
            </p>
            <button
              type="button"
              onClick={readFrames}
              disabled={reading !== null}
              className={buttonClasses({ variant: "outline", size: "sm" })}
            >
              {reading !== null ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  {reading}
                </>
              ) : (
                <>
                  <Eye className="mr-1.5 h-4 w-4" /> Let the AI watch it
                </>
              )}
            </button>
            {readError ? <p className="text-xs text-destructive">{readError}</p> : null}
          </div>
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

        {/* The branding it read off the video — the logo, the footer bar, the
            phone number. Shown separately from the summary because this is
            what an editor checks when a caption names the wrong business or
            puts the wrong number in the call to action. */}
        {done && data.brandSeen ? (
          <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <BadgeCheck className="h-3.5 w-3.5" /> Branding on the video
            </p>
            <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
              {data.brandSeen}
            </pre>
          </div>
        ) : null}

        {/* Folded away: useful when tracing why a caption came out as it did,
            noise the rest of the time. */}
        {done && data.contextUsed ? (
          <details className="rounded-md border border-border bg-muted/20 p-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              What it knew about the client
            </summary>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
              {data.contextUsed}
            </pre>
          </details>
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
        {/* The same failure arrives twice — once off the row the server
            rendered, once from the action that just ran — and showing both
            reads as two separate things having gone wrong. */}
        {analyse.error && analyse.error !== data.lastError ? (
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
