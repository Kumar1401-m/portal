"use server";

import { revalidatePath } from "next/cache";
import { queryOne } from "@/lib/db";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { setTaskDate } from "@/lib/task-plan";

export type TaskDateState = { ok?: boolean; error?: string };

/**
 * Move one task's date, from wherever the task is shown.
 *
 * There was already a way to do this and it was in one place: the client's
 * monthly plan. Moving a task meant leaving the board you were on, opening the
 * client, finding the month, finding the row — for a change that is a day
 * either way and is made constantly, because dates slip. Every other board in
 * the portal showed the date and offered nothing to do about it.
 *
 * So this takes a task id and nothing else. The old action took a `client_id`
 * from the form and checked access against that, which only works on a page
 * that is already about one client; the client is read off the task here, so
 * the same control works on Today, on the board, and in a report.
 *
 * `setTaskDate` does the work — the same function the plan has always used, so
 * a date moved here and a date moved there mean the same thing: the due date,
 * the month it counts towards, and the posting slot shifted by the same number
 * of days rather than left behind on the old evening.
 */
export async function moveTaskDateAction(
  _prev: TaskDateState,
  formData: FormData
): Promise<TaskDateState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  const taskId = Math.trunc(Number(formData.get("task_id")));
  if (!taskId) return { error: "Missing task." };

  const d = await queryOne<{ client_id: number }>(
    "SELECT client_id FROM deliverables WHERE id = ?",
    [taskId]
  );
  if (!d) return { error: "That task no longer exists." };
  if (!(await canAccessClient(user, d.client_id))) return { error: "Not your client." };

  const raw = String(formData.get("due_date") || "").trim();
  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: "That date isn't valid." };

  const done = await setTaskDate(taskId, raw || null);
  if (!done) return { error: "Could not change the date." };

  /*
   * Every board that shows a date, because the point of this control is that
   * it works from all of them — and a date that changes on the page you are
   * looking at and not on the one you go to next reads as a lost edit.
   */
  revalidatePath("/deliverables");
  revalidatePath("/today");
  revalidatePath("/dashboard");
  revalidatePath("/my-work");
  revalidatePath(`/clients/${d.client_id}`);
  revalidatePath(`/deliverables/${taskId}`);
  return { ok: true };
}
