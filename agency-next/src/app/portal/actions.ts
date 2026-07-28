"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute } from "@/lib/db";
import { requireUser, type SessionUser } from "@/lib/auth";
import { notifyAdmins } from "@/lib/notify";
import { nextBestPostTime, AUTO_SCHEDULE_CATEGORIES } from "@/lib/zapier";

export type PortalActionState = { ok: boolean; error?: string; message?: string };

type Row = {
  id: number;
  client_id: number;
  status: string;
  video_type: string | null;
  title: string;
  service: string | null;
  content_category: string | null;
  edited_link: string | null;
  ig_user_id: string | null;
  placeholder_values: unknown;
};

/** Shared client-side transition (approve / request changes), ownership-scoped. */
async function clientTransition(
  user: SessionUser,
  id: number,
  action: "approve" | "changes",
  reason: string
): Promise<PortalActionState> {
  if (!user.clientId) return { ok: false, error: "No client profile linked." };
  if (!id) return { ok: false, error: "Missing item." };

  const d = await queryOne<Row>(
    `SELECT d.id, d.client_id, d.status, d.video_type, d.title, d.service, d.content_category,
            d.edited_link, c.ig_user_id, c.placeholder_values
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE d.id = ? AND d.client_id = ?`,
    [id, user.clientId]
  );
  if (!d) return { ok: false, error: "Not found." };
  if (!["content_review", "review"].includes(d.status)) {
    return { ok: false, error: "This item isn't awaiting your review." };
  }
  if (action === "changes" && !reason) {
    return { ok: false, error: "Please describe the change you'd like." };
  }

  // Gate 1: approving content_review approves the CONTENT → waiting_for_raw.
  const contentGate = action === "approve" && d.status === "content_review";
  let effective: string;
  const updates: Record<string, string | null> = {};
  if (action === "approve") {
    effective = contentGate ? "waiting_for_raw" : "approved";
    updates.approval_status = contentGate ? "pending" : "approved";
    updates.reject_reason = null;
  } else {
    effective = "changes_requested";
    updates.approval_status = "changes_requested";
    updates.reject_reason = reason;
  }
  updates.status = effective;

  // Final approval (not the content gate) of an auto-postable Instagram Reel:
  // hold it as "scheduled" for the client's best local engagement time
  // instead of posting the moment it's approved. The Zapier automation only
  // picks up rows once `scheduled_at` has actually arrived.
  let scheduledFor: string | null = null;
  if (effective === "approved") {
    const isVideoService =
      d.service === "video_editing" ||
      (d.service == null && String(d.video_type ?? "").toLowerCase() !== "poster");
    const autoPostable =
      isVideoService &&
      d.content_category != null &&
      AUTO_SCHEDULE_CATEGORIES.includes(d.content_category) &&
      Boolean(d.ig_user_id) &&
      Boolean(d.edited_link);
    if (autoPostable) {
      const ph = (d.placeholder_values && typeof d.placeholder_values === "object"
        ? d.placeholder_values
        : {}) as Record<string, unknown>;
      const country = typeof ph.country === "string" ? ph.country : null;
      scheduledFor = nextBestPostTime(country);
      updates.status = "scheduled";
      updates.posting_status = "scheduled";
      updates.scheduled_at = scheduledFor;
    }
  }

  const keys = Object.keys(updates);
  await execute(`UPDATE deliverables SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
    ...keys.map((k) => updates[k]),
    id,
  ]);

  await execute(
    "INSERT INTO approvals (deliverable_id, client_id, action, reason, acted_by) VALUES (?,?,?,?,?)",
    [id, user.clientId, action === "approve" ? "approved" : "changes_requested", reason || null, user.id]
  );
  if (reason) {
    await execute(
      "INSERT INTO feedback (deliverable_id, author_id, author_role, message) VALUES (?,?,?,?)",
      [id, user.id, "client", reason]
    );
  }

  const msg =
    action === "approve"
      ? contentGate
        ? `${d.title}: content approved — ready for the video.`
        : scheduledFor
          ? `${d.title}: approved by the client — auto-posting to Instagram at ${scheduledFor} UTC.`
          : `${d.title}: approved by the client.`
      : `${d.title}: client requested changes — ${reason}`;
  await notifyAdmins(
    action === "approve" ? "approval_needed" : "changes_requested",
    action === "approve" ? "Client approved" : "Client requested changes",
    msg,
    `/deliverables/${id}`
  );

  revalidatePath("/portal");
  revalidatePath("/portal/content");
  revalidatePath(`/portal/content/${id}`);
  revalidatePath("/deliverables");
  revalidatePath("/today");
  revalidatePath("/approvals");
  return {
    ok: true,
    message: contentGate
      ? "Content approved — thank you! We'll start on the video."
      : action === "approve"
        ? scheduledFor
          ? "Approved — thank you! This will post automatically at the best time."
          : "Approved — thank you!"
        : "Thanks — we've noted your changes.",
  };
}

export async function clientApprove(
  _prev: PortalActionState,
  formData: FormData
): Promise<PortalActionState> {
  const user = await requireUser(["client"]);
  return clientTransition(user, Number(formData.get("deliverable_id")), "approve", "");
}

export async function clientRequestChanges(
  _prev: PortalActionState,
  formData: FormData
): Promise<PortalActionState> {
  const user = await requireUser(["client"]);
  return clientTransition(
    user,
    Number(formData.get("deliverable_id")),
    "changes",
    String(formData.get("reason") || "").trim()
  );
}
