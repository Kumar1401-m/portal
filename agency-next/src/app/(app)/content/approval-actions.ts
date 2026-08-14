"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { hasColumn, query, execute } from "@/lib/db";
import { sendContentForApproval } from "@/lib/content";
import { notifyUser } from "@/lib/notify";

/**
 * The super admin's two answers to a written brief.
 *
 * Separate from `content/actions.ts` because these are plain form actions on
 * the Approvals rows — no `useActionState`, no returned object, just do it and
 * revalidate. Mixing the two shapes in one file is how a caller ends up
 * awaiting a state that never comes.
 *
 * Both are reserved to the super admin and the client's own crm: one puts
 * something in front of a client, the other releases work past them, and
 * neither is a decision for whoever happened to type the copy.
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

function done() {
  revalidatePath("/approvals");
  revalidatePath("/content");
  revalidatePath("/today");
  revalidatePath("/my-work");
}

/** To the client's WhatsApp group, for them to sign off. */
export async function sendContentToClient(formData: FormData): Promise<void> {
  const id = Number(formData.get("deliverable_id"));
  if (!id) return;
  const found = await loadOne(id);
  if (!found) return;

  const hasSentAt = await hasColumn("deliverables", "content_sent_at");
  // Failure is deliberately quiet here: this is a plain form post with nowhere
  // to render an error, and the row simply stays on the tab — which is the
  // honest outcome, since nothing moved. The content desk carries the same
  // send with a message attached for when the reason matters.
  await sendContentForApproval(found.row.client_id, [id], found.user.id, hasSentAt);
  done();
}

/** Past the client, straight to whoever makes it. */
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
  done();
}
