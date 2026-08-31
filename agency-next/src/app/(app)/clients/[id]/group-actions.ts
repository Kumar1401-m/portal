"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { clientForGroup } from "@/lib/whatsapp-approvals";
import { PURPOSES, setGroupPurposes, type Purpose } from "@/lib/whatsapp-groups";

export type PurposeState = { ok?: boolean; error?: string; message?: string };

/**
 * Which of a client's groups gets which kind of message.
 *
 * The group id arrives from the browser, so it is resolved back to its client
 * before anything is written and the caller is checked against that client —
 * not against the client whose page the form happened to be on. Otherwise a
 * crm could re-point another agency client's chats by editing one hidden
 * field.
 */
export async function saveGroupPurposesAction(
  _prev: PurposeState,
  formData: FormData
): Promise<PurposeState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  const groupId = String(formData.get("group_id") || "").trim();
  if (!groupId) return { error: "No group to save." };

  const clientId = await clientForGroup(groupId);
  if (!clientId) return { error: "That group isn't linked to a client any more." };
  if (!(await canAccessClient(user, clientId))) {
    return { error: "That isn't one of your clients." };
  }

  const on = PURPOSES.map((p) => p.key).filter(
    (key) => formData.get(`p_${key}`) === "1"
  ) as Purpose[];

  await setGroupPurposes(groupId, on);
  revalidatePath(`/clients/${clientId}`);

  /*
   * Said plainly rather than as a warning, because it is a legitimate choice:
   * a group that is for nothing is a group we simply stop writing to. The
   * automatic reminders still reach the client through whichever group is
   * ticked — or, if none is, through their default one.
   */
  return {
    ok: true,
    message: on.length ? "Saved." : "Saved — nothing is routed here by choice now.",
  };
}
