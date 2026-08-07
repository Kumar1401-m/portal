"use server";

import { revalidatePath } from "next/cache";
import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { clearAllVideoData, countVideoData, type ClearSummary } from "@/lib/clear-video-data";

export type ClearState = {
  ok?: boolean;
  error?: string;
  summary?: ClearSummary;
};

/**
 * The phrase that has to be typed to proceed.
 *
 * Not a checkbox: this removes work, approvals and the record of what clients
 * agreed to, and a checkbox is something you tick on the way to somewhere
 * else. Typing the word is a decision.
 */
const CONFIRM = "DELETE";

export async function clearVideoDataAction(
  _prev: ClearState,
  formData: FormData
): Promise<ClearState> {
  // Super admin only — the same bar as changing the database shape.
  await requireUser(SUPER_ADMIN_ROLES);

  const typed = String(formData.get("confirm") || "").trim();
  if (typed !== CONFIRM) {
    return { ok: false, error: `Type ${CONFIRM} to confirm.` };
  }

  try {
    const summary = await clearAllVideoData();
    for (const p of ["/deliverables", "/approvals", "/today", "/dashboard", "/reports", "/settings"]) {
      revalidatePath(p);
    }
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not clear the data." };
  }
}

/** Counts for the confirmation panel, so nobody deletes a number they can't see. */
export async function videoDataCounts(): Promise<{ videos: number; files: number }> {
  await requireUser(SUPER_ADMIN_ROLES);
  return countVideoData();
}
