"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { syncClientAnalytics } from "@/lib/instagram-sync";

export type SyncState = {
  ok: boolean;
  message?: string;
  error?: string;
  warnings?: string[];
};

/**
 * "Analyse now" — pull a client's Instagram history immediately.
 *
 * Exists because the nightly job leaves a newly connected account blank until
 * the next morning, and because the first thing anyone does after entering an
 * account id is look for the numbers.
 *
 * Scoped like every other client action: a crm user can only sync a client
 * they've been given access to.
 */
export async function syncAnalyticsAction(
  _prev: SyncState,
  formData: FormData
): Promise<SyncState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const clientId = Number(formData.get("client_id"));
  if (!clientId) return { ok: false, error: "Pick a client first." };

  if (!(await canAccessClient(user, clientId))) {
    return { ok: false, error: "You don't have access to this client." };
  }

  const result = await syncClientAnalytics(clientId);
  if (!result.ok) return { ok: false, error: result.error };

  const parts = [
    `${result.daysBackfilled ?? 0} day${result.daysBackfilled === 1 ? "" : "s"} of history`,
    `${result.postsStored ?? 0} post${result.postsStored === 1 ? "" : "s"}`,
  ];
  if (result.followers) parts.push(`${result.followers.toLocaleString("en-IN")} followers`);
  if (result.recommendations) parts.push(`${result.recommendations} recommendations`);

  // A corrected id is worth saying out loud — the person pasted one number and
  // we stored a different one, and silently swapping it would be worse than
  // the bug it fixes.
  const corrected = result.correctedId
    ? ` That was a Facebook Page id, so it's been corrected to the Instagram account ${result.correctedId}.`
    : "";

  return {
    ok: true,
    message: `Synced ${result.username ? `@${result.username}` : result.clientName}: ${parts.join(", ")}.${corrected}`,
    warnings: result.warnings?.length ? result.warnings : undefined,
  };
}

/** Same thing, then land the user on that client's dashboard. */
export async function syncAndRevalidate(clientId: number): Promise<void> {
  await syncClientAnalytics(clientId);
  revalidatePath("/analytics");
  revalidatePath(`/clients/${clientId}`);
}
