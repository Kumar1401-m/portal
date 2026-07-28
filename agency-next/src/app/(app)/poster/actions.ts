"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute } from "@/lib/db";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { notifyAdmins } from "@/lib/notify";

export type PosterState = { ok: boolean; error?: string };

/** Poster designer submits (or updates) the finished design link. */
export async function submitPosterDesign(
  _prev: PosterState,
  formData: FormData
): Promise<PosterState> {
  const user = await requireUser(STAFF_ROLES);
  const id = Number(formData.get("deliverable_id"));
  const link = String(formData.get("link") || "").trim();
  const note = String(formData.get("note") || "").trim();

  if (!id) return { ok: false, error: "Missing task." };
  if (!/^https?:\/\/.+/i.test(link)) return { ok: false, error: "Enter a valid design link (https://…)." };

  // Service tag is authoritative; legacy rows still match on video_type.
  const d = await queryOne<{ id: number; assigned_to: number | null; title: string }>(
    `SELECT id, assigned_to, title FROM deliverables
     WHERE id = ? AND (service = 'poster_designing' OR (service IS NULL AND video_type = 'Poster'))`,
    [id]
  );
  if (!d) return { ok: false, error: "Poster not found." };
  if (user.role === "poster_designer" && d.assigned_to !== user.id) {
    return { ok: false, error: "This task is not assigned to you." };
  }

  await execute(
    "UPDATE deliverables SET edited_link = ?, status = 'caption_ready', reject_reason = NULL, approval_status = 'pending' WHERE id = ?",
    [link, id]
  );
  if (note) {
    await execute(
      "INSERT INTO feedback (deliverable_id, author_id, author_role, message) VALUES (?,?,?,?)",
      [id, user.id, user.role, note]
    );
  }
  await notifyAdmins(
    "general",
    "🎨 Poster design ready",
    `${user.name} submitted the poster for "${d.title}".`,
    `/deliverables/${id}`
  );

  revalidatePath("/poster");
  revalidatePath("/today");
  revalidatePath(`/deliverables/${id}`);
  return { ok: true };
}
