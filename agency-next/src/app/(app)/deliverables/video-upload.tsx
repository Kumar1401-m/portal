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
    const ok = await new Promise<boolean>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", signed.uploadUrl, true);
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
      xhr.onerror = () => resolve(false);
      xhr.send(file);
    });

    if (!ok) {
      setPhase("error");
      setError("Upload failed. Check the bucket's CORS rules allow PUT from this site.");
      return;
    }

    setPhase("saving");
    const saved = await attachUploadedVideo(deliverableId, signed.key, signed.publicUrl);
    if (!saved.ok) {
      setPhase("error");
      setError(saved.error || "Uploaded, but couldn't attach it to the task.");
      return;
    }

    setUrl(signed.publicUrl);
    setPhase("done");
    onUploaded?.(signed.publicUrl);
  }

  function copy() {
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
        <div className="flex items-center gap-1.5">
          <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs">
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <span className="truncate font-mono">{url}</span>
          </span>
          <button
            type="button"
            onClick={copy}
            title="Copy link"
            className={buttonClasses({ variant: "ghost", size: "icon" })}
          >
            {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
          </button>
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
