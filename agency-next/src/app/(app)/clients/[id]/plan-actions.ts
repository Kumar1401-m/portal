"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { queryOne } from "@/lib/db";
import {
  generateMonthTasks,
  shiftMonthDates,
  setTaskDate,
  safeMonth,
  removeTasks,
} from "@/lib/task-plan";

export type PlanState = {
  ok?: boolean;
  error?: string;
  message?: string;
  /**
   * Some tasks were left only because work had started on them.
   *
   * Distinct from a plain failure: it means the override would work, so the
   * panel can offer it. Nothing else should — a removal that found nothing
   * there must not invite someone to try harder.
   */
  blockedOnly?: boolean;
};

/**
 * Every action here takes the client id from the form, so each one re-checks
 * it. A crm may only touch their own clients, and the page having rendered is
 * not proof of that — the form can be replayed against any id.
 */
async function guard(formData: FormData) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const clientId = Math.trunc(Number(formData.get("client_id")));
  if (!clientId || !(await canAccessClient(user, clientId))) return null;
  return { user, clientId };
}

const refresh = (clientId: number) => {
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/deliverables");
  revalidatePath("/dashboard");
  revalidatePath("/today");
};

/** Fill the month up to the client's monthly targets. */
export async function generateMonthAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't add tasks for this client." };

  const month = safeMonth(String(formData.get("month") || ""));
  try {
    const made = await generateMonthTasks(ok.clientId, month, ok.user.id);
    refresh(ok.clientId);
    const total = made.videos + made.posters;
    if (total === 0) {
      return { ok: true, message: "This month already has everything the plan asks for." };
    }
    const bits = [
      made.videos ? `${made.videos} video${made.videos > 1 ? "s" : ""}` : "",
      made.posters ? `${made.posters} poster${made.posters > 1 ? "s" : ""}` : "",
    ].filter(Boolean);
    return { ok: true, message: `Added ${bits.join(" and ")}.` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not add the tasks." };
  }
}

/** Move a whole month's unfinished tasks forward or back. */
export async function shiftMonthAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't change this client's dates." };

  const month = safeMonth(String(formData.get("month") || ""));
  const days = Math.trunc(Number(formData.get("days")));
  if (!days) return { error: "Enter the number of days to move by." };
  if (Math.abs(days) > 365) return { error: "That's more than a year — use a smaller number." };

  try {
    const moved = await shiftMonthDates(ok.clientId, month, days);
    refresh(ok.clientId);
    if (moved === 0) {
      return { ok: true, message: "Nothing to move — no unfinished tasks with a date this month." };
    }
    const dir = days > 0 ? "later" : "earlier";
    return {
      ok: true,
      message: `Moved ${moved} task${moved > 1 ? "s" : ""} ${Math.abs(days)} day${Math.abs(days) > 1 ? "s" : ""} ${dir}.`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not move the dates." };
  }
}

/** Change one task's due date, from the row it sits on. */
export async function setTaskDateAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't change this task." };

  const taskId = Math.trunc(Number(formData.get("task_id")));
  const raw = String(formData.get("due_date") || "").trim();

  // The task must belong to the client this form was checked against,
  // otherwise the access check above proves nothing about the row being moved.
  const owns = await queryOne<{ id: number }>(
    "SELECT id FROM deliverables WHERE id = ? AND client_id = ?",
    [taskId, ok.clientId]
  );
  if (!owns) return { error: "That task isn't this client's." };

  try {
    const done = await setTaskDate(taskId, raw || null);
    if (!done) return { error: "Could not change the date." };
    refresh(ok.clientId);
    return { ok: true, message: raw ? "Date changed." : "Date cleared." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not change the date." };
  }
}

/**
 * Add or remove an exact number of tasks, ignoring the contract.
 *
 * Separate from Generate on purpose. Generate answers "make this month match
 * what they pay for" and is safe to press twice; this answers "give me three
 * more", which is a different question and must not be idempotent.
 */
export async function adjustTasksAction(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const ok = await guard(formData);
  if (!ok) return { error: "You can't change this client's tasks." };

  const month = safeMonth(String(formData.get("month") || ""));
  const kind = String(formData.get("kind") || "video") === "poster" ? "poster" : "video";
  const direction = String(formData.get("direction") || "add");
  const count = Math.trunc(Number(formData.get("count")));

  if (!Number.isFinite(count) || count < 1) return { error: "Enter how many." };
  if (count > 50) return { error: "That's more than 50 — do it in smaller batches." };

  /*
   * Deleting work that has been started, on purpose.
   *
   * Only a super admin, and only when the form says so — the checkbox is
   * rendered after a refusal, so it cannot be the accidental first choice. A
   * crm removing tasks for their own client still gets the safe behaviour.
   */
  const includeStarted =
    Boolean(formData.get("include_started")) && ok.user.role === "super_admin";

  try {
    if (direction === "remove") {
      const { removed, blocked, startedRemoved } = await removeTasks(
        ok.clientId,
        month,
        kind,
        count,
        { includeStarted }
      );
      refresh(ok.clientId);
      if (!removed) {
        return {
          // `blockedOnly` is what makes the override appear: the caller needs
          // to know this failed because of the safety rule and not because
          // there was nothing there.
          blockedOnly: blocked > 0,
          error:
            "Nothing could be removed — the remaining ones have footage, a video, a caption, " +
            "or have already gone to the client.",
        };
      }
      return {
        ok: true,
        blockedOnly: blocked > 0,
        message:
          `Removed ${removed} ${kind}${removed > 1 ? "s" : ""}` +
          (startedRemoved ? `, ${startedRemoved} of them already started` : "") +
          "." +
          (blocked ? ` ${blocked} were left: they have work on them already.` : ""),
      };
    }

    const made = await generateMonthTasks(
      ok.clientId,
      month,
      ok.user.id,
      kind === "poster" ? { videos: 0, posters: count } : { videos: count, posters: 0 }
    );
    refresh(ok.clientId);
    const n = kind === "poster" ? made.posters : made.videos;
    return { ok: true, message: `Added ${n} ${kind}${n > 1 ? "s" : ""}.` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not change the tasks." };
  }
}
