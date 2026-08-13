"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { hasColumn, execute, query } from "@/lib/db";
import { sendContentForApproval } from "@/lib/content";
import { notifyUser } from "@/lib/notify";
import { changeStatusAction } from "../deliverables/actions";

export type ContentState = { ok: boolean; error?: string; message?: string };

/** Save one brief without leaving the board. */
export async function saveBriefAction(
  _prev: ContentState,
  fd: FormData
): Promise<ContentState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const id = Number(fd.get("deliverable_id"));
  const body = String(fd.get("description") ?? "").trim();
  if (!id) return { ok: false, error: "Missing task." };

  const row = await query<{ client_id: number }>(
    "SELECT client_id FROM deliverables WHERE id = ?",
    [id]
  );
  if (row.length === 0) return { ok: false, error: "Task not found." };
  if (!(await canAccessClient(user, row[0].client_id))) {
    return { ok: false, error: "Not authorized." };
  }

  await execute("UPDATE deliverables SET description = ? WHERE id = ?", [body || null, id]);
  revalidatePath("/content");
  revalidatePath(`/deliverables/${id}`);
  return { ok: true, message: body ? "Saved." : "Cleared." };
}

/**
 * Send one client's written briefs — all of them, or the one that was ticked.
 *
 * Only a super admin or the client's crm may do this: it is the same rule the
 * two approval gates follow, because it is the same act — putting something in
 * front of a client in their own group.
 */
export async function sendContentAction(
  _prev: ContentState,
  fd: FormData
): Promise<ContentState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (user.role !== "super_admin" && user.role !== "crm") {
    return { ok: false, error: "Only a super admin can send content to a client." };
  }
  const clientId = Number(fd.get("client_id"));
  const ids = fd
    .getAll("ids")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!clientId) return { ok: false, error: "Missing client." };
  if (!(await canAccessClient(user, clientId))) return { ok: false, error: "Not authorized." };

  const hasSentAt = await hasColumn("deliverables", "content_sent_at");
  const res = await sendContentForApproval(clientId, ids, user.id, hasSentAt);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/content");
  revalidatePath("/today");
  revalidatePath("/deliverables");
  return {
    ok: true,
    message:
      res.sent === 1
        ? `Sent to ${res.clientName}'s group. They can reply OK to approve.`
        : `${res.sent} pieces sent to ${res.clientName}'s group in ${res.messages} message${res.messages === 1 ? "" : "s"}. They can reply OK to approve.`,
  };
}

/**
 * Hand the written brief straight to the maker, with no client in between.
 *
 * For a client whose sign-off is switched off on their record. Same place, same
 * button position as the send — the difference is on the client, not in the
 * head of whoever is working through the board.
 */
export async function handToTeamAction(
  _prev: ContentState,
  fd: FormData
): Promise<ContentState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const clientId = Number(fd.get("client_id"));
  const ids = fd
    .getAll("ids")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!clientId || ids.length === 0) return { ok: false, error: "Nothing selected." };
  if (!(await canAccessClient(user, clientId))) return { ok: false, error: "Not authorized." };

  const rows = await query<{
    id: number;
    title: string;
    assigned_to: number | null;
    service: string | null;
    video_type: string | null;
    company_name: string;
  }>(
    `SELECT d.id, d.title, d.assigned_to, d.service, d.video_type, c.company_name
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.client_id = ? AND d.id IN (${ids.join(",")})
        AND d.status = 'pending' AND TRIM(COALESCE(d.description,'')) <> ''`,
    [clientId]
  );
  if (rows.length === 0) return { ok: false, error: "None of these has content written yet." };

  await execute(
    `UPDATE deliverables SET status = 'waiting_for_raw', approval_status = 'pending'
      WHERE id IN (${rows.map((r) => r.id).join(",")})`
  );

  /*
   * One notification per person, not per task.
   *
   * A month handed over at once is fifteen tasks and one designer, and fifteen
   * identical alerts is how somebody turns notifications off.
   */
  const byPerson = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!r.assigned_to) continue;
    const list = byPerson.get(r.assigned_to) ?? [];
    list.push(r);
    byPerson.set(r.assigned_to, list);
  }
  for (const [personId, list] of byPerson) {
    const isPoster =
      list[0].service === "poster_designing" ||
      (!list[0].service && String(list[0].video_type ?? "").toLowerCase() === "poster");
    await notifyUser(
      personId,
      "general",
      isPoster ? "🎨 Posters ready to design" : "✏️ Content ready — over to you",
      list.length === 1
        ? `The content for "${list[0].title}" (${list[0].company_name}) is written and it's yours.`
        : `${list.length} pieces for ${list[0].company_name} are written and ready for you to start.`,
      list.length === 1 ? `/deliverables/${list[0].id}` : "/my-work"
    );
  }

  revalidatePath("/content");
  revalidatePath("/today");
  revalidatePath("/my-work");
  return {
    ok: true,
    message:
      rows.length === 1
        ? "Handed to the team — this client does not sign content off."
        : `${rows.length} pieces handed to the team — this client does not sign content off.`,
  };
}

/**
 * The super admin recording what the client said.
 *
 * Clients answer content in the group, in their own words, and often about
 * several pieces at once — "all good", "change the third one". None of that is
 * a button the client can press, so somebody has to read it and act, and that
 * somebody is the super admin. This is that access.
 *
 * It goes through the same `changeStatusAction` the task page uses, so an
 * approval recorded here is identical to one recorded there — same gate, same
 * trail, same notification to whoever the work belongs to next.
 */
export async function recordContentDecisionAction(
  _prev: ContentState,
  fd: FormData
): Promise<ContentState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (user.role !== "super_admin" && user.role !== "crm") {
    return { ok: false, error: "Only a super admin can approve content on the client's behalf." };
  }
  const decision = String(fd.get("decision") || "");
  if (!["approved", "changes_requested"].includes(decision)) {
    return { ok: false, error: "Unknown decision." };
  }
  const reason = String(fd.get("reason") || "").trim();
  if (decision === "changes_requested" && !reason) {
    return { ok: false, error: "Say what the client asked to be changed." };
  }
  const ids = fd
    .getAll("ids")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  let done = 0;
  let firstError: string | undefined;
  for (const id of ids) {
    const one = new FormData();
    one.set("deliverable_id", String(id));
    one.set("status", decision);
    if (reason) one.set("reason", reason);
    const res = await changeStatusAction({ ok: false }, one);
    if (res.ok) done++;
    else firstError ??= res.error;
  }
  if (done === 0) return { ok: false, error: firstError ?? "Nothing could be updated." };

  revalidatePath("/content");
  revalidatePath("/today");
  revalidatePath("/my-work");
  const what = decision === "approved" ? "approved" : "sent back for changes";
  return {
    ok: true,
    message: `${done} ${done === 1 ? "piece" : "pieces"} ${what}.`,
    ...(firstError ? { error: `Some could not be updated: ${firstError}` } : {}),
  };
}
