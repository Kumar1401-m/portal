"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { generateForAllClients, safeMonth } from "@/lib/task-plan";

export type BulkPlanState = { ok?: boolean; error?: string; message?: string };

/**
 * Top up every active client's month.
 *
 * Admins only. A crm sees a filtered client list, so running this as one would
 * either quietly create work for clients they cannot see or create a
 * suspiciously partial month; neither is a thing to leave ambiguous, and
 * planning the agency's month is an admin's job anyway.
 */
export async function generateForAllAction(
  _prev: BulkPlanState,
  formData: FormData
): Promise<BulkPlanState> {
  const user = await requireUser(ADMIN_ROLES);
  const month = safeMonth(String(formData.get("month") || ""));

  try {
    const made = await generateForAllClients(month, user.id);
    for (const p of ["/clients", "/deliverables", "/dashboard", "/today"]) revalidatePath(p);

    if (!made.clients && !made.failed) {
      return { ok: true, message: "Every client already has this month's tasks." };
    }
    const bits = [
      made.videos ? `${made.videos} video${made.videos > 1 ? "s" : ""}` : "",
      made.posters ? `${made.posters} poster${made.posters > 1 ? "s" : ""}` : "",
    ].filter(Boolean);
    const tail = made.failed
      ? ` ${made.failed} client${made.failed > 1 ? "s" : ""} could not be filled — open them to see why.`
      : "";
    return {
      ok: true,
      message: `Added ${bits.join(" and ")} across ${made.clients} client${made.clients > 1 ? "s" : ""}.${tail}`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not add the tasks." };
  }
}
