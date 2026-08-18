"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES, ADMIN_ROLES } from "@/lib/auth";
import { execute } from "@/lib/db";
import { createLead, getLead, isStage, isSource, leadsReady, setStage } from "@/lib/leads";

export type LeadState = { ok: boolean; error?: string; message?: string };

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const asDate = (v: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** Money as typed — "₹25,000" and "25000" are the same number. */
const asMoney = (v: string): number => {
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const ready = async (): Promise<LeadState | null> =>
  (await leadsReady())
    ? null
    : {
        ok: false,
        error: "Leads needs one database change — a super admin can apply it in Settings → Database.",
      };

export async function saveLeadAction(_prev: LeadState, fd: FormData): Promise<LeadState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const blocked = await ready();
  if (blocked) return blocked;

  const name = s(fd, "name");
  if (!name) return { ok: false, error: "Who is it? A name is the one thing a lead needs." };

  const phone = s(fd, "phone") || null;
  const email = s(fd, "email") || null;
  if (!phone && !email) {
    // The whole point of the board is following people up, and a lead with no
    // way to reach them is a note, not a lead.
    return { ok: false, error: "Add a phone number or an email — something to follow up on." };
  }

  const stage = s(fd, "stage");
  const source = s(fd, "source");
  const ownerRaw = Number(s(fd, "owner_user_id"));
  const owner = Number.isInteger(ownerRaw) && ownerRaw > 0 ? ownerRaw : null;

  const fields = {
    name,
    company: s(fd, "company") || null,
    phone,
    email,
    source: isSource(source) ? source : "manual",
    stage: isStage(stage) ? stage : ("new" as const),
    value: asMoney(s(fd, "value")),
    ownerId: owner,
    nextFollowUp: asDate(s(fd, "next_follow_up")),
    note: s(fd, "note") || null,
  };

  const id = Number(s(fd, "id"));
  if (Number.isInteger(id) && id > 0) {
    const existing = await getLead(id);
    if (!existing) return { ok: false, error: "That lead no longer exists." };
    await execute(
      `UPDATE leads SET name=?, company=?, phone=?, email=?, source=?, stage=?, value=?,
                        owner_user_id=?, next_follow_up=?, note=?,
                        lost_reason = IF(? = 'lost', lost_reason, NULL)
        WHERE id = ?`,
      [
        fields.name,
        fields.company,
        fields.phone,
        fields.email,
        fields.source,
        fields.stage,
        fields.value,
        fields.ownerId,
        fields.nextFollowUp,
        fields.note,
        fields.stage,
        id,
      ]
    );
    revalidatePath("/leads");
    return { ok: true, message: "Saved." };
  }

  // Unclaimed leads get whoever entered them, which is nearly always right and
  // is always better than nobody.
  await createLead({ ...fields, ownerId: fields.ownerId ?? user.id });
  revalidatePath("/leads");
  return { ok: true, message: `${name} added to the pipeline.` };
}

export async function moveLeadAction(
  id: number,
  stage: string,
  lostReason?: string
): Promise<LeadState> {
  await requireUser(ADMIN_OR_CRM_ROLES);
  const blocked = await ready();
  if (blocked) return blocked;
  if (!isStage(stage)) return { ok: false, error: "Unknown stage." };

  await setStage(id, stage, lostReason);
  revalidatePath("/leads");
  return { ok: true, message: stage === "won" ? "Won 🎉" : "Moved." };
}

/**
 * Push a follow-up out by a number of days.
 *
 * From today rather than from the date it was already on: "next week" means
 * next week from now, and a lead two weeks overdue would otherwise be
 * rescheduled into last week.
 */
export async function snoozeLeadAction(id: number, days: number): Promise<LeadState> {
  await requireUser(ADMIN_OR_CRM_ROLES);
  const blocked = await ready();
  if (blocked) return blocked;

  const d = Math.min(90, Math.max(1, Math.trunc(days) || 1));
  await execute("UPDATE leads SET next_follow_up = DATE_ADD(CURDATE(), INTERVAL ? DAY) WHERE id = ?", [
    d,
    Math.trunc(id),
  ]);
  revalidatePath("/leads");
  return { ok: true, message: `Follow up in ${d} day${d === 1 ? "" : "s"}.` };
}

export async function deleteLeadAction(id: number): Promise<LeadState> {
  // Deleting is a super admin's or admin's call — a crm marks a lead lost,
  // which keeps the reason and keeps it out of the conversion rate's numerator
  // without removing what happened.
  await requireUser(ADMIN_ROLES);
  const blocked = await ready();
  if (blocked) return blocked;

  await execute("DELETE FROM leads WHERE id = ?", [Math.trunc(id)]);
  revalidatePath("/leads");
  return { ok: true, message: "Deleted." };
}
