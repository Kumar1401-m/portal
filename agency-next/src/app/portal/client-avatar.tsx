"use client";

import { useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { getAvatarUploadUrl, saveAvatar } from "./avatar-actions";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

/**
 * The client's own profile picture, changeable in place: click it, pick an
 * image, and it uploads straight to R2 with the same signed-URL flow the
 * finished videos use.
 */
export function ClientAvatar({
  companyName,
  initialUrl,
  editable = true,
  size = 36,
}: {
  companyName: string;
  initialUrl: string | null;
  editable?: boolean;
  size?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Pick an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Keep it under 5 MB.");
      return;
    }

    setBusy(true);
    // Show it immediately rather than waiting on the round trip.
    const preview = URL.createObjectURL(file);
    setUrl(preview);

    try {
      const signed = await getAvatarUploadUrl(file.name);
      if (!signed.ok) {
        setError(signed.error);
        setUrl(initialUrl);
        return;
      }

      const put = await fetch(signed.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) {
        setError("Upload failed — please try again.");
        setUrl(initialUrl);
        return;
      }

      const saved = await saveAvatar(signed.key);
      if (!saved.ok) {
        setError(saved.error || "Couldn't save the picture.");
        setUrl(initialUrl);
        return;
      }
      if (saved.url) setUrl(saved.url);
    } finally {
      setBusy(false);
      URL.revokeObjectURL(preview);
    }
  }

  const box = { width: size, height: size };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => editable && inputRef.current?.click()}
        disabled={!editable || busy}
        title={editable ? "Change your profile picture" : companyName}
        aria-label={editable ? "Change your profile picture" : companyName}
        className="group relative block shrink-0 overflow-hidden rounded-full ring-1 ring-border disabled:cursor-default"
        style={box}
      >
        {url ? (
          // Signed R2 links are short-lived, so next/image optimisation would
          // cache a URL that stops working — a plain img is the right call.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={companyName} className="h-full w-full object-cover" style={box} />
        ) : (
          <span
            className="grid h-full w-full place-items-center bg-gradient-to-br from-orange-500 to-amber-500 font-semibold text-white"
            style={{ fontSize: Math.max(11, size * 0.36) }}
          >
            {initials(companyName)}
          </span>
        )}

        {editable ? (
          <span className="absolute inset-0 grid place-items-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin text-white" />
            ) : (
              <Camera className="h-4 w-4 text-white" />
            )}
          </span>
        ) : null}

        {busy && !editable ? (
          <span className="absolute inset-0 grid place-items-center bg-black/50">
            <Loader2 className="h-4 w-4 animate-spin text-white" />
          </span>
        ) : null}
      </button>

      {editable ? (
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />
      ) : null}

      {error ? (
        <p className="absolute left-1/2 top-full z-20 mt-1 w-44 -translate-x-1/2 rounded-md border border-border bg-popover p-2 text-xs text-destructive shadow-lg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
