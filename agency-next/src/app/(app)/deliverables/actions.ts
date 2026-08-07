"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { queryOne, execute, hasColumn } from "@/lib/db";
import { requireUser, ADMIN_ROLES, ADMIN_OR_CRM_ROLES, type SessionUser } from "@/lib/auth";
import {
  generateCaption,
  type ComposedCaption,
  type CaptionSource,
  type WatchedVideo,
} from "@/lib/ai";
import { getAnalysis } from "@/lib/video-ai";
import { getDeliverable } from "@/lib/deliverables";
import { canAccessClient } from "@/lib/crm";
import { notifyClientById, notifyUser } from "@/lib/notify";
import { sendApprovalRequestEmail } from "@/lib/email";
import { PLATFORMS, PRIORITIES, STATUS_LIST, EDITOR_STATUSES } from "@/lib/constants";
import { isServiceKey, videoTypeForService, type ServiceKey } from "@/lib/services";
import { monthKey, autoTaskTitle } from "@/lib/utils";
import { localTimeToUtc } from "@/lib/zapier";
import { retryPublish, publishHandoff } from "@/lib/instagram";
import { deliverForApproval, describeDelivery } from "@/lib/whatsapp-send";

const REASON_REQUIRED = ["rejected", "changes_requested", "cancelled"];

/* ------------------------- Create deliverable ------------------------- */

export async function createDeliverable(formData: FormData): Promise<void> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  const clientId = Number(formData.get("client_id"));
  // The title is the one brief field you can leave alone: most tasks are "the
  // next reel for this client" and typing a name for each of them is work that
  // tells nobody anything. A blank one gets named further down, once the
  // category and due date are known.
  const typedTitle = String(formData.get("title") || "").trim();
  if (!clientId) {
    redirect("/deliverables/new?error=1");
  }

  const client = await queryOne<{ id: number; designer_id: number | null }>(
    "SELECT id, designer_id FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) redirect("/deliverables/new?error=notfound");
  // The page already scopes the dropdown, but the action is the real gate:
  // a crm must not create work against a client they cannot access.
  if (!(await canAccessClient(user, clientId))) redirect("/deliverables/new?error=notfound");

  // Task organisation: every task belongs to a service + category.
  const serviceRaw = String(formData.get("service") || "");
  const service: ServiceKey = isServiceKey(serviceRaw) ? serviceRaw : "video_editing";
  const category = String(formData.get("content_category") || "").trim();
  if (!category) redirect("/deliverables/new?error=category");
  // `video_type` stays in step with the service so the Posters module, the
  // reports scorecard and the client portal keep reading what they expect.
  const videoType = videoTypeForService(service, category);

  const platformRaw = String(formData.get("platform") || "other");
  const platform = (PLATFORMS as readonly string[]).includes(platformRaw) ? platformRaw : "other";
  const priorityRaw = String(formData.get("priority") || "medium");
  const priority = (PRIORITIES as readonly string[]).includes(priorityRaw) ? priorityRaw : "medium";
  const dueDate = String(formData.get("due_date") || "").trim() || null;
  const description = String(formData.get("description") || "").trim() || null;
  const contentHook = String(formData.get("content_hook") || "").trim() || null;
  const language = String(formData.get("language") || "").trim() || null;
  const targetAudience = String(formData.get("target_audience") || "").trim() || null;
  const promotionType = String(formData.get("promotion_type") || "").trim() || null;
  const customInstructions = String(formData.get("custom_instructions") || "").trim() || null;
  const assignedToRaw = Number(formData.get("assigned_to"));
  // The client's default designer only stands in for poster work — that's what
  // designer_id means. Applying it to every service silently assigned video
  // tasks to a poster designer nobody had picked; leaving those unassigned is
  // both honest and visible.
  const assignedTo =
    assignedToRaw > 0
      ? assignedToRaw
      : service === "poster_designing"
        ? (client.designer_id ?? null)
        : null;

  const mk = dueDate ? dueDate.slice(0, 7) : monthKey();

  const title = typedTitle || autoTaskTitle(category, dueDate);

  // Guard against the same task landing twice. A double-click on the submit
  // button (or a request the browser retries) fires this action twice, and
  // both runs used to insert. The disabled button covers the common case;
  // this covers what it can't — a click before hydration, or a retry.
  //
  // Only for a title someone typed. Two tasks named alike within twenty
  // seconds is good evidence of a double submit when a person chose that name
  // twice, and no evidence at all when the name was generated: adding three
  // reels for one client in the same category produces three identical
  // generated names, and refusing the second and third would throw away work
  // that was asked for, silently. A duplicate can be seen and deleted; a task
  // that never appeared cannot.
  if (typedTitle) {
    const dupe = await queryOne<{ id: number }>(
      `SELECT id FROM deliverables
        WHERE client_id = ? AND title = ? AND created_by = ?
          AND created_at > (NOW() - INTERVAL 20 SECOND)
        ORDER BY id DESC LIMIT 1`,
      [clientId, title, user.id]
    );
    if (dupe) redirect("/deliverables");
  }

  await execute(
    `INSERT INTO deliverables
      (client_id, title, description, platform, content_hook, service, content_category,
       video_type, language, target_audience, promotion_type, custom_instructions,
       due_date, priority, status, month_key, created_by, assigned_to)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
    [
      clientId,
      title,
      description,
      platform,
      contentHook,
      service,
      category,
      videoType,
      language,
      targetAudience,
      promotionType,
      customInstructions,
      dueDate,
      priority,
      mk,
      user.id,
      assignedTo,
    ]
  );

  revalidatePath("/deliverables");
  // Back to the list rather than the task page: from here that navigation
  // would open the task popup over the form you just submitted.
  redirect("/deliverables");
}

/* --------------------------- Generate caption --------------------------- */

export type CaptionState = {
  ok: boolean;
  error?: string;
  provider?: ComposedCaption["provider"];
  caption?: string;
  hashtags?: string;
  alternates?: string[];
  isPoster?: boolean;
  /** Whether the copy came from the footage or only from the typed brief. */
  fromVideo?: boolean;
};

/**
 * The finished analysis for a video, in the shape the caption studio wants.
 *
 * Only a completed one counts. A job still uploading has a half-filled row,
 * and a caption written from half an observation is worse than one written
 * from the brief, because it reads just as confident.
 */
async function watchedVideoFor(deliverableId: number): Promise<WatchedVideo | null> {
  try {
    const a = await getAnalysis(deliverableId);
    if (!a || a.state !== "done") return null;

    // The structured branding block, straight from the model's own JSON —
    // parsed from the source rather than from the display text built off it.
    const raw = a.raw_json;
    const obj = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    const branding = (obj as { branding?: WatchedVideo["branding"] })?.branding ?? null;

    return {
      summary: a.summary,
      spokenLanguage: a.spoken_language,
      topic: a.topic,
      onScreenText: a.on_screen_text,
      branding,
    };
  } catch {
    // No analysis table, or unreadable JSON. The brief still works.
    return null;
  }
}

export async function generateCaptionAction(
  _prev: CaptionState,
  formData: FormData
): Promise<CaptionState> {
  // Writing the caption is part of finishing the edit.
  const user = await requireUser([...ADMIN_OR_CRM_ROLES, "video_editor"]);
  const id = Number(formData.get("deliverable_id"));
  if (!id) return { ok: false, error: "Missing deliverable." };

  const d = await getDeliverable(id);
  if (!d) return { ok: false, error: "Deliverable not found." };
  if (!(await canAccessClient(user, d.client_id))) return { ok: false, error: "Not authorized." };

  const opts = {
    tone: String(formData.get("tone") || "") || undefined,
    language: String(formData.get("language") || "") || undefined,
    goal: String(formData.get("goal") || "") || undefined,
    length: String(formData.get("length") || "") || undefined,
    include_contact: formData.get("include_contact") !== "off",
  };

  /*
   * Hand over what the AI saw when it watched the finished cut.
   *
   * Best-effort: a video nobody has analysed yet, or an install without the
   * analysis table, simply falls back to the typed brief — the studio worked
   * that way before and must keep working that way.
   */
  const seen = await watchedVideoFor(id);

  let out: ComposedCaption;
  try {
    out = await generateCaption(d as CaptionSource, opts, seen);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Generation failed." };
  }

  // Persist to the caption library + set the deliverable's caption.
  await execute(
    `INSERT INTO captions
      (deliverable_id, client_id, platform, month_key, body, hashtags, cta, hooks, is_ai_generated, created_by)
     VALUES (?,?,?,?,?,?,?,?,1,?)`,
    [
      d.id,
      d.client_id,
      d.platform,
      d.month_key || monthKey(),
      out.caption,
      out.hashtags || null,
      out.cta || null,
      JSON.stringify(out.alternate_captions || []),
      user.id,
    ]
  );
  await execute(
    "UPDATE deliverables SET caption = ?, status = IF(status IN ('editing','raw_uploaded'),'caption_ready',status) WHERE id = ?",
    [out.caption, d.id]
  );

  revalidatePath(`/deliverables/${d.id}`);
  return {
    ok: true,
    provider: out.provider,
    caption: out.caption,
    hashtags: out.hashtags,
    alternates: out.alternate_captions,
    isPoster: out.is_poster,
  };
}

/* ----------------------------- Save caption ----------------------------- */

export async function saveCaptionAction(
  _prev: { ok: boolean; error?: string },
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const id = Number(formData.get("deliverable_id"));
  const caption = String(formData.get("caption") || "");
  if (!id) return { ok: false, error: "Missing deliverable." };
  const d = await queryOne<{ client_id: number }>("SELECT client_id FROM deliverables WHERE id = ?", [id]);
  if (!d) return { ok: false, error: "Deliverable not found." };
  if (!(await canAccessClient(user, d.client_id))) return { ok: false, error: "Not authorized." };
  await execute("UPDATE deliverables SET caption = ? WHERE id = ?", [caption, id]);
  revalidatePath(`/deliverables/${id}`);
  return { ok: true };
}

/* --------------------- Quick-edit "Update Video Details" --------------------- */

export type VideoDetailsState = {
  ok: boolean;
  error?: string;
  mode?: "draft" | "approval";
  /** What happened on WhatsApp, when sending for approval. */
  message?: string;
};

/**
 * Tell someone work has landed on their plate.
 *
 * Assignment was silent until now, which was survivable while only admins used
 * the portal and could see the whole board. It stops being survivable with a
 * role whose entire workflow starts with being handed a video: an editor had
 * no way to learn a task was theirs except by re-reading the queue.
 *
 * Never fires for assigning something to yourself — you already know — and
 * never throws, because failing to send a notification must not fail the save
 * that triggered it.
 */
async function notifyAssignee(
  userId: number | null,
  previous: number | null,
  actorId: number,
  deliverableId: number,
  title: string
): Promise<void> {
  if (!userId || userId === previous || userId === actorId) return;
  const u = await queryOne<{ email: string | null }>("SELECT email FROM users WHERE id = ?", [
    userId,
  ]);
  await notifyUser(
    userId,
    "task_assigned",
    "A task was assigned to you",
    `"${title}" is now yours.`,
    `/deliverables/${deliverableId}`,
    u?.email ?? null
  );
}

/** Save the video/content details modal — Save Draft or Send To Approval. */
export async function updateVideoDetails(
  _prev: VideoDetailsState,
  formData: FormData
): Promise<VideoDetailsState> {
  const me = await requireUser(ADMIN_OR_CRM_ROLES);
  const id = Number(formData.get("deliverable_id"));
  const mode = formData.get("mode") === "approval" ? "approval" : "draft";
  if (!id) return { ok: false, error: "Missing deliverable." };

  // `assigned_to` comes along so a reassignment can be told apart from a save
  // that merely re-submitted the same assignee.
  const d = await queryOne<{
    id: number;
    client_id: number;
    title: string;
    video_type: string | null;
    assigned_to: number | null;
  }>(
    "SELECT id, client_id, title, video_type, assigned_to FROM deliverables WHERE id = ?",
    [id]
  );
  if (!d) return { ok: false, error: "Deliverable not found." };
  if (!(await canAccessClient(me, d.client_id))) return { ok: false, error: "Not authorized." };

  // Saving a draft is open to any admin/crm; actually sending it to the
  // client for review is reserved for super_admin and crm (their own clients).
  if (mode === "approval" && me.role !== "super_admin" && me.role !== "crm") {
    return { ok: false, error: "Only a super admin can send content to the client for review.", mode };
  }

  const val = (k: string) => String(formData.get(k) || "").trim();
  const orNull = (v: string) => (v === "" ? null : v);
  const editedLink = val("edited_link");

  // A video uploaded to our own storage is a deliverable in its own right,
  // even though a private bucket leaves no shareable link to paste.
  const hasCloudVideo =
    (await hasColumn("deliverables", "cloud_video_key")) &&
    Boolean(
      (
        await queryOne<{ cloud_video_key: string | null }>(
          "SELECT cloud_video_key FROM deliverables WHERE id = ?",
          [id]
        )
      )?.cloud_video_key
    );

  if (mode === "approval" && !editedLink && !hasCloudVideo) {
    return { ok: false, error: "Add the video link before sending for approval.", mode };
  }

  const updates: Record<string, string | null> = {
    content_hook: orNull(val("content_hook")),
    description: orNull(val("description")),
    caption: orNull(val("caption")),
    writer_notes: orNull(val("writer_notes")),
    edited_link: orNull(editedLink),
  };
  const title = val("title");
  if (title) updates.title = title; // title is required — don't null it out

  // Manual posting time: an explicit slot overrides the automatic best-time
  // calculation done at client approval. Blank clears it and hands control back.
  if (formData.has("post_at") && me.role === "super_admin") {
    const localValue = val("post_at");
    const country = val("post_country") || null;
    updates.scheduled_at = localValue ? localTimeToUtc(localValue, country) : null;
  }

  // Reassignment, including clearing it: the field is only present when the
  // caller may change it, so an absent value leaves the assignee alone.
  if (formData.has("assigned_to")) {
    const raw = Number(val("assigned_to"));
    updates.assigned_to = raw > 0 ? String(raw) : null;
  }

  // Re-tagging: service + category travel together, and video_type follows.
  const serviceRaw = val("service");
  if (isServiceKey(serviceRaw)) {
    const category = val("content_category");
    if (!category) return { ok: false, error: "Pick a category for this task.", mode };
    updates.service = serviceRaw;
    updates.content_category = category;
    updates.video_type = videoTypeForService(serviceRaw, category);
  }

  if (mode === "approval") {
    updates.status = "review";
    updates.approval_status = "pending";
    updates.reject_reason = null;
  }

  const keys = Object.keys(updates);
  await execute(`UPDATE deliverables SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
    ...keys.map((k) => updates[k]),
    id,
  ]);

  // After the save, never before: nobody should be told about work that then
  // failed to persist.
  if (formData.has("assigned_to")) {
    await notifyAssignee(
      updates.assigned_to ? Number(updates.assigned_to) : null,
      d.assigned_to,
      me.id,
      id,
      title || d.title
    );
  }

  /*
   * Send it where the client actually replies.
   *
   * This button used only to set the status and email them; WhatsApp needed
   * someone to open the task page afterwards and press a second button, also
   * called send for approval. One of the two didn't reach the place clients
   * answer from, and nothing said which.
   *
   * Best-effort on purpose: a client with no linked group approves by email
   * and the save must still succeed, so a skip is silent and only a real
   * failure is reported.
   */
  let waNote: string | null = null;
  if (mode === "approval") {
    try {
      const sent = await deliverForApproval(id);
      if (sent.ok) waNote = describeDelivery(sent);
      else if (!sent.skipped) waNote = `Saved, but WhatsApp failed: ${sent.error}`;
    } catch (err) {
      waNote = `Saved, but WhatsApp failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  }

  if (mode === "approval") {
    // Use the just-saved type, so re-tagging in the same submit is respected.
    const effectiveType = updates.video_type ?? d.video_type;
    const kind = String(effectiveType).toLowerCase() === "poster" ? "poster" : "final video";
    await notifyClientById(
      d.client_id,
      "approval_needed",
      `Your ${kind} is ready for review`,
      `"${title || d.title}" — please review and approve or request changes.`,
      `/portal/content/${id}`
    );
  }

  revalidatePath("/deliverables");
  revalidatePath(`/deliverables/${id}`);
  revalidatePath("/today");
  revalidatePath("/approvals");
  revalidatePath("/poster");
  return { ok: true, mode, ...(waNote ? { message: waNote } : {}) };
}

/* ------------------------- Workflow transitions ------------------------- */

export type StatusState = { ok: boolean; error?: string; effective?: string };

const nowStr = () => new Date().toISOString().slice(0, 19).replace("T", " ");

type WfRow = {
  id: number;
  client_id: number;
  status: string;
  video_type: string | null;
  posted_at: string | null;
  title: string;
  /** Read so scheduling can hand the post to the publisher without undoing one. */
  instagram_status: string | null;
  scheduled_at: string | null;
};

/**
 * Apply a workflow status transition — faithful port of the original
 * /deliverables/:id/status logic, incl. the two-gate approval rule:
 * approving while in `content_review` approves the CONTENT (advances to
 * waiting_for_raw), not the final video. Records the approval trail + feedback.
 */
async function applyStatus(
  user: SessionUser,
  id: number,
  status: string,
  reason?: string
): Promise<StatusState> {
  if (!id) return { ok: false, error: "Missing deliverable." };
  if (!(STATUS_LIST as readonly string[]).includes(status)) {
    return { ok: false, error: "Invalid status." };
  }
  const d = await queryOne<WfRow>(
    "SELECT id, client_id, status, video_type, posted_at, title, instagram_status, scheduled_at FROM deliverables WHERE id = ?",
    [id]
  );
  if (!d) return { ok: false, error: "Deliverable not found." };
  if (!(await canAccessClient(user, d.client_id))) return { ok: false, error: "Not authorized." };
  if (REASON_REQUIRED.includes(status) && !reason) {
    return { ok: false, error: `A reason is required to mark this as ${status.replace(/_/g, " ")}.` };
  }
  // Sending content to the client (either approval gate) is reserved for
  // super_admin and crm (their own clients) — everything else in the
  // workflow stays open to any admin.
  if (
    ["content_review", "review"].includes(status) &&
    user.role !== "super_admin" &&
    user.role !== "crm"
  ) {
    return { ok: false, error: "Only a super admin can send content to the client for review." };
  }
  // A video editor moves the edit along and nothing else. Enforced here rather
  // than only in the buttons, because the buttons are not the security model.
  if (user.role === "video_editor" && !(EDITOR_STATUSES as string[]).includes(status)) {
    return { ok: false, error: "An editor can only move a task through the editing stages." };
  }

  // Gate 1: approving content_review approves the CONTENT → waiting_for_raw.
  const contentGate = status === "approved" && d.status === "content_review";
  const effective = contentGate ? "waiting_for_raw" : status;

  const updates: Record<string, string | null> = { status: effective };
  if (reason) updates.reject_reason = reason;
  if (["content_review", "review"].includes(effective)) {
    updates.reject_reason = null;
    updates.approval_status = "pending";
  }
  if (contentGate) updates.approval_status = "pending";
  else if (effective === "approved") updates.approval_status = "approved";
  if (effective === "changes_requested") updates.approval_status = "changes_requested";
  if (effective === "rejected") {
    updates.approval_status = "rejected";
    updates.posting_status = "rejected";
  }
  // Scheduling has to reach instagram_status too, or the publisher never sees it.
  if (effective === "scheduled") Object.assign(updates, publishHandoff(d));
  if (effective === "posted" || effective === "completed") {
    updates.posting_status = "posted";
    if (!d.posted_at) updates.posted_at = nowStr();
  }

  const keys = Object.keys(updates);
  await execute(
    `UPDATE deliverables SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    [...keys.map((k) => updates[k]), id]
  );

  if (["approved", "changes_requested", "rejected"].includes(status)) {
    await execute(
      "INSERT INTO approvals (deliverable_id, client_id, action, reason, acted_by) VALUES (?,?,?,?,?)",
      [id, d.client_id, status === "approved" ? "approved" : status, reason || null, user.id]
    );
  }
  if (reason) {
    await execute(
      "INSERT INTO feedback (deliverable_id, author_id, author_role, message) VALUES (?,?,?,?)",
      [id, user.id, user.role, reason]
    );
  }

  // Notify the client (staff-initiated transitions). For the two approval
  // gates we send a formal branded email, so `mail: false` keeps the generic
  // notification copy from doubling up.
  const link = `/portal/content/${id}`;
  if (effective === "content_review" || effective === "review") {
    const stage = effective === "content_review" ? "content" : "final";
    const kind = String(d.video_type).toLowerCase() === "poster" ? "poster" : "final video";
    const title =
      stage === "content" ? "Content ready for your review" : `Your ${kind} is ready for review`;

    await notifyClientById(
      d.client_id,
      "approval_needed",
      title,
      `"${d.title}" — please review and approve or request changes.`,
      link,
      false
    );

    const client = await queryOne<{
      company_name: string;
      contact_person: string | null;
      email: string | null;
    }>("SELECT company_name, contact_person, email FROM clients WHERE id = ?", [d.client_id]);
    if (client) {
      sendApprovalRequestEmail(client, {
        title: d.title,
        stage,
        kind: d.video_type,
        link,
      }).catch(() => {});
    }
  } else if (["scheduled", "posted", "completed", "rejected", "resolved"].includes(effective)) {
    await notifyClientById(d.client_id, "general", `"${d.title}" — ${effective.replace(/_/g, " ")}`,
      reason || "Status updated by the agency.", link);
  }

  revalidatePath(`/deliverables/${id}`);
  revalidatePath("/deliverables");
  revalidatePath("/today");
  revalidatePath("/approvals");
  return { ok: true, effective };
}

/** For the detail-page workflow controls (shows errors via useActionState). */
export async function changeStatusAction(
  _prev: StatusState,
  formData: FormData
): Promise<StatusState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  return applyStatus(
    user,
    Number(formData.get("deliverable_id")),
    String(formData.get("status") || ""),
    String(formData.get("reason") || "").trim() || undefined
  );
}

/** For reason-free inline buttons on the Approvals worklist. */
export async function quickStatus(formData: FormData): Promise<void> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  await applyStatus(
    user,
    Number(formData.get("deliverable_id")),
    String(formData.get("status") || ""),
    undefined
  );
}

/* --------------------- Raw footage / reference links (staff-side) --------------------- */

export type RawFootageState = { ok: boolean; error?: string; message?: string };

/**
 * Staff-side equivalent of the client portal's raw-footage form — for when
 * the client sent footage outside the portal (WhatsApp, email) and staff/crm
 * enter the link on their behalf. If there's no raw footage at all, reference
 * links can be provided instead so editing can still start.
 */
export async function submitRawOrReference(
  _prev: RawFootageState,
  formData: FormData
): Promise<RawFootageState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const id = Number(formData.get("deliverable_id"));
  if (!id) return { ok: false, error: "Missing task." };

  const d = await queryOne<{ id: number; client_id: number; status: string; title: string }>(
    "SELECT id, client_id, status, title FROM deliverables WHERE id = ?",
    [id]
  );
  if (!d) return { ok: false, error: "Task not found." };
  if (!(await canAccessClient(user, d.client_id))) return { ok: false, error: "Not authorized." };
  if (d.status !== "waiting_for_raw") {
    return { ok: false, error: "This task isn't waiting for raw footage." };
  }

  const rawLink = String(formData.get("raw_drive_link") || "").trim();
  const referenceLinks = String(formData.get("reference_links") || "").trim();
  if (!rawLink && !referenceLinks) {
    return { ok: false, error: "Add a raw footage link, or at least one reference link." };
  }
  if (rawLink && !/^https?:\/\/.+/i.test(rawLink)) {
    return { ok: false, error: "Raw footage link must be a valid URL." };
  }

  const updates: Record<string, string | null> = { status: "raw_uploaded" };
  if (rawLink) updates.raw_drive_link = rawLink;
  if (referenceLinks) updates.reference_links = referenceLinks;

  const keys = Object.keys(updates);
  await execute(`UPDATE deliverables SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
    ...keys.map((k) => updates[k]),
    id,
  ]);

  revalidatePath("/deliverables");
  revalidatePath(`/deliverables/${id}`);
  revalidatePath("/today");

  return {
    ok: true,
    message: rawLink ? "Raw footage added — ready to edit." : "Reference links added — ready to edit.",
  };
}

/* --------------------- Retry a failed Instagram post --------------------- */

export type RetryState = { ok: boolean; error?: string };

/**
 * Put a deliverable whose publish failed back into the automation's queue.
 *
 * Resetting `post_attempts` is the whole point — the queue refuses anything
 * that has spent its retry budget, so without the reset the row would be
 * offered to nobody however many times the button was pressed.
 *
 * Admin-only, and scoped for a crm user: this causes a post to appear on a
 * real client account, which is not something a scoped user should be able to
 * trigger for a client they don't own.
 */
export async function retryPublishAction(
  _prev: RetryState,
  formData: FormData
): Promise<RetryState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const id = Number(formData.get("deliverable_id"));
  if (!id) return { ok: false, error: "Missing task." };

  const row = await queryOne<{ client_id: number; instagram_status: string }>(
    "SELECT client_id, instagram_status FROM deliverables WHERE id = ?",
    [id]
  );
  if (!row) return { ok: false, error: "Task not found." };
  if (!(await canAccessClient(user, row.client_id))) {
    return { ok: false, error: "You don't have access to this client." };
  }
  if (row.instagram_status === "posted") {
    return { ok: false, error: "This is already live on Instagram." };
  }

  const ok = await retryPublish(id);
  if (!ok) return { ok: false, error: "Could not queue it — try reloading the page." };

  revalidatePath(`/deliverables/${id}`);
  revalidatePath("/deliverables");
  return { ok: true };
}
