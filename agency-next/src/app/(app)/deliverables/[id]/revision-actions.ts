"use server";

import { revalidatePath } from "next/cache";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import { canAccessClient } from "@/lib/crm";
import { isEngineOn, modelConfigured } from "@/lib/ai-engines";
import { splitFeedback, saveItems, setItemDone, revisionsReady, type RevisionItem } from "@/lib/revision-tasks";

export type SplitState =
  | { ok: true; items: RevisionItem[] }
  | { ok: false; error: string };

/** The task, and whether this user may touch it. */
async function reachable(deliverableId: number) {
  const user = await requireUser(STAFF_ROLES);
  const d = await queryOne<{ id: number; client_id: number; title: string; video_type: string | null; reject_reason: string | null }>(
    "SELECT id, client_id, title, video_type, reject_reason FROM deliverables WHERE id = ?",
    [deliverableId]
  );
  if (!d) return { user: null, task: null, error: "That task no longer exists." };
  if (!(await canAccessClient(user, d.client_id))) {
    return { user: null, task: null, error: "That task belongs to a client that isn't yours." };
  }
  return { user, task: d, error: null };
}

/**
 * Read the client's feedback and propose a checklist.
 *
 * Proposed, never applied. The items come back to the browser for a person to
 * accept — a model splitting a sentence is language work and it can split it
 * wrongly, and an editor silently handed a job the client did not ask for is
 * the failure this feature would otherwise introduce.
 */
export async function splitFeedbackAction(deliverableId: number): Promise<SplitState> {
  const { task, error } = await reachable(deliverableId);
  if (error || !task) return { ok: false, error: error ?? "Not found." };

  if (!modelConfigured()) {
    return { ok: false, error: "No model key is configured — add GEMINI_API_KEY to switch this on." };
  }
  if (!(await isEngineOn("approval_assistant"))) {
    return { ok: false, error: "That engine is switched off. Turn it back on from the AI page." };
  }
  if (!task.reject_reason?.trim()) {
    return { ok: false, error: "There is no client feedback on this task to split." };
  }

  const items = await splitFeedback(task.reject_reason, {
    title: task.title,
    isPoster: String(task.video_type || "").toLowerCase() === "poster",
  }).catch(() => null);

  return items
    ? { ok: true, items }
    : { ok: false, error: "Nothing usable came back. The feedback is on the task as the client wrote it." };
}

export type SaveState = { ok: boolean; message: string };

export async function saveItemsAction(
  deliverableId: number,
  items: RevisionItem[]
): Promise<SaveState> {
  const { user, error } = await reachable(deliverableId);
  if (error || !user) return { ok: false, message: error ?? "Not found." };
  if (!(await revisionsReady())) {
    return {
      ok: false,
      message: "This needs one database change — a super admin can apply it in Settings → Database.",
    };
  }

  const saved = await saveItems(deliverableId, items, user.id);
  revalidatePath(`/deliverables/${deliverableId}`);
  return saved
    ? { ok: true, message: `${saved} change${saved === 1 ? "" : "s"} on the checklist.` }
    : { ok: false, message: "Nothing to save." };
}

export async function toggleItemAction(
  deliverableId: number,
  itemId: number,
  done: boolean
): Promise<SaveState> {
  const { error } = await reachable(deliverableId);
  if (error) return { ok: false, message: error };

  await setItemDone(itemId, done);
  revalidatePath(`/deliverables/${deliverableId}`);
  return { ok: true, message: done ? "Ticked off." : "Put back." };
}
