"use server";

import { revalidatePath } from "next/cache";
import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { queryOne, execute } from "@/lib/db";
import { syncMonthToTarget } from "@/lib/task-plan";
import { monthKey } from "@/lib/utils";

export type TargetState = {
  ok?: boolean;
  error?: string;
  /** What the change did to this month's tasks, if anything. */
  note?: string;
};

/** Nobody's contract is this big; a typo in a number field should not create 900 tasks. */
const MAX_TARGET = 200;

/**
 * Change how many videos a client is owed this month, from the dashboard.
 *
 * The number lives on the client record and has always been editable there —
 * four clicks away, on a form with thirty other fields, at the moment someone
 * is looking at the row that made them want to change it. This is the same
 * edit where the question is asked.
 *
 * The month's tasks follow, exactly as they do from the client form: the
 * shortfall is created, surplus placeholders are removed, and anything already
 * being worked on is kept and reported. One path, so the dashboard and the
 * client page cannot mean different things by the same number.
 *
 * Super admin only. It changes what a client is owed, which is a commercial
 * fact, and it creates and deletes work off the back of that.
 */
export async function setMonthlyTarget(
  clientId: number,
  videos: number
): Promise<TargetState> {
  const user = await requireUser(SUPER_ADMIN_ROLES);

  const id = Math.trunc(Number(clientId));
  const target = Math.trunc(Number(videos));
  if (!id) return { error: "Missing client." };
  if (!Number.isFinite(target) || target < 0) return { error: "That isn't a number of videos." };
  if (target > MAX_TARGET) return { error: `${MAX_TARGET} is the most a month can hold.` };

  const client = await queryOne<{ id: number; monthly_deliverables: number | null; status: string }>(
    "SELECT id, monthly_deliverables, status FROM clients WHERE id = ?",
    [id]
  );
  if (!client) return { error: "Client not found." };
  if (Number(client.monthly_deliverables ?? 0) === target) return { ok: true };

  await execute("UPDATE clients SET monthly_deliverables = ? WHERE id = ?", [target, id]);

  let note: string | undefined;
  // An archived client's month is not topped up — the same rule the client
  // form follows, and the reason their tasks were deleted in the first place.
  if (client.status !== "churned") {
    try {
      const r = await syncMonthToTarget(id, monthKey(), user.id);
      const added = r.added.videos + r.added.posters;
      const removed = r.removed.videos + r.removed.posters;
      const parts = [
        added ? `${added} added` : null,
        removed ? `${removed} removed` : null,
        r.blocked ? `${r.blocked} kept (already started)` : null,
      ].filter(Boolean);
      if (parts.length) note = parts.join(", ");
    } catch (err) {
      // The target is saved either way; the top-up can be retried from the plan.
      console.warn("[dashboard] target saved, month not synced:", err instanceof Error ? err.message : err);
      note = "Target saved, but the tasks could not be updated — open the client's plan.";
    }
  }

  for (const p of ["/dashboard", "/clients", `/clients/${id}`, "/deliverables", "/today"]) {
    revalidatePath(p);
  }
  return { ok: true, note };
}
