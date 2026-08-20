"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute, hasColumn } from "@/lib/db";
import { requireUser, SUPER_ADMIN_ROLES, type Role } from "@/lib/auth";

/** Uploading the finished video is editing work — deliberately excludes crm. */
const VIDEO_UPLOAD_ROLES: Role[] = ["super_admin", "admin", "poster_designer", "video_editor"];
import { canAccessClient } from "@/lib/crm";
import {
  presignUpload,
  buildVideoKey,
  deleteObject,
  isStorageConfigured,
} from "@/lib/storage";
import { buildVideoPermalink } from "@/lib/video-link";
import { suggestTitle } from "@/lib/content";
import { isGeneratedTitle } from "@/lib/title";
import { startAnalysisAfterUpload } from "../editor/actions";

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
  const user = await requireUser(VIDEO_UPLOAD_ROLES);

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

export type AttachResult = {
  ok: boolean;
  error?: string;
  message?: string;
  /** Permanent link to the video — safe to store and to share. */
  link?: string;
};

/**
 * Record the uploaded video against the task. Deliberately does NOT send it to
 * the client — that stays a manual step, so the approval gate is preserved.
 */
export async function attachUploadedVideo(
  deliverableId: number,
  key: string,
  publicUrl: string
): Promise<AttachResult> {
  const user = await requireUser(VIDEO_UPLOAD_ROLES);

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
  // the key regardless — that's what a signed link is derived from — and give
  // the deliverable link the portal's own permanent address for the video, so
  // it no longer has to be copied out of the uploader by hand. The raw signed
  // URL must never be written here: it expires within hours.
  const hasCloudCols = await hasColumn("deliverables", "cloud_video_url");
  const permalink = buildVideoPermalink(deliverableId, key);

  if (hasCloudCols && publicUrl) {
    await execute(
      `UPDATE deliverables
          SET cloud_video_url = ?, cloud_video_key = ?, edited_link = ?${statusSql}
        WHERE id = ?`,
      [publicUrl, key, publicUrl, deliverableId]
    );
  } else if (hasCloudCols) {
    await execute(
      `UPDATE deliverables
          SET cloud_video_url = NULL, cloud_video_key = ?, edited_link = ?${statusSql}
        WHERE id = ?`,
      [key, permalink, deliverableId]
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

  /*
   * Who did the work, recorded apart from who the task belongs to.
   *
   * The efficiency report used to count on `assigned_to` alone, so somebody
   * could upload two videos in a day and read as 0% — the tasks were assigned
   * to nobody, and work assigned to nobody counts for nobody. Assignment is a
   * plan, though, and this is a fact: an admin uploading on an editor's behalf
   * did that upload, and the editor still owns the task. Conflating the two
   * would mean crediting the wrong person or silently moving work off
   * somebody's plate, so they are two columns.
   *
   * `assigned_to` is still claimed, but only when it is empty — an unassigned
   * task somebody has now worked on is theirs, and nobody else's name is ever
   * replaced.
   */
  if (await hasColumn("deliverables", "uploaded_by")) {
    await execute("UPDATE deliverables SET uploaded_by = ? WHERE id = ?", [user.id, deliverableId]);
  }
  await execute("UPDATE deliverables SET assigned_to = ? WHERE id = ? AND assigned_to IS NULL", [
    user.id,
    deliverableId,
  ]);

  /*
   * Start the AI on it straight away.
   *
   * Awaited rather than fired and forgotten: a serverless function is frozen
   * the moment its response is sent, so a dangling promise here would simply
   * never run. This does one step — usually enough to get the file to Gemini —
   * and whoever opens the task next finishes it off.
   *
   * Best-effort throughout. A failed analysis must never make a successful
   * upload report failure.
   */
  await startAnalysisAfterUpload(deliverableId);

  /*
   * And give it a name, if it is still called "Video 6".
   *
   * Same rule the content desk follows: only over a placeholder, never over a
   * title somebody typed. Written from whatever the task already says about
   * itself — the brief first, the caption second — because at upload time the
   * analysis has not finished and the file name is "VID_20260817.mp4".
   *
   * Best-effort. The video is in the bucket either way, and a failed rename
   * must not report a successful upload as failed.
   */
  try {
    const t = await queryOne<{ title: string; description: string | null; caption: string | null; company_name: string }>(
      `SELECT d.title, d.description, d.caption, c.company_name
         FROM deliverables d JOIN clients c ON c.id = d.client_id
        WHERE d.id = ?`,
      [deliverableId]
    );
    const source = (t?.description ?? "").trim() || (t?.caption ?? "").trim();
    if (t && source && isGeneratedTitle(t.title)) {
      const named = await suggestTitle(source, t.company_name);
      if (named) await execute("UPDATE deliverables SET title = ? WHERE id = ?", [named, deliverableId]);
    }
  } catch (err) {
    console.warn("[upload] could not name the video:", err instanceof Error ? err.message : err);
  }

  revalidatePath("/deliverables");
  revalidatePath(`/deliverables/${deliverableId}`);
  revalidatePath("/today");
  revalidatePath("/approvals");
  revalidatePath("/editor");

  return {
    ok: true,
    link: publicUrl || permalink,
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
