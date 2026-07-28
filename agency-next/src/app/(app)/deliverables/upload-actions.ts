"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute, hasColumn } from "@/lib/db";
import { requireUser, STAFF_ROLES, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import {
  presignUpload,
  buildVideoKey,
  deleteObject,
  isStorageConfigured,
  resolveVideoUrl,
} from "@/lib/storage";

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

export type AttachResult = { ok: boolean; error?: string; message?: string; previewUrl?: string };

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
  const statusSql = advance ? ", status = 'caption_ready'" : "";

  // A private bucket has no stable public URL, so `publicUrl` is empty. Store
  // the key regardless — that's what a signed link is derived from — and only
  // touch the shareable link fields when there genuinely is one, rather than
  // blanking out whatever link was already there.
  const hasCloudCols = await hasColumn("deliverables", "cloud_video_url");

  if (hasCloudCols && publicUrl) {
    await execute(
      `UPDATE deliverables
          SET cloud_video_url = ?, cloud_video_key = ?, edited_link = ?${statusSql}
        WHERE id = ?`,
      [publicUrl, key, publicUrl, deliverableId]
    );
  } else if (hasCloudCols) {
    await execute(
      `UPDATE deliverables SET cloud_video_url = NULL, cloud_video_key = ?${statusSql} WHERE id = ?`,
      [key, deliverableId]
    );
  } else if (publicUrl) {
    await execute(`UPDATE deliverables SET edited_link = ?${statusSql} WHERE id = ?`, [
      publicUrl,
      deliverableId,
    ]);
  } else {
    return {
      ok: false,
      error:
        "The video uploaded, but this database is missing the cloud video columns — run the migration, then upload again.",
    };
  }

  revalidatePath("/deliverables");
  revalidatePath(`/deliverables/${deliverableId}`);
  revalidatePath("/today");
  revalidatePath("/approvals");

  return {
    ok: true,
    previewUrl: (await resolveVideoUrl(key, publicUrl || null)) ?? undefined,
    message: advance
      ? "Video uploaded — the task is ready to send to the client."
      : "Video uploaded.",
  };
}

export type DeleteTaskResult = { ok: boolean; error?: string };

/**
 * Permanently delete one task. Super admin only — the same restriction that
 * covered the old bulk "clear all tasks". Feedback, comments and approvals
 * cascade with the row; the uploaded video is removed from the bucket too, so
 * deleting a task doesn't quietly leave storage behind.
 */
export async function deleteDeliverable(deliverableId: number): Promise<DeleteTaskResult> {
  await requireUser(SUPER_ADMIN_ROLES);
  if (!deliverableId) return { ok: false, error: "Missing task." };

  const hasCloudCols = await hasColumn("deliverables", "cloud_video_key");
  const d = await queryOne<{ id: number; title: string; cloud_video_key: string | null }>(
    `SELECT id, title${hasCloudCols ? ", cloud_video_key" : ", NULL AS cloud_video_key"}
       FROM deliverables WHERE id = ?`,
    [deliverableId]
  );
  if (!d) return { ok: false, error: "Task not found." };

  if (d.cloud_video_key) await deleteObject(d.cloud_video_key).catch(() => false);
  await execute("DELETE FROM deliverables WHERE id = ?", [deliverableId]);

  for (const p of ["/deliverables", "/today", "/approvals", "/dashboard", "/reports", "/poster"]) {
    revalidatePath(p);
  }
  return { ok: true };
}
