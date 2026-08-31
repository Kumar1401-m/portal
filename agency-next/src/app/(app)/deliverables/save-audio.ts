"use client";

import { getAudioUploadUrl } from "./upload-actions";
import { extractAudio } from "@/lib/audio";

/**
 * Decode a video's speech and put it where the analysis will find it.
 *
 * Straight to R2 from here, like the video itself: a mono WAV of a two-minute
 * reel is a few megabytes, and a Server Action body is one.
 *
 * Best-effort throughout, and silent when it fails. Every failure here means
 * the analysis transcribes the video file instead — which is exactly what it
 * did before this existed, and works for anything under 25 MB. Nothing about
 * the upload depends on it.
 */
export async function saveAudio(deliverableId: number, file: Blob): Promise<boolean> {
  const wav = await extractAudio(file);
  if (!wav) return false;

  const signed = await getAudioUploadUrl(deliverableId);
  if (!signed.ok) return false;

  const put = await fetch(signed.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  }).catch(() => null);

  return Boolean(put?.ok);
}
