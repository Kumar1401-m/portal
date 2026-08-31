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
import { saveFrames } from "./save-frames";
import { saveAudio } from "./save-audio";
import { extractFrames, MAX_FRAMES, FRAME_EDGE } from "@/lib/frames";
import { finishAnalysisAfterUpload } from "../editor/actions";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
/** How the caption is getting on, and whether that is good news. */
export type CaptionNote = { text: string; tone: "busy" | "done" | "error" } | null;

/**
 * The one line that says what the caption AI is doing.
 *
 * Exported so whichever component is showing it draws the same thing. Two
 * lookalike indicators in two files is how they drifted into saying the same
 * sentence twice in slightly different words.
 */
export function CaptionLine({ note }: { note: NonNullable<CaptionNote> }) {
  const Icon = note.tone === "busy" ? Loader2 : note.tone === "error" ? TriangleAlert : Sparkles;
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-xs",
        note.tone === "error" ? "text-destructive" : "text-muted-foreground"
      )}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          note.tone === "busy" && "animate-spin",
          note.tone === "done" && "text-primary"
        )}
      />
      <span>{note.text}</span>
    </p>
  );
}

export function VideoUpload({
  deliverableId,
  currentUrl,
  isPoster = false,
  onUploaded,
  onCaption,
  onCaptioningChange,
  onCaptionProgress,
}: {
  deliverableId: number;
  currentUrl?: string | null;
  /**
   * A poster task takes an image, not a video.
   *
   * The button said "Upload Video" on a poster, and worse, the file picker
   * was filtered to video/* and the check below refused anything that was not
   * one — so a designer's PNG could not be attached at all, and the reason
   * given was that it did not look like a video.
   */
  isPoster?: boolean;
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
  /**
   * Take over showing the caption's progress.
   *
   * Pass this and the component says nothing about the caption itself — the
   * caller is promising to. Omit it and the note is rendered here, which is
   * what the task page needs since it has nowhere else to put it.
   *
   * The point is that exactly one line on screen narrates one activity. With
   * both a button label and a note describing the same AI, the same sentence
   * appeared twice at once and read as two separate things going wrong.
   */
  onCaptionProgress?: (note: CaptionNote) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [filename, setFilename] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(currentUrl ?? null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ownNote, setOwnNote] = useState<CaptionNote>(null);

  /** To the caller if it asked for it, otherwise to our own line. Never both. */
  const say = (note: CaptionNote) => {
    if (onCaptionProgress) onCaptionProgress(note);
    else setOwnNote(note);
  };

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
    say({ text: "The AI is watching the video…", tone: "busy" });

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
          say(null);
          return;
        }

        if (!res.ok) {
          // Worth showing: "the file is too big" is something to act on, and
          // silence here reads as the feature simply not working.
          say(res.error ? { text: res.error, tone: "error" } : null);
          return;
        }

        if (res.state === "done") {
          if (res.caption && res.applied) onCaption?.(res.caption);
          say({ text: res.message ?? "Caption written from the video.", tone: "done" });
          return;
        }

        say({ text: res.message ?? "Writing the caption…", tone: "busy" });
        if (!res.more) return;
        await new Promise((r) => setTimeout(r, 2500));
      }

      say({ text: "Still working — open the task to see the caption.", tone: "done" });
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
    say(null);

    const wanted = isPoster ? "image/" : "video/";
    if (!file.type.startsWith(wanted)) {
      setPhase("error");
      setError(`That doesn't look like ${isPoster ? "an image" : "a video"} file.`);
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

    /*
     * Cloudflare's own 5xx is worth another go before it is anybody's problem.
     *
     * R2 answers a perfectly good PUT with `500 InternalError` from time to
     * time, and documents it as retriable. Reported straight through, that was
     * a finished video refused for a reason nobody could act on — and the
     * message told the editor their credentials were wrong, which sent them to
     * Settings to fix keys that had just worked.
     *
     * Three attempts, one and three seconds apart. Only 5xx repeats: 403 is a
     * refusal that will be refused again, and a status of 0 never reached
     * Cloudflare at all. The whole file goes up again each time, which is the
     * price of a single-part PUT — and is exactly what the editor would do by
     * hand, without the waiting.
     */
    const attempt = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url, true);
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

    const BACKOFF_MS = [1000, 3000];
    let result = await attempt(signed.uploadUrl);
    for (let i = 0; i < BACKOFF_MS.length && result.status >= 500; i++) {
      setError(
        `Cloudflare had a problem at its end — trying again (${i + 2} of ${BACKOFF_MS.length + 1})…`
      );
      await new Promise((r) => setTimeout(r, BACKOFF_MS[i]));
      setProgress(0);
      result = await attempt(signed.uploadUrl);
    }
    setError(null);

    if (result.status < 200 || result.status >= 300) {
      setPhase("error");
      /*
       * Three different faults that look identical to whoever is uploading, so
       * they must not share a message. A status of 0 means the request never
       * reached R2 — CORS. A 5xx means it did, and R2 broke: nothing here is
       * misconfigured and there is nothing in Settings to go and fix. Only a
       * 4xx is really about credentials or permissions.
       */
      const code = result.body.match(/<Code>([^<]+)<\/Code>/)?.[1];
      if (result.status === 0) {
        setError(
          `The browser blocked the upload before it reached Cloudflare. Add ${window.location.origin} ` +
            `to the bucket's CORS policy, allowing PUT and the content-type header.`
        );
      } else if (result.status >= 500) {
        setError(
          `Cloudflare is failing at its end — it returned ${result.status}` +
            `${code ? ` (${code})` : ""} three times. Nothing here is set up wrong, ` +
            `so give it a few minutes and press Replace again.`
        );
      } else {
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
    /*
     * Attach first, THEN read the frames — the order is load-bearing.
     *
     * Attaching is what points the task at the new file, and queueing the
     * analysis is what throws away the analysis of the video this one just
     * replaced. Frames saved before that happens are saved onto a row that is
     * about to be deleted, so a Replace produced a caption written with its
     * eyes shut — and nothing anywhere said so.
     *
     * The flag keeps it from *running* yet: the model reads frames, and a call
     * made before they arrive spends money on the sound track alone.
     */
    const saved = await attachUploadedVideo(deliverableId, signed.key, signed.publicUrl, !isPoster);
    if (!saved.ok) {
      setPhase("error");
      setError(saved.error || "Uploaded, but couldn't attach it to the task.");
      return;
    }

    /*
     * Now decode it, while the file is still a local File in this tab.
     *
     * This is the only moment the frames are free. The model cannot take a
     * video — it reads images and hears audio — so something has to turn a
     * reel into pictures, and the browser is holding the bytes, has a hardware
     * decoder, and is doing it on the editor's machine rather than ours.
     *
     * Posters are already an image and skip it.
     *
     * Nothing in here can fail the upload. The video is safely in R2 by this
     * point; a browser that cannot decode this particular codec should cost
     * the client a caption written from the sound track, never the video.
     */
    if (!isPoster) {
      try {
        const frames = await extractFrames(file, MAX_FRAMES, FRAME_EDGE, (done, total) =>
          setError(`Reading the video — frame ${done} of ${total}…`)
        );
        setError(null);
        if (frames.length) await saveFrames(deliverableId, frames);

        /*
         * And the sound track, separately from the video.
         *
         * Transcription refuses a file over 25 MB and a finished reel goes
         * past that on picture alone, so the audio of a good video was simply
         * never heard — the caption came out written from the frames, and
         * read like any other. A mono 16 kHz WAV of the same minute is under
         * two megabytes.
         */
        setError("Reading the sound…");
        await saveAudio(deliverableId, file);
        setError(null);
      } catch {
        setError(null);
      }
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
          {url ? "Upload new" : isPoster ? "Upload Poster" : "Upload Video"}
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
          accept={isPoster ? "image/*" : "video/*"}
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

      {/* Only when nobody upstream took it on — see onCaptionProgress. The
          caption runs after the upload has already succeeded, so this is
          progress on a bonus, never framed as part of the upload failing. */}
      {ownNote ? <CaptionLine note={ownNote} /> : null}

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

      {/*
        * Still uploading means this is a retry, not a verdict.
        *
        * The same line carries both, because both answer "why did the bar go
        * back to nought" — but a red warning about something that is still
        * working reads as a failure, and the editor stops waiting for an
        * upload that was about to succeed.
        */}
      {error ? (
        <p
          className={cn(
            "flex items-start gap-1.5 text-xs",
            phase === "uploading" ? "text-muted-foreground" : "text-destructive"
          )}
        >
          {phase === "uploading" ? (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
