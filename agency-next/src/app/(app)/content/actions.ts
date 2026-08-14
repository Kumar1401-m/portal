"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { hasColumn, execute, query } from "@/lib/db";
import { sendContentForApproval, suggestTitle, isPlaceholderTitle } from "@/lib/content";
import { notifyUser } from "@/lib/notify";
import { changeStatusAction } from "../deliverables/actions";

export type ContentState = {
  ok: boolean;
  error?: string;
  message?: string;
  /** Set when saving also gave the piece a real name, so the row can update. */
  title?: string;
};

/** Save one brief without leaving the board. */
export async function saveBriefAction(
  _prev: ContentState,
  fd: FormData
): Promise<ContentState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const id = Number(fd.get("deliverable_id"));
  const body = String(fd.get("description") ?? "").trim();
  if (!id) return { ok: false, error: "Missing task." };

  const row = await query<{ client_id: number; title: string; company_name: string }>(
    `SELECT d.client_id, d.title, c.company_name
       FROM deliverables d JOIN clients c ON c.id = d.client_id
      WHERE d.id = ?`,
    [id]
  );
  if (row.length === 0) return { ok: false, error: "Task not found." };
  if (!(await canAccessClient(user, row[0].client_id))) {
    return { ok: false, error: "Not authorized." };
  }

  /*
   * The property is saved with the brief, not on its own.
   *
   * They are written in the same breath — you name what the post is about as
   * you write it — and a separate save for a one-line field is a second thing
   * to remember and a second thing to forget.
   *
   * Absent from the form means "leave it alone", so a caller that only sends
   * the copy cannot silently clear it.
   */
  const property = fd.has("campaign") ? String(fd.get("campaign") ?? "").trim() : null;
  if (property === null) {
    await execute("UPDATE deliverables SET description = ? WHERE id = ?", [body || null, id]);
  } else {
    await execute("UPDATE deliverables SET description = ?, campaign = ? WHERE id = ?", [
      body || null,
      property || null,
      id,
    ]);
  }
  /*
   * And a name, once there is something to name it after.
   *
   * The month generator calls them "Video 1..12" before a word is written,
   * because it has to call them something. Those numbers do real work while
   * the month is being planned and none at all afterwards — a board reading
   * "Video 6, Video 7, Video 8" says nothing about what is in any of them,
   * and the client sees these titles in the approval message.
   *
   * Only over a placeholder. A title somebody typed is theirs, and quietly
   * rewriting it would be the portal editing a person's work. Best-effort in
   * every other way too: no model, thin copy, an unusable answer — the old
   * title stays and the save still succeeded, because it did.
   */
  let renamedTo: string | null = null;
  if (body && isPlaceholderTitle(row[0].title)) {
    try {
      const suggested = await suggestTitle(body, row[0].company_name);
      if (suggested) {
        await execute("UPDATE deliverables SET title = ? WHERE id = ?", [suggested, id]);
        renamedTo = suggested;
      }
    } catch (err) {
      console.warn("[content] could not name the piece:", err instanceof Error ? err.message : err);
    }
  }

  revalidatePath("/content");
  revalidatePath("/today");
  revalidatePath("/deliverables");
  revalidatePath(`/deliverables/${id}`);
  return {
    ok: true,
    message: !body ? "Cleared." : renamedTo ? `Saved, and named "${renamedTo}".` : "Saved.",
    ...(renamedTo ? { title: renamedTo } : {}),
  };
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

  /*
   * Who this releases the work to, read before it moves.
   *
   * Approving a client's month is fifteen calls through the gate below and one
   * designer at the end of them, so the per-task alert is suppressed and a
   * single summary sent afterwards instead. Fifteen identical notifications is
   * how somebody turns notifications off.
   *
   * Read first because the statuses change underneath: once approved, these
   * rows no longer match the query that found them.
   */
  const makers =
    decision === "approved"
      ? await query<{ id: number; title: string; assigned_to: number | null; company_name: string }>(
          `SELECT d.id, d.title, d.assigned_to, c.company_name
             FROM deliverables d JOIN clients c ON c.id = d.client_id
            WHERE d.id IN (${ids.join(",")}) AND d.status = 'content_review'`
        )
      : [];

  let done = 0;
  let firstError: string | undefined;
  const settled = new Set<number>();
  for (const id of ids) {
    const one = new FormData();
    one.set("deliverable_id", String(id));
    one.set("status", decision);
    if (reason) one.set("reason", reason);
    // One summary from here beats one alert per piece — see above.
    one.set("quiet", "1");
    const res = await changeStatusAction({ ok: false }, one);
    if (res.ok) {
      done++;
      settled.add(id);
    } else firstError ??= res.error;
  }
  if (done === 0) return { ok: false, error: firstError ?? "Nothing could be updated." };

  // Only what actually moved, grouped by the person it moved to.
  const byPerson = new Map<number, typeof makers>();
  for (const m of makers) {
    if (!m.assigned_to || !settled.has(m.id)) continue;
    const list = byPerson.get(m.assigned_to) ?? [];
    list.push(m);
    byPerson.set(m.assigned_to, list);
  }
  for (const [personId, list] of byPerson) {
    await notifyUser(
      personId,
      "general",
      "✏️ Content approved — over to you",
      list.length === 1
        ? `${list[0].company_name} approved the content for "${list[0].title}". You can start on it.`
        : `${list[0].company_name} approved ${list.length} pieces. They are in your list now.`,
      list.length === 1 ? `/deliverables/${list[0].id}` : "/my-work"
    );
  }

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
