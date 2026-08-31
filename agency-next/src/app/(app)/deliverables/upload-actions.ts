"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute, hasColumn } from "@/lib/db";
import { requireUser, SUPER_ADMIN_ROLES, type Role } from "@/lib/auth";

/** Uploading the finished video is editing work — deliberately excludes crm. */
const VIDEO_UPLOAD_ROLES: Role[] = ["super_admin", "admin", "poster_designer", "video_editor"];
import { canAccessClient } from "@/lib/crm";
import { MAX_FRAMES } from "@/lib/frames";
import { audioKey } from "@/lib/audio";
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

/**
 * A slot to put this video's extracted speech in.
 *
 * The browser decodes the audio track to a small mono WAV and puts it here
 * itself, for the same reason it uploads the video itself: a Server Action
 * body is a megabyte and this is several. One key per task, overwritten — a
 * deliverable has one video, so it has one sound track.
 */
export async function getAudioUploadUrl(deliverableId: number): Promise<PresignResult> {
  const user = await requireUser(VIDEO_UPLOAD_ROLES);

  const d = await queryOne<{ id: number; client_id: number }>(
    "SELECT id, client_id FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!d) return { ok: false, error: "Task not found." };
  if (!(await canAccessClient(user, d.client_id))) return { ok: false, error: "Not authorized." };

  const key = audioKey(d.id);
  const signed = await presignUpload(key, 600);
  if (!signed) return { ok: false, error: "Couldn't prepare the audio upload." };

  return { ok: true, uploadUrl: signed.uploadUrl, publicUrl: signed.publicUrl, key };
}

/**
 * Store the frames the browser decoded, and record where they went.
 *
 * They arrive as data URIs in the request body rather than being uploaded to
 * R2 by the browser: the video is the thing that has to bypass the server, and
 * a handful of thumbnails is not worth twelve presigns and twelve PUTs.
 *
 * But not all of them at once. A Server Action request body is capped at 1 MB
 * — Next's own limit, an order of magnitude below the ~4.5 MB platform cap
 * this was written against — and twelve frames of base64 is roughly twice
 * that. Over it the action never runs at all: the framework rejects the
 * request with a 413 that reaches the browser as an opaque "an error occurred
 * in the Server Components render", naming neither the size nor this function.
 *
 * So the caller sends them in batches (see `saveFrames`) and each call says
 * where its batch begins. Batching rather than raising the limit because the
 * cap is a property of the host, and a run of unusually detailed frames should
 * not be the thing that decides whether a caption gets written.
 *
 * They are put in R2 rather than kept in the database. A base64 image in a
 * MySQL row is a quarter of a megabyte of text on a table that is read whole
 * by every analysis, and R2 is already here, already cleaned up on replace,
 * and already what this portal stores blobs in.
 *
 * Best-effort by design. Every failure here means the analysis reads the
 * transcript alone — a worse caption, never a failed upload.
 */
export async function saveVideoFrames(
  deliverableId: number,
  frames: string[],
  /** Where this batch sits in the whole strip, so the keys stay in order. */
  startIndex = 0
): Promise<{ ok: boolean; stored: number; error?: string }> {
  const user = await requireUser(VIDEO_UPLOAD_ROLES);

  const d = await queryOne<{ id: number; client_id: number }>(
    "SELECT id, client_id FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!d) return { ok: false, stored: 0, error: "Task not found." };
  if (!(await canAccessClient(user, d.client_id))) {
    return { ok: false, stored: 0, error: "Not authorized." };
  }
  if (!(await hasColumn("video_analysis", "frames_json"))) {
    return { ok: false, stored: 0, error: "The frames column has not been applied yet." };
  }

  const keys: string[] = [];
  for (const [i, dataUrl] of frames.entries()) {
    // Counted across the whole strip, not within this batch, or a second
    // batch would overwrite the first batch's files.
    const at = Math.max(0, Math.trunc(startIndex)) + i;
    if (at >= MAX_FRAMES) break;

    // Only what this actually produces. A data URI is a URL the server is
    // about to fetch and store under its own name, so accepting an arbitrary
    // one would let a caller have us store anything at all.
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) continue;
    const bytes = Buffer.from(match[1], "base64");
    if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) continue;

    const key = `frames/${Math.trunc(deliverableId)}/${at}.jpg`;
    const signed = await presignUpload(key, 600);
    if (!signed) break;
    const put = await fetch(signed.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: new Uint8Array(bytes),
    }).catch(() => null);
    if (!put?.ok) continue;
    keys.push(key);
  }

  if (!keys.length) return { ok: false, stored: 0, error: "No frames could be stored." };

  /*
   * The first batch replaces whatever was there; every later one adds to it.
   * Replacing on the first is what clears a previous video's frames, and
   * adding on the rest is what stops the last batch being the only one kept.
   * Merged by key, so a retried batch rewrites its own entries rather than
   * doubling them.
   */
  const before =
    startIndex === 0
      ? []
      : frameKeys(
          (
            await queryOne<{ frames_json: unknown }>(
              "SELECT frames_json FROM video_analysis WHERE deliverable_id = ?",
              [deliverableId]
            )
          )?.frames_json
        );
  const all = [...new Set([...before, ...keys])].sort((a, b) => frameIndex(a) - frameIndex(b));

  /*
   * Written onto the analysis row, creating it if this is the first thing to
   * touch it. The upload starts the analysis moments later, so the row may
   * not exist yet — and the frames arriving before the job is queued is the
   * normal order of events, not an edge case.
   */
  await execute(
    `INSERT INTO video_analysis (deliverable_id, state, frames_json)
     VALUES (?, 'queued', ?)
     ON DUPLICATE KEY UPDATE frames_json = VALUES(frames_json)`,
    [deliverableId, JSON.stringify(all)]
  );

  return { ok: true, stored: keys.length };
}

/** The stored keys, whatever shape MySQL handed the JSON column back in. */
function frameKeys(raw: unknown): string[] {
  let val = raw;
  if (typeof val === "string") {
    try {
      val = JSON.parse(val);
    } catch {
      return [];
    }
  }
  return Array.isArray(val) ? val.filter((k): k is string => typeof k === "string") : [];
}

/** `frames/272/7.jpg` -> 7, so a merged strip sorts back into playing order. */
function frameIndex(key: string): number {
  const n = Number(key.split("/").pop()?.split(".")[0]);
  return Number.isFinite(n) ? n : 0;
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
  publicUrl: string,
  /** True when the browser is about to send frames — see startAnalysisAfterUpload. */
  framesFirst = false
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

  /*
   * And bin the speech that came out of it, always.
   *
   * The audio key is per task, so a new upload normally overwrites it — but
   * only if the browser manages to extract any. A video whose audio cannot be
   * decoded would otherwise inherit the previous cut's sound track and be
   * captioned, confidently, from words that are not in it.
   */
  await deleteObject(audioKey(deliverableId)).catch(() => false);


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
  await startAnalysisAfterUpload(deliverableId, !framesFirst);

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
