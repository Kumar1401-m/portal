"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute } from "@/lib/db";
import { requireUser, POSTER_ROLES, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { notifyAdmins, notifyUser } from "@/lib/notify";
import { canAccessClient } from "@/lib/crm";
import { modelConfigured } from "@/lib/ai-engines";
import { posterContent, renderPosterBrief } from "@/lib/content-ai";
import { posterKind } from "@/lib/content-kinds";

export type PosterState = { ok: boolean; error?: string };

/** Poster designer submits (or updates) the finished design link. */
export async function submitPosterDesign(
  _prev: PosterState,
  formData: FormData
): Promise<PosterState> {
  const user = await requireUser(POSTER_ROLES);
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

/* ------------------- Super admin: content → designer ------------------- */

export type PosterContentState =
  | { ok: true; brief: string }
  | { ok: false; error: string };

/**
 * Draft the words that go on the poster.
 *
 * Drafted, not applied. It comes back to the browser for the super admin to
 * read and edit before anybody designs from it — the whole point of writing
 * the copy centrally is that one person is accountable for what the poster
 * says, and a generated line nobody read is the opposite of that.
 */
export async function draftPosterContentAction(
  deliverableId: number,
  topic: string,
  kind?: string
): Promise<PosterContentState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  const d = await queryOne<{ id: number; client_id: number; title: string }>(
    "SELECT id, client_id, title FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!d) return { ok: false, error: "Poster not found." };
  if (!(await canAccessClient(user, d.client_id))) {
    return { ok: false, error: "That poster belongs to a client that isn't yours." };
  }
  if (!modelConfigured()) {
    return { ok: false, error: "No model key is configured — write the content by hand below." };
  }

  const content = await posterContent(d.client_id, {
    topic: topic.trim() || d.title,
    kind,
  }).catch(() => null);
  if (!content) return { ok: false, error: "Nothing usable came back. Write it by hand below." };

  /*
   * The kind is recorded now, on the draft, not when the poster is shared.
   *
   * This is the decision the portal made, and it has to be written down at the
   * moment it is made — a poster that is drafted, edited by hand and then sent
   * on is still a poster of that kind, and `learning.ts` will read the result
   * back by this key months later.
   */
  await execute("UPDATE deliverables SET content_type = ? WHERE id = ?", [
    posterKind(kind).key,
    d.id,
  ]);

  return { ok: true, brief: renderPosterBrief(content) };
}

/**
 * Hand the poster to the designer.
 *
 * This is the step that was missing. A poster is created at `pending`, and the
 * only thing that ever moved it on was the content-approval desk — so once
 * that came out, every poster sat where it was created and no designer ever
 * saw a submit box. The brief is saved and the status moves to the designer's
 * queue in one action, because a brief with nobody holding it is the same
 * stuck poster with more words on it.
 */
export async function sharePosterWithDesigner(
  _prev: PosterState,
  formData: FormData
): Promise<PosterState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const id = Number(formData.get("deliverable_id"));
  const brief = String(formData.get("brief") || "").trim();

  if (!id) return { ok: false, error: "Missing task." };
  if (brief.length < 10) {
    return { ok: false, error: "Write what goes on the poster first — a designer cannot design a title." };
  }

  const d = await queryOne<{ id: number; client_id: number; title: string; assigned_to: number | null }>(
    `SELECT id, client_id, title, assigned_to FROM deliverables
      WHERE id = ? AND (service = 'poster_designing' OR (service IS NULL AND video_type = 'Poster'))`,
    [id]
  );
  if (!d) return { ok: false, error: "Poster not found." };
  if (!(await canAccessClient(user, d.client_id))) {
    return { ok: false, error: "That poster belongs to a client that isn't yours." };
  }

  /*
   * `waiting_for_raw` is where the designer's queue begins.
   *
   * On a video that status means "we need the footage"; a poster has none, so
   * it reads as "the brief is signed off, start designing". Reusing it keeps
   * one status vocabulary across both kinds of work rather than adding a
   * poster-only status every board would then have to learn.
   */
  await execute(
    "UPDATE deliverables SET description = ?, status = 'waiting_for_raw', reject_reason = NULL WHERE id = ?",
    [brief.slice(0, 4000), id]
  );

  if (d.assigned_to) {
    await notifyUser(
      d.assigned_to,
      "general",
      "🎨 Poster content ready",
      `${user.name} sent you the content for "${d.title}". It's on your dashboard.`,
      `/my-work`
    );
  }

  revalidatePath("/poster");
  revalidatePath("/my-work");
  revalidatePath("/today");
  revalidatePath(`/deliverables/${id}`);
  return { ok: true };
}
