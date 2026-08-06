"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES, ADMIN_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import {
  prepareSend,
  markQueued,
  recordSendStatus,
  linkGroup,
  unlinkGroup,
} from "@/lib/whatsapp-approvals";
import { sendVideoToGroup, reconnectService, sendTextToGroup } from "@/lib/whatsapp-service-client";
import { queryOne } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { welcomeMessage } from "@/lib/whatsapp-ai";

export type SendState = { ok: boolean; message?: string; error?: string };

/**
 * "Send for approval" — push a finished video into the client's WhatsApp group.
 *
 * The video code is allocated here (not at upload) so codes are only spent on
 * videos that actually go to a client. That keeps the numbers a client types
 * short, and means a code always refers to something they were shown.
 */
export async function sendForApprovalAction(
  _prev: SendState,
  formData: FormData
): Promise<SendState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const deliverableId = Number(formData.get("deliverable_id"));
  if (!deliverableId) return { ok: false, error: "Missing task." };

  const prepared = await prepareSend(deliverableId);
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const { video } = prepared;

  // Checked after prepareSend so the scoping error can name the client.
  if (!(await canAccessClient(user, video.clientId))) {
    return { ok: false, error: "You don't have access to this client." };
  }

  await markQueued(deliverableId, video.groupId);

  const result = await sendVideoToGroup({
    videoCode: video.videoCode,
    deliverableId: video.deliverableId,
    groupId: video.groupId,
    videoUrl: video.videoUrl,
    caption: video.caption,
    filename: `${video.videoCode}.mp4`,
  });

  if (!result.ok) {
    // The service already logs its own attempts; this records the portal-side
    // failure for the cases where the service was never reached at all.
    await recordSendStatus({
      deliverableId,
      videoCode: video.videoCode,
      groupId: video.groupId,
      status: "failed",
      errorMessage: result.error,
    });
    revalidatePath("/approvals");
    return {
      ok: false,
      error: result.unreachable
        ? `${result.error} The video stays queued — try again once WhatsApp is back.`
        : result.error,
    };
  }

  revalidatePath("/approvals");
  revalidatePath(`/deliverables/${deliverableId}`);

  return {
    ok: true,
    message: `${video.videoCode} sent to ${video.clientName} on WhatsApp. They'll reply APPROVE ${video.videoCode} or CHANGE ${video.videoCode}.`,
  };
}

export type GroupState = { ok: boolean; message?: string; error?: string };

/** Map a WhatsApp group to a client, so replies from it can be attributed. */
export async function linkGroupAction(
  _prev: GroupState,
  formData: FormData
): Promise<GroupState> {
  await requireUser(ADMIN_ROLES);

  const clientId = Number(formData.get("client_id"));
  const groupId = String(formData.get("group_id") || "").trim();
  const groupName = String(formData.get("group_name") || "").trim() || null;

  if (!clientId) return { ok: false, error: "Pick a client." };
  if (!groupId.endsWith("@g.us")) {
    return {
      ok: false,
      error: 'That is not a group id. It should end in "@g.us" — pick one from the list below.',
    };
  }

  await linkGroup(clientId, groupId, groupName);

  /*
   * Introduce ourselves, once, on linking.
   *
   * This is the first time the client's group hears from the agency's number,
   * and it is the only chance to state the approval wording before a video
   * turns up depending on it. Sent after the link is saved, so a WhatsApp
   * hiccup costs the greeting rather than the mapping — the mapping is the
   * part that matters and the part that is hard to notice missing.
   */
  let greeted = false;
  try {
    const client = await queryOne<{ company_name: string }>(
      "SELECT company_name FROM clients WHERE id = ?",
      [clientId]
    );
    if (client) {
      const settings = await getSettings().catch(() => null);
      const text = welcomeMessage(client.company_name, settings?.company_name || "our team");
      greeted = (await sendTextToGroup(groupId, text)).ok;
    }
  } catch {
    // Linked either way; the greeting can be sent by hand.
  }

  revalidatePath("/settings/whatsapp");
  return {
    ok: true,
    message: greeted
      ? `Linked ${groupName || groupId}, and said hello in the group.`
      : `Linked ${groupName || groupId}. Couldn't send the welcome message — check the WhatsApp service.`,
  };
}

export async function unlinkGroupAction(
  _prev: GroupState,
  formData: FormData
): Promise<GroupState> {
  await requireUser(ADMIN_ROLES);
  const groupId = String(formData.get("group_id") || "").trim();
  if (!groupId) return { ok: false, error: "Missing group." };

  await unlinkGroup(groupId);
  revalidatePath("/settings/whatsapp");
  return { ok: true, message: "Unlinked. Replies from that group will no longer be matched." };
}

/** Force the service to re-establish its WhatsApp session. */
export async function reconnectWhatsAppAction(
  _prev: GroupState,
  _formData: FormData
): Promise<GroupState> {
  await requireUser(ADMIN_ROLES);
  const result = await reconnectService();
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/settings/whatsapp");
  return {
    ok: true,
    message: result.connected
      ? "Reconnected."
      : "Reconnecting — if a QR code appears below, scan it from your phone.",
  };
}
