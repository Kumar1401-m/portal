"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { queueAnalysis, runAnalysis, type CaptionOverrides, type RunResult } from "@/lib/video-ai";
import { queryOne, execute, hasColumn } from "@/lib/db";
import {
  requireUser,
  ADMIN_ROLES,
  ADMIN_OR_CRM_ROLES,
  SUPER_ADMIN_ROLES,
  type SessionUser,
} from "@/lib/auth";
import {
  type ComposedCaption,
} from "@/lib/ai";
import { getDeliverable } from "@/lib/deliverables";
import { canAccessClient } from "@/lib/crm";
import { clientDefaults, defaultAssigneeFor } from "@/lib/clients";
import { youtubeHandoff } from "@/lib/youtube";
import { notifyClientById, notifyUser, notifyAdmins } from "@/lib/notify";
import { PLATFORMS, PRIORITIES, STATUS_LIST, EDITOR_STATUSES } from "@/lib/constants";
import { isServiceKey, videoTypeForService, type ServiceKey } from "@/lib/services";
import { monthKey, autoTaskTitle } from "@/lib/utils";
import { localTimeToUtc, scheduleDateToUtc } from "@/lib/posting";
import { retryPublish, publishHandoff, countryOf, approvalHandoff } from "@/lib/instagram";
import { postingSlotFor } from "@/lib/best-time";
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

  const client = await queryOne<{ id: number }>("SELECT id FROM clients WHERE id = ?", [clientId]);
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
  // Nobody picked a person, so fall back to the client's default for this kind
  // of work — a poster to their designer, a video to their editor.
  const assignedTo =
    assignedToRaw > 0 ? assignedToRaw : defaultAssigneeFor(service, await clientDefaults(client.id));

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

  /*
   * One caption writer, for every kind of task.
   *
   * There used to be two. This action called the brief writer — it read what
   * somebody typed into the task and had never heard of the client's caption
   * structure — while a second, much better one sat behind the video panel
   * reading a dozen frames of the finished cut. Which caption you got depended
   * on which button you happened to press, and both looked equally finished.
   *
   * So the video writer became the only writer. It works from whatever it has:
   * frames and a transcript when the video is uploaded, the brief alone when
   * it is not, or when the task is a poster — and it is told plainly which,
   * so it never describes footage it was not shown.
   */
  const run = await runAnalysisForCaption(id, {
    tone: String(formData.get("tone") || "") || undefined,
    language: String(formData.get("language") || "") || undefined,
    goal: String(formData.get("goal") || "") || undefined,
    length: String(formData.get("length") || "") || undefined,
    includeContact: formData.get("include_contact") !== "off",
  });

  if (!run.ok) return { ok: false, error: run.error || "Couldn't generate a caption." };
  if (run.state !== "done" || !run.caption) {
    // Still working: the job carries on server-side and the panel polls it.
    return { ok: false, error: "Still writing — give it a moment and look again." };
  }

  const out = {
    caption: run.caption,
    hashtags: run.hashtags ?? null,
    cta: run.cta ?? null,
    alternate_captions: run.alternates ?? [],
    is_poster: String(d.video_type || "").toLowerCase() === "poster",
    provider: "gemini" as const,
  };

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
    hashtags: out.hashtags ?? undefined,
    alternates: out.alternate_captions,
    isPoster: out.is_poster,
    // Whether it could actually see the work, or only read about it. The
    // difference decides what the panel is allowed to claim.
    fromVideo: Boolean(d.cloud_video_key || d.cloud_video_url || d.edited_link),
  };
}

/**
 * Force a fresh run of the caption writer and return what it produced.
 *
 * Forced because this is somebody pressing a button: a finished analysis
 * would otherwise be handed straight back, and pressing "Generate" and
 * receiving the caption already on screen reads as the button not working.
 * The three-per-48-hours ceiling is what stops that being expensive.
 */
async function runAnalysisForCaption(
  deliverableId: number,
  overrides: CaptionOverrides
): Promise<RunResult> {
  await queueAnalysis(deliverableId, true);
  return runAnalysis(deliverableId, overrides);
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

  // Posting day: the date is chosen, the time is the client's evening slot —
  // 6 to 8 PM depending on the country. Blank clears it, which hands the timing
  // back to the automatic calculation made at client approval.
  //
  // Still accepts a date with a time on it, because a task scheduled before
  // this became a date-only field has one stored, and a browser that renders
  // the input its own way should not be able to wipe a scheduled post.
  if (formData.has("post_at") && me.role === "super_admin") {
    const picked = val("post_at");
    const country = val("post_country") || null;
    updates.scheduled_at = picked
      ? scheduleDateToUtc(picked.slice(0, 10), country) ?? localTimeToUtc(picked, country)
      : null;
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

export type StatusState = {
  ok: boolean;
  error?: string;
  effective?: string;
  /** Succeeded, but something about the outcome is worth knowing. */
  warning?: string;
};

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
  /** Both are conditions the publish queue insists on — see applyStatus. */
  auto_publish: number | null;
  ig_user_id: string | null;
  /** Whose evening the post belongs to — see publishHandoff. */
  placeholder_values: unknown;
  /** The YouTube half of the same handoff. Null on a database without it. */
  youtube_enabled: number | null;
  youtube_status: string | null;
  /** Who to tell when the content gate opens and the work becomes theirs. */
  assigned_to: number | null;
  service: string | null;
  /** With `service`, what this task publishes as — see autoPostKind. */
  content_category: string | null;
  /** The day it is down for, which is which day it posts — see postingSlotFor. */
  due_date: string | null;
  company_name: string;
  /**
   * Does this client sign the written content off first? Null on a database
   * without the column, which is read as "yes" — the older behaviour.
   */
  content_approval: number | null;
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
  reason?: string,
  /**
   * Suppress the hand-off notification, because the caller is sending one of
   * its own.
   *
   * Set only when a batch goes through here a piece at a time — approving a
   * client's month is fifteen calls and one designer, and fifteen identical
   * alerts is how somebody turns notifications off. The batch caller sends a
   * single summary instead. Everything else about the transition is unchanged,
   * so the trail and the status are identical either way.
   */
  quiet = false
): Promise<StatusState> {
  if (!id) return { ok: false, error: "Missing deliverable." };
  if (!(STATUS_LIST as readonly string[]).includes(status)) {
    return { ok: false, error: "Invalid status." };
  }
  // Feature-gated: the portal has to keep working on a database the YouTube
  // migration has not reached, and a missing column would take down every
  // status change rather than just the upload it enables.
  const hasYouTube = await hasColumn("clients", "youtube_enabled");
  const hasContentApproval = await hasColumn("clients", "content_approval");
  const d = await queryOne<WfRow>(
    `SELECT d.id, d.client_id, d.status, d.video_type, d.posted_at, d.title,
            d.instagram_status, d.scheduled_at, d.due_date, d.assigned_to, d.service, d.content_category,
            c.company_name, c.auto_publish, c.ig_user_id, c.placeholder_values,
            ${hasContentApproval ? "c.content_approval" : "NULL AS content_approval"},
            ${hasYouTube ? "c.youtube_enabled, d.youtube_status" : "NULL AS youtube_enabled, NULL AS youtube_status"}
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
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

  /*
   * Content review is a step inside the agency now.
   *
   * There used to be a per-client switch here: some clients read the month's
   * copy before anything was made and some handed us the month and wanted it
   * made, so "send for content review" either went to the client or skipped
   * them. Content no longer goes to a client at all, so there is nothing to
   * skip — every task passes through the step and the team moves it on.
   */
  const effective = contentGate ? "waiting_for_raw" : status;
  /** Approving the copy is what puts it in the maker's hands. */
  const handedToMaker = contentGate;

  const updates: Record<string, string | null> = { status: effective };
  if (reason) updates.reject_reason = reason;
  if (["content_review", "review"].includes(effective)) {
    updates.reject_reason = null;
    updates.approval_status = "pending";
  }
  if (handedToMaker) updates.approval_status = "pending";
  else if (effective === "approved") {
    updates.approval_status = "approved";
    /*
     * And an approved reel goes to the publisher without a second button.
     *
     * Approving used to leave the row at `approved` and nothing more, so the
     * Approvals page grew a "Recently approved" column whose only action was
     * Schedule — a click that added no information. Everything it decided (the
     * client's best hour, their evening window, the handoff columns) was
     * already knowable the moment the approval landed.
     *
     * `approvalHandoff` writes nothing unless the client is set up to post
     * unattended, so a poster, an opted-out client, or a task with no finished
     * video still stops plainly at "approved" and waits for a person.
     */
    Object.assign(updates, await approvalHandoff(id));
    if (updates.status === "scheduled" && hasYouTube) Object.assign(updates, youtubeHandoff(d));
  }
  if (effective === "changes_requested") updates.approval_status = "changes_requested";
  if (effective === "rejected") {
    updates.approval_status = "rejected";
    updates.posting_status = "rejected";
  }

  /*
   * Pulling a video back takes it out of the publish queue.
   *
   * Nothing did this. The queue selects on `instagram_status = 'scheduled'`
   * and nothing but publishing ever cleared it, so a video that had been
   * scheduled and was then rejected, sent back for changes, or returned to the
   * client for another look stayed queued the whole time — and would go live
   * on the client's feed while they were still looking at it, or after they
   * had turned it down. Rejecting even set `posting_status = 'rejected'` while
   * leaving `instagram_status` alone, so the board said one thing and the
   * publisher read another.
   *
   * A video already posted is untouched: that is history, not a queue entry.
   */
  if (["review", "content_review", "changes_requested", "rejected", "cancelled"].includes(effective)) {
    if (d.instagram_status !== "posted") {
      updates.instagram_status = "not_posted";
      if (effective !== "rejected") updates.posting_status = "not_posted";
      updates.scheduled_at = null;
    }
  }
  // Scheduling has to reach instagram_status too, or the publisher never sees it.
  //
  // An admin pressing Schedule is a deliberate act and is always honoured —
  // but the publish queue also requires the client to be opted in and to have
  // an Instagram account on file, and neither is visible from this button. So
  // the handoff still happens and the reason it will not go out is reported,
  // rather than leaving a row that looks queued for ever.
  let scheduleWarning: string | null = null;
  if (effective === "scheduled") {
    /*
     * The day it is down for, at their own best hour.
     *
     * publishHandoff falls back to the country table and to *now* — roughly
     * evening, roughly local, on whatever day the button happened to be
     * pressed. Both halves are wrong here: the account's own proven hour beats
     * a guess about a country, and a task carrying a date is a decision about
     * which day it goes out. `postingSlotFor` answers both, so the handoff
     * receives a time somebody already chose.
     *
     * A time set by hand still wins: this only fills a blank.
     */
    if (!d.scheduled_at) {
      d.scheduled_at = await postingSlotFor(
        d.client_id,
        countryOf(d.placeholder_values),
        d.due_date
      ).catch(() => null);
    }
    Object.assign(updates, publishHandoff(d));
    // Same slot, both platforms. Writes nothing at all unless the client is
    // opted in, so a portal that never touches YouTube behaves as before.
    if (hasYouTube) Object.assign(updates, youtubeHandoff(d));
    const missing = [
      Number(d.auto_publish) === 1 ? null : "auto-publish is off for this client",
      d.ig_user_id ? null : "no Instagram account is linked to this client",
    ].filter(Boolean);
    if (missing.length) {
      scheduleWarning =
        `Scheduled, but it won't post by itself — ${missing.join(" and ")}. ` +
        `Fix that on the client, or post it by hand.`;
    }
  }
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

    /*
     * No email. Asked for directly: a client is mailed once, at onboarding,
     * and everything after that reaches them through the portal notification
     * above and their WhatsApp group — which is where they actually approve.
     * A separate email saying the same thing was the pile that made them stop
     * reading any of it.
     */
  } else if (["scheduled", "posted", "completed", "rejected", "resolved"].includes(effective)) {
    await notifyClientById(d.client_id, "general", `"${d.title}" — ${effective.replace(/_/g, " ")}`,
      reason || "Status updated by the agency.", link);
  }

  /*
   * An editor finishing is a handover, and somebody has to be told.
   *
   * `caption_ready` is where the edit stops and the super admin's look begins —
   * an editor cannot send anything to a client, by design. But nothing
   * announced it, so finished work sat in a status nobody was watching until
   * someone happened to scan the board. The designer's submit form has always
   * notified; the editor's route through the workflow control never did, which
   * made the same handover visible or invisible depending on which screen it
   * was done from.
   *
   * Not when an admin does it themselves — telling someone their own action
   * happened is how a notification list becomes noise.
   */
  if (effective === "caption_ready" && !ADMIN_ROLES.includes(user.role)) {
    await notifyAdmins(
      "general",
      "🎬 Ready for your review",
      `${user.name} finished "${d.title}". Check it, then send it to the client.`,
      link
    );
  }

  /*
   * The content gate opening is the moment the work becomes the maker's.
   *
   * Nothing told them. The brief was written, sent to the client, approved —
   * and the task simply appeared in a queue they had no reason to be looking
   * at. For a poster especially: it is not in their list at all until this
   * happens, so without a word they would never know it had arrived.
   */
  if (handedToMaker && d.assigned_to && !quiet) {
    const isPoster =
      d.service === "poster_designing" ||
      (!d.service && String(d.video_type ?? "").toLowerCase() === "poster");
    // It never says the client approved it, because the client never saw it —
    // content is settled inside the agency, and a designer told otherwise
    // might repeat it back to that client.
    const released = `The content for "${d.title}" (${d.company_name}) is written and it's yours. `;
    await notifyUser(
      d.assigned_to,
      "general",
      isPoster ? "🎨 A poster is ready to design" : "✏️ Content ready — over to you",
      released +
        (isPoster
          ? "It's in your posters list now — paste the design link when it's ready."
          : "You can start on it."),
      link
    );
  }

  revalidatePath(`/deliverables/${id}`);
  revalidatePath("/deliverables");
  revalidatePath("/today");
  revalidatePath("/approvals");
  // What the row says, not what was asked for. Approving a reel that is set
  // up to post writes `scheduled`, and "Moved to Approved ✓" over a row the
  // board shows as Scheduled is the kind of small lie people stop trusting.
  return {
    ok: true,
    effective: updates.status ?? effective,
    ...(scheduleWarning ? { warning: scheduleWarning } : {}),
  };
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
    String(formData.get("reason") || "").trim() || undefined,
    formData.get("quiet") === "1"
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

/* ------------------------------ Post it now ------------------------------ */

export type PostNowState = { ok: boolean; error?: string; permalink?: string; pending?: boolean };

/**
 * Publish this video to Instagram right now.
 *
 * The scheduler answers "when", and sometimes the answer needed is "now" —
 * a post that missed its slot, a client on the phone, a date that was moved
 * once too often. Waiting up to fifteen minutes for the next poll to agree
 * with you is not a workflow.
 *
 * Super admin only, and not because of the code: this is the one button in the
 * portal that puts something on a client's public account the instant it is
 * pressed. Everything else can be undone from inside the portal; this cannot.
 */
export async function postNowAction(
  _prev: PostNowState,
  formData: FormData
): Promise<PostNowState> {
  const user = await requireUser(SUPER_ADMIN_ROLES);
  const id = Number(formData.get("deliverable_id"));
  if (!id) return { ok: false, error: "Missing task." };

  const row = await queryOne<{ client_id: number }>(
    "SELECT client_id FROM deliverables WHERE id = ?",
    [id]
  );
  if (!row) return { ok: false, error: "Task not found." };
  if (!(await canAccessClient(user, row.client_id))) {
    return { ok: false, error: "You don't have access to this client." };
  }

  const { publishNow } = await import("@/lib/instagram-publish");
  const res = await publishNow(id);

  revalidatePath(`/deliverables/${id}`);
  revalidatePath("/deliverables");
  revalidatePath("/today");

  if (!res.ok) return { ok: false, error: res.error, pending: res.pending };
  return { ok: true, permalink: res.permalink ?? undefined };
}

/* ---------------------- Post to the Facebook Page ---------------------- */

export type FacebookPostState = { ok: boolean; error?: string; message?: string };

/**
 * Put a video on the client's Page on its own.
 *
 * The Instagram retry cannot do this: it refuses anything already posted, and
 * rightly — re-running it would publish the reel to Instagram a second time.
 * So a Page that refused the video, or a Page id added after the reel went
 * out, had no way back from inside the portal at all.
 *
 * Super admin only, the same rule "Post now" follows. Both put something on a
 * client's public account the moment they are pressed.
 */
export async function postToFacebookAction(
  _prev: FacebookPostState,
  formData: FormData
): Promise<FacebookPostState> {
  const user = await requireUser(SUPER_ADMIN_ROLES);
  const id = Number(formData.get("deliverable_id"));
  if (!id) return { ok: false, error: "Missing task." };

  const row = await queryOne<{ client_id: number }>(
    "SELECT client_id FROM deliverables WHERE id = ?",
    [id]
  );
  if (!row) return { ok: false, error: "Task not found." };
  if (!(await canAccessClient(user, row.client_id))) {
    return { ok: false, error: "You don't have access to this client." };
  }

  const { publishToPageNow } = await import("@/lib/facebook");
  const res = await publishToPageNow(id);

  revalidatePath(`/deliverables/${id}`);
  revalidatePath("/deliverables");

  if (res.ok) return { ok: true, message: "Posted to the Page." };
  // "Skipped" is a reason, not a failure — no Page id, or it is already there.
  return { ok: false, error: "skipped" in res && res.skipped ? res.reason : res.error };
}
