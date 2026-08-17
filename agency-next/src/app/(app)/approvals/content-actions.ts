"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { query, execute } from "@/lib/db";
import { notifyUser } from "@/lib/notify";

/**
 * Releasing a written brief to whoever makes it.
 *
 * This used to be one of two answers. Copy was written, it landed on the
 * Approvals board, and the super admin chose: send it to the client for
 * sign-off, or hand it straight to the team. The client half is gone — the
 * copy is settled inside the agency now and only the finished piece goes to a
 * client — so the choice is gone with it and this is the only way out of the
 * tab.
 *
 * A plain form action rather than `useActionState`: these are buttons on a
 * table row with nowhere to render a returned state, so they do the thing and
 * revalidate.
 *
 * Still reserved to the super admin and the client's own crm. It releases work
 * past a review step, which is not a decision for whoever typed the copy.
 */
async function loadOne(deliverableId: number) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (user.role !== "super_admin" && user.role !== "crm") return null;
  const rows = await query<{
    id: number;
    client_id: number;
    title: string;
    assigned_to: number | null;
    company_name: string;
  }>(
    `SELECT d.id, d.client_id, d.title, d.assigned_to, c.company_name
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ? AND d.status = 'pending' AND TRIM(COALESCE(d.description,'')) <> ''`,
    [deliverableId]
  );
  if (rows.length === 0) return null;
  if (!(await canAccessClient(user, rows[0].client_id))) return null;
  return { user, row: rows[0] };
}

/** Straight to whoever makes it. */
export async function approveContentToTeam(formData: FormData): Promise<void> {
  const id = Number(formData.get("deliverable_id"));
  if (!id) return;
  const found = await loadOne(id);
  if (!found) return;
  const { row } = found;

  await execute(
    "UPDATE deliverables SET status = 'waiting_for_raw', approval_status = 'pending' WHERE id = ?",
    [id]
  );

  if (row.assigned_to) {
    await notifyUser(
      row.assigned_to,
      "general",
      "✏️ Content ready — over to you",
      `The content for "${row.title}" (${row.company_name}) is written and it's yours.`,
      `/deliverables/${id}`
    ).catch(() => {});
  }

  revalidatePath("/approvals");
  revalidatePath("/today");
  revalidatePath("/my-work");
}
