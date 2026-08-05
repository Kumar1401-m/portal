"use client";

import { useRef, useState } from "react";
import { UploadCloud, Paperclip, Repeat, Check, Copy, Loader2, TriangleAlert } from "lucide-react";
import { getVideoUploadUrl, attachUploadedVideo } from "./upload-actions";
import { buttonClasses } from "@/components/ui/button";

type Phase = "idle" | "signing" | "uploading" | "saving" | "done" | "error";

/**
 * Uploads the finished video straight from the browser to Cloudflare R2 using a
 * short-lived signed URL, then records it against the task. The bytes bypass
 * our server entirely, so there's no request-size ceiling.
 */
export function VideoUpload({
  deliverableId,
  currentUrl,
  onUploaded,
}: {
  deliverableId: number;
  currentUrl?: string | null;
  onUploaded?: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [filename, setFilename] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(currentUrl ?? null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const busy = phase === "signing" || phase === "uploading" || phase === "saving";

  async function handleFile(file: File) {
    setError(null);
    setProgress(0);
    setFilename(file.name);

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
