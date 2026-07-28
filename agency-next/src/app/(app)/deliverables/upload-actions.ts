"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute } from "@/lib/db";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { presignUpload, buildVideoKey, deleteObject, isStorageConfigured } from "@/lib/storage";

export type PresignResult =
  | { ok: true; uploadUrl: string; publicUrl: string; key: string }
  | { ok: false; error: string };

/**
 * Hand the browser a short-lived URL to upload straight to R2. Vercel caps
 * request bodies at ~4.5 MB, so the file can never come through the server.
 */
export async function getVideoUploadUrl(
  deliverableId: number,
  filename: string
): Promise<PresignResult> {
  const user = await requireUser(STAFF_ROLES);

  if (!(await isStorageConfigured())) {
    return { ok: false, error: "Video storage isn't set up yet — add your Cloudflare R2 keys in Settings." };
  }

  const d = await queryOne<{ id: number; client_id: number }>(
    "SELECT id, client_id FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!d) return { ok: false, error: "Task not found." };
  if (!(await canAccessClient(user, d.client_id))) return { ok: false, error: "Not authorized." };

  const key = buildVideoKey(d.client_id, d.id, filename);
  const signed = await presignUpload(key);
  if (!signed) return { ok: false, error: "Couldn't prepare the upload. Check the R2 settings." };

  return { ok: true, uploadUrl: signed.uploadUrl, publicUrl: signed.publicUrl, key };
}

export type AttachResult = { ok: boolean; error?: string; message?: string };

/**
 * Record the uploaded video against the task. Deliberately does NOT send it to
 * the client — that stays a manual step, so the approval gate is preserved.
 */
export async function attachUploadedVideo(
  deliverableId: number,
  key: string,
  publicUrl: string
): Promise<AttachResult> {
  const user = await requireUser(STAFF_ROLES);

  const d = await queryOne<{
    id: number;
    client_id: number;
    status: string;
    cloud_video_key: string | null;
  }>("SELECT id, client_id, status, cloud_video_key FROM deliverables WHERE id = ?", [
    deliverableId,
  ]);
  if (!d) return { ok: false, error: "Task not found." };
  if (!(await canAccessClient(user, d.client_id))) return { ok: false, error: "Not authorized." };

  // Replacing a video: bin the old object so the bucket doesn't fill up.
  if (d.cloud_video_key && d.cloud_video_key !== key) {
    await deleteObject(d.cloud_video_key).catch(() => false);
  }

  // Move it along to "ready for review" only from the editing stages, so an
  // already-approved or posted task isn't dragged backwards.
  const advance = ["pending", "raw_uploaded", "editing", "changes_requested"].includes(d.status);

  await execute(
    `UPDATE deliverables
        SET cloud_video_url = ?, cloud_video_key = ?, edited_link = ?
            ${advance ? ", status = 'caption_ready'" : ""}
      WHERE id = ?`,
    [publicUrl, key, publicUrl, deliverableId]
  );

  revalidatePath("/deliverables");
  revalidatePath(`/deliverables/${deliverableId}`);
  revalidatePath("/today");
  revalidatePath("/approvals");

  return {
    ok: true,
    message: advance
      ? "Video uploaded — the task is ready to send to the client."
      : "Video uploaded.",
  };
}
