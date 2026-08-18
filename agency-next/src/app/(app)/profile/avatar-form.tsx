"use client";

import { useRef, useState } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { getStaffAvatarUploadUrl, saveStaffAvatar, removeStaffAvatar } from "./actions";
import { Button } from "@/components/ui/button";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

/**
 * Pick a picture, see it immediately, and have it uploaded behind you.
 *
 * The preview is set from the local file before the round trip starts, because
 * a 3MB photo over office wifi is long enough for somebody to press the button
 * again. On any failure it snaps back to what was there before, so the screen
 * never shows a picture the server does not have.
 */
export function AvatarForm({ name, initialUrl }: { name: string; initialUrl: string | null }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    setSaved(false);
    if (!file.type.startsWith("image/")) return setError("Pick an image file.");
    if (file.size > 5 * 1024 * 1024) return setError("Keep it under 5 MB.");

    setBusy(true);
    const preview = URL.createObjectURL(file);
    setUrl(preview);

    try {
      const signed = await getStaffAvatarUploadUrl(file.name);
      if (!signed.ok) {
        setUrl(initialUrl);
        return setError(signed.error);
      }

      const put = await fetch(signed.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) {
        setUrl(initialUrl);
        return setError("Upload failed — please try again.");
      }

      const res = await saveStaffAvatar(signed.key);
      if (!res.ok) {
        setUrl(initialUrl);
        return setError(res.error ?? "Couldn't save it.");
      }
      if (res.url) setUrl(res.url);
      setSaved(true);
    } catch {
      setUrl(initialUrl);
      setError("Something went wrong — please try again.");
    } finally {
      setBusy(false);
      URL.revokeObjectURL(preview);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-5">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="group relative grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-orange-500 to-amber-500 text-xl font-semibold text-white"
        aria-label="Change your profile picture"
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          initials(name)
        )}
        {/* The affordance only appears on hover, so the picture is the picture
            and not a button with a face in it. */}
        <span className="absolute inset-0 grid place-items-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin text-white" />
          ) : (
            <Camera className="h-5 w-5 text-white" />
          )}
        </span>
      </button>

      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
            {url ? "Change picture" : "Add a picture"}
          </Button>
          {url ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await removeStaffAvatar();
                setUrl(null);
                setSaved(false);
                setBusy(false);
              }}
            >
              <Trash2 className="h-4 w-4" /> Remove
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">JPG or PNG, up to 5 MB. Square looks best.</p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {saved && !error ? <p className="text-xs text-success">Saved.</p> : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
