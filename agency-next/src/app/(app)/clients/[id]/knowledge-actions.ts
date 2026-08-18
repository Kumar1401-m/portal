"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { saveKnowledge, knowledgeReady } from "@/lib/knowledge";

export type KnowledgeState = { ok: boolean; error?: string; message?: string };

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/**
 * Save what the agency knows about a client's brand.
 *
 * Open to crm as well as admins: the person who talks to the client every
 * week is the one who knows they say "clients" and never "customers", and a
 * knowledge base only an admin can fill in is one that stays empty.
 */
export async function saveKnowledgeAction(
  _prev: KnowledgeState,
  fd: FormData
): Promise<KnowledgeState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  const clientId = Number(s(fd, "client_id"));
  if (!Number.isInteger(clientId) || clientId <= 0) return { ok: false, error: "Unknown client." };
  if (!(await canAccessClient(user, clientId))) {
    return { ok: false, error: "That client isn't one of yours." };
  }
  if (!(await knowledgeReady())) {
    return {
      ok: false,
      error: "This needs one database change — a super admin can apply it in Settings → Database.",
    };
  }

  await saveKnowledge(
    clientId,
    {
      audience: s(fd, "audience"),
      tone: s(fd, "tone"),
      brandColors: s(fd, "brand_colors"),
      approvedTerms: s(fd, "approved_terms"),
      bannedTerms: s(fd, "banned_terms"),
      restrictions: s(fd, "restrictions"),
      ctas: s(fd, "ctas"),
      notes: s(fd, "notes"),
    },
    user.id
  );

  // The client page shows it, and every caption generated from here on reads
  // it — so the task board's cached pages are stale too.
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/deliverables");
  return { ok: true, message: "Saved. Every caption written from now on will follow it." };
}
