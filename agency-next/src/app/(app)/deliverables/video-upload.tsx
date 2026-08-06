"use client";

import { useRef, useState } from "react";
import {
  UploadCloud,
  Paperclip,
  Repeat,
  Check,
  Copy,
  Loader2,
  TriangleAlert,
  Sparkles,
} from "lucide-react";
import { getVideoUploadUrl, attachUploadedVideo } from "./upload-actions";
import { finishAnalysisAfterUpload } from "../editor/actions";
import { buttonClasses } from "@/components/ui/button";

type Phase = "idle" | "signing" | "uploading" | "saving" | "captioning" | "done" | "error";

/**
 * How many times the browser will nudge the analysis along before giving up.
 *
 * Roughly two minutes, comfortably longer than any video within the size cap
 * has taken. The ceiling matters: a job that keeps reporting "more" without
 * progressing would otherwise poll for as long as the tab stayed open.
 */
const CAPTION_POLLS = 12;

/**
 * Uploads the finished video straight from the browser to Cloudflare R2 using a
 * short-lived signed URL, then records it against the task. The bytes bypass
 * our server entirely, so there's no request-size ceiling.
 */
export function VideoUpload({
  deliverableId,
  currentUrl,
  onUploaded,
  onCaption,
  onCaptioningChange,
}: {
  deliverableId: number;
  currentUrl?: string | null;
  onUploaded?: (url: string) => void;
  /** Fires when the AI has written a caption for the video just uploaded. */
  onCaption?: (caption: string) => void;
  /**
   * True while the AI is watching the freshly uploaded video.
   *
   * Surfaced so the Generate button next to this can show it is already
   * working. Without it the caption arrives on its own a minute later and
   * anyone watching the button assumes nothing is happening and presses it,
   * paying for a second generation of the same video.
   */
  onCaptioningChange?: (busy: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [filename, setFilename] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(currentUrl ?? null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [captionNote, setCaptionNote] = useState<string | null>(null);

  const busy =
    phase === "signing" || phase === "uploading" || phase === "saving" || phase === "captioning";

  /**
   * Drive the analysis to a finished caption from the browser.
   *
   * The work is four steps across roughly half a minute and a server action
   * that sat through all of it would be killed partway, so the tab does the
   * waiting instead: each call advances the job and says whether more remains.
   *
   * Entirely best-effort. A caption that doesn't arrive must never make a
   * successful upload look like a failure — the video is safely stored either
   * way, and the AI panel on the task page can always finish the job later.
   */
  async function writeCaption() {
    setPhase("captioning");
    onCaptioningChange?.(true);
    setCaptionNote("The AI is watching the video…");

    /*
     * try/finally rather than clearing the flag at each exit.
     *
     * This loop leaves in six places — done, failed, no more work, a thrown
     * action, the poll ceiling. Anything left spinning forever would be worse
     * than no indicator at all, because a permanently disabled Generate button
     * looks like a broken page.
     */
    try {
      for (let i = 0; i < CAPTION_POLLS; i++) {
        let res;
        try {
          res = await finishAnalysisAfterUpload(deliverableId);
        } catch {
          setCaptionNote(null);
          return;
        }

        if (!res.ok) {
          // Worth showing: "the file is too big" is something to act on, and
          // silence here reads as the feature simply not working.
          setCaptionNote(res.error ?? null);
          return;
        }

        if (res.state === "done") {
          if (res.caption && res.applied) onCaption?.(res.caption);
          setCaptionNote(res.message ?? "Caption written from the video.");
          return;
        }

        setCaptionNote(res.message ?? "Writing the caption…");
        if (!res.more) return;
        await new Promise((r) => setTimeout(r, 2500));
      }

      setCaptionNote("Still working — open the task to see the caption.");
    } finally {
      onCaptioningChange?.(false);
    }
  }

  async function handleFile(file: File) {
    setError(null);
    setProgress(0);
    setFilename(file.name);
    // A replacement gets its own caption; the previous one's note would be
    // read as progress on this upload.
    setCaptionNote(null);

    if (!file.type.startsWith("video/")) {
      setPhase("error");
      setError("That doesn't look like a video file.");
      return;
    }

    setPhase("signing");
    const signed = await getVideoUploadUrl(deliverableId, file.name);
    if (!signed.ok) {
      setPhase("error");
      setError(signed.error);
      return;
    }

    // XHR rather than fetch — it's the only way to get upload progress.
    setPhase("uploading");
    const result = await new Promise<{ status: number; body: string }>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", signed.uploadUrl, true);
      // Sending this is what makes R2 store the object as a video, which both
      // Instagram and the AI analyser depend on. It also costs a CORS
      // preflight: "video/mp4" isn't a safelisted Content-Type value, so the
      // browser sends OPTIONS first and the bucket has to allow that header.
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText || "" });
      // status 0 means the browser never got a response — blocked before it
      // left, or the preflight was refused.
      xhr.onerror = () => resolve({ status: 0, body: "" });
      xhr.send(file);
    });

    if (result.status < 200 || result.status >= 300) {
      setPhase("error");
      /*
       * These two look identical to a user and have opposite causes, so they
       * must not share a message. A status of 0 means the request never
       * reached R2 — CORS. Any real status means CORS is fine and R2 itself
       * refused, which is a credentials or permissions problem.
       */
      if (result.status === 0) {
        setError(
          `The browser blocked the upload before it reached Cloudflare. Add ${window.location.origin} ` +
            `to the bucket's CORS policy, allowing PUT and the content-type header.`
        );
      } else {
        const code = result.body.match(/<Code>([^<]+)<\/Code>/)?.[1];
        setError(
          code === "SignatureDoesNotMatch"
            ? "Cloudflare rejected the signature — the R2 secret access key in Settings is wrong."
            : code === "AccessDenied"
              ? "Cloudflare refused the upload — the R2 API token needs Object Read & Write."
              : code === "NoSuchBucket"
                ? "That bucket doesn't exist — check the bucket name and account ID in Settings."
                : `Cloudflare returned ${result.status}${code ? ` (${code})` : ""}. CORS is fine; this is a credentials problem.`
        );
      }
      return;
    }

    setPhase("saving");
    const saved = await attachUploadedVideo(deliverableId, signed.key, signed.publicUrl);
    if (!saved.ok) {
      setPhase("error");
      setError(saved.error || "Uploaded, but couldn't attach it to the task.");
      return;
    }

    // `link` is the portal's permanent address for the video, so it can go
    // straight into the deliverable link field — no copy and paste, and
    // nothing that expires.
    const shown = saved.link || signed.publicUrl;
    setUrl(shown);
    setPhase("done");
    if (shown) onUploaded?.(shown);

    // The upload is complete and reported as such before this starts, so a
    // slow or failing caption can't hold up the thing that actually mattered.
    await writeCaption();
    setPhase("done");
  }

  /**
   * Copy also fills the deliverable link in. Pressing copy means "I want this
   * URL over there" — the paste was always the next step, so it may as well
   * happen. Handy for videos uploaded before the field was filled in
   * automatically.
   */
  function copy() {
    if (!url) return;
    onUploaded?.(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    navigator.clipboard?.writeText(url).catch(() => {
      // Clipboard access can be refused; the field is filled either way.
    });
  }

  return (
    <div className="space-y-2 rounded-lg border-2 border-dashed border-primary/40 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className={buttonClasses({ variant: url ? "secondary" : "default", size: "sm" })}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
          {url ? "Upload new" : "Upload Video"}
        </button>

        {filename ? (
          <span className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{filename}</span>
          </span>
        ) : null}

        {url ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className={buttonClasses({ size: "sm" })}
          >
            <Repeat className="h-4 w-4" /> Replace
          </button>
        ) : null}

        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = ""; // let the same file be picked again
          }}
        />
      </div>

      {phase === "uploading" ? (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">Uploading… {progress}%</p>
        </div>
      ) : null}

      {phase === "saving" ? (
        <p className="text-xs text-muted-foreground">Attaching to the task…</p>
      ) : null}

      {/* The caption runs after the upload has already succeeded, so this is
          progress on a bonus — never framed as part of the upload failing. */}
      {captionNote ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {phase === "captioning" ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
          )}
          <span>{captionNote}</span>
        </p>
      ) : null}

      {url ? (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs">
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <span className="truncate font-mono">{url}</span>
            </span>
            <button
              type="button"
              onClick={copy}
              title="Copy the link and put it in the deliverable link below"
              className={buttonClasses({ variant: "ghost", size: "icon" })}
            >
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {copied
              ? "Copied, and put in the deliverable link below."
              : phase === "done"
                ? "Added to the deliverable link below — save to keep it."
                : "Copy also puts this in the deliverable link below."}
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
