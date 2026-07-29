"use server";

import { revalidatePath } from "next/cache";
import { query, queryOne, execute } from "@/lib/db";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { monthKey } from "@/lib/utils";

export type ClientBoardTask = {
  id: number;
  title: string;
  service: string | null;
  video_type: string | null;
  content_category: string | null;
  status: string;
  due_date: string | null;
  scheduled_at: string | null;
  month_key: string | null;
  assigned_to: number | null;
  assignee_name: string | null;
};

export type ClientBoard = {
  client_id: number;
  company_name: string;
  month: string;
  /** Monthly targets, so the tallies read as done-of-target. */
  video_target: number;
  poster_target: number;
  videos_done: number;
  videos_total: number;
  posters_done: number;
  posters_total: number;
  approved: number;
  total: number;
  tasks: ClientBoardTask[];
  assignees: { id: number; name: string }[];
};

const DONE = "('approved','scheduled','posted','completed')";
/** Matches `serviceOf()` — rows predating the taxonomy still count correctly. */
const IS_POSTER = `(COALESCE(NULLIF(d.service,''),
  IF(LOWER(COALESCE(d.video_type,'')) = 'poster','poster_designing','video_editing')) = 'poster_designing')`;

/**
 * Everything about one client's workload, for the panel inside a task's editor:
 * this month's tallies against target, plus the client's tasks and their dates.
 *
 * Lazily called when that panel is opened, so the task list itself doesn't pay
 * for data most people never look at.
 */
export async function getClientBoard(clientId: number): Promise<ClientBoard | null> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const id = Math.trunc(Number(clientId));
  if (!id || !(await canAccessClient(user, id))) return null;

  const month = monthKey();

  const client = await queryOne<{
    id: number;
    company_name: string;
    monthly_deliverables: number | null;
    monthly_posters: number | null;
  }>(
    "SELECT id, company_name, monthly_deliverables, monthly_posters FROM clients WHERE id = ?",
    [id]
  );
  if (!client) return null;

  const tally = await queryOne<Record<string, unknown>>(
    `SELECT
       COALESCE(COUNT(d.id),0) AS total,
       COALESCE(SUM(d.status IN ${DONE}),0) AS approved,
       COALESCE(SUM(NOT ${IS_POSTER}),0) AS videos_total,
       COALESCE(SUM(NOT ${IS_POSTER} AND d.status IN ${DONE}),0) AS videos_done,
       COALESCE(SUM(${IS_POSTER}),0) AS posters_total,
       COALESCE(SUM(${IS_POSTER} AND d.status IN ${DONE}),0) AS posters_done
     FROM deliverables d
     WHERE d.client_id = ? AND d.month_key = ? AND d.status NOT IN ('cancelled','rejected')`,
    [id, month]
  );

  const tasks = await query<ClientBoardTask>(
    `SELECT d.id, d.title, d.service, d.video_type, d.content_category, d.status,
            d.due_date, d.scheduled_at, d.month_key, d.assigned_to, u.name AS assignee_name
       FROM deliverables d
       LEFT JOIN users u ON u.id = d.assigned_to
      WHERE d.client_id = ?
      ORDER BY (d.due_date IS NULL), d.due_date DESC, d.id DESC
      LIMIT 100`,
    [id]
  );

  const assignees = await query<{ id: number; name: string }>(
    `SELECT id, name FROM users
      WHERE is_active = 1 AND role IN ('super_admin','admin','poster_designer','crm')
      ORDER BY name`
  );

  const n = (v: unknown) => Number(v ?? 0);
  return {
    client_id: client.id,
    company_name: client.company_name,
    month,
    video_target: n(client.monthly_deliverables),
    poster_target: n(client.monthly_posters),
    videos_done: n(tally?.videos_done),
    videos_total: n(tally?.videos_total),
    posters_done: n(tally?.posters_done),
    posters_total: n(tally?.posters_total),
    approved: n(tally?.approved),
    total: n(tally?.total),
    tasks,
    assignees,
  };
}

export type QuickUpdateState = { ok: boolean; error?: string; savedId?: number };

/**
 * Change a task's date and owner from the client board.
 *
 * Deliberately limited to scheduling fields: status moves stay in the workflow
 * controls, which enforce the approval gates and tell the client. Being able to
 * flip a task to "approved" from a grid would walk straight past both.
 */
export async function quickUpdateTask(
  _prev: QuickUpdateState,
  formData: FormData
): Promise<QuickUpdateState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const id = Math.trunc(Number(formData.get("task_id")));
  if (!id) return { ok: false, error: "Missing task." };

  const d = await queryOne<{ client_id: number }>(
    "SELECT client_id FROM deliverables WHERE id = ?",
    [id]
  );
  if (!d) return { ok: false, error: "That task no longer exists." };
  if (!(await canAccessClient(user, d.client_id))) return { ok: false, error: "Not your client." };

  const dueRaw = String(formData.get("due_date") || "").trim();
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : null;
  if (dueRaw && !dueDate) return { ok: false, error: "That date isn't valid." };

  const whoRaw = String(formData.get("assigned_to") || "").trim();
  let assignedTo: number | null = null;
  if (whoRaw) {
    assignedTo = Math.trunc(Number(whoRaw));
    const u = await queryOne<{ id: number }>(
      `SELECT id FROM users
        WHERE id = ? AND is_active = 1
          AND role IN ('super_admin','admin','poster_designer','crm')`,
      [assignedTo]
    );
    if (!u) return { ok: false, error: "That team member isn't available." };
  }

  // The month a task counts towards follows its due date, the same rule
  // `createDeliverable` uses — otherwise moving a date would leave the
  // scorecard reporting it in the old month.
  if (dueDate) {
    await execute(
      "UPDATE deliverables SET due_date = ?, month_key = ?, assigned_to = ? WHERE id = ?",
      [dueDate, dueDate.slice(0, 7), assignedTo, id]
    );
  } else {
    await execute("UPDATE deliverables SET due_date = NULL, assigned_to = ? WHERE id = ?", [
      assignedTo,
      id,
    ]);
  }

  revalidatePath("/deliverables");
  revalidatePath("/today");
  revalidatePath("/dashboard");
  return { ok: true, savedId: id };
}
