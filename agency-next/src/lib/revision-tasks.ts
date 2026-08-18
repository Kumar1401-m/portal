/**
 * A client's feedback, turned into things somebody can tick off.
 *
 * "Change the intro, remove that bit about the offer and use a different
 * thumbnail" is three jobs, often for two different people, and it arrives as
 * one sentence in a WhatsApp group. What happened before was that an editor
 * read it, did two of the three, and the third came back a week later as a
 * complaint.
 *
 * This is the one place in the studio where a model is genuinely required:
 * splitting a sentence into its parts is language work, not arithmetic. So the
 * boundary is drawn tightly instead.
 *
 *   - It only ever **splits**. It is told to use the client's own words and
 *     never to add a job they did not ask for, because an invented revision is
 *     work the agency does for free and a change the client did not want.
 *   - Nothing is applied automatically. The items appear as a checklist for a
 *     person to accept, and the client's original message stays on the task
 *     word for word beside them.
 *   - A failed or empty reply produces nothing, never a guess.
 */
import "server-only";
import { query, execute, hasTable } from "./db";
import { callJSON } from "./ai";
import { ASSIGNABLE_ROLES } from "./roles";
// The shape lives next door so the checklist — a client component — can reach
// it without pulling the database driver into the browser bundle.
import type { RevisionItem } from "./revision-kinds";
export type { RevisionItem };

export const revisionsReady = () => hasTable("feedback_items");

const asStr = (v: unknown) => (v == null ? "" : String(v).trim());

/**
 * Split one piece of feedback into its separate jobs.
 *
 * Returns null when the model gives nothing usable — the caller shows the
 * feedback exactly as it arrived, which is what happened before this existed
 * and is never worse than it.
 */
export async function splitFeedback(
  feedback: string,
  context?: { title?: string; isPoster?: boolean }
): Promise<RevisionItem[] | null> {
  const text = feedback.trim();
  if (text.length < 3) return null;

  const { data } = await callJSON(
    [
      "You turn a client's feedback on a piece of creative work into a checklist for the team.",
      "Split it into separate jobs — one per thing they asked for.",
      "Use the client's own words. Never add a job they did not ask for, never soften one, never merge two.",
      "If the feedback is a single job, return one item. If it is only approval or thanks, return an empty list.",
      `Assign each to one of: ${ASSIGNABLE_ROLES.join(", ")} — or null if it is not obvious.`,
      "Reply with JSON only.",
    ].join(" "),
    [
      context?.title ? `The work: ${context.title}${context.isPoster ? " (a poster)" : " (a video)"}` : "",
      `The client said:\n"""\n${text.slice(0, 4000)}\n"""`,
      "",
      "Reply as JSON:",
      '{ "items": [{"title":"short imperative, e.g. Change the intro","detail":"what exactly they asked for","role":"video_editor|poster_designer|null"}] }',
    ]
      .filter(Boolean)
      .join("\n")
  ).catch(() => ({ data: null }));

  if (!data || !Array.isArray(data.items)) return null;

  const items = (data.items as Record<string, unknown>[])
    .map((i) => ({
      title: asStr(i.title).slice(0, 200),
      detail: asStr(i.detail).slice(0, 1000),
      // Only a role this portal actually has. A model naming "designer" or
      // "the editor" must not become a role nobody can be assigned to.
      role: ASSIGNABLE_ROLES.includes(asStr(i.role) as never) ? asStr(i.role) : null,
    }))
    .filter((i) => i.title);

  return items.length ? items : null;
}

/**
 * Save the accepted checklist against the task.
 *
 * Replaces whatever was there for this deliverable: the list is a working
 * checklist for one round of revisions, not a history. What the client
 * actually said is kept on the deliverable itself and is never touched here.
 */
export async function saveItems(
  deliverableId: number,
  items: RevisionItem[],
  createdBy: number
): Promise<number> {
  if (!(await revisionsReady())) return 0;

  await execute("DELETE FROM feedback_items WHERE deliverable_id = ? AND is_done = 0", [
    deliverableId,
  ]);

  let saved = 0;
  for (const i of items) {
    if (!i.title.trim()) continue;
    await execute(
      `INSERT INTO feedback_items (deliverable_id, title, detail, role, created_by)
       VALUES (?,?,?,?,?)`,
      [deliverableId, i.title.slice(0, 200), i.detail.slice(0, 1000) || null, i.role, createdBy]
    );
    saved++;
  }
  return saved;
}

export async function getItems(deliverableId: number): Promise<RevisionItem[]> {
  if (!(await revisionsReady())) return [];
  const rows = await query<Record<string, unknown>>(
    `SELECT id, title, detail, role, is_done FROM feedback_items
      WHERE deliverable_id = ? ORDER BY is_done, id`,
    [deliverableId]
  ).catch(() => []);
  return rows.map((r) => ({
    id: Number(r.id),
    title: String(r.title),
    detail: String(r.detail ?? ""),
    role: r.role ? String(r.role) : null,
    done: Number(r.is_done) === 1,
  }));
}

export async function setItemDone(id: number, done: boolean): Promise<void> {
  await execute("UPDATE feedback_items SET is_done = ? WHERE id = ?", [done ? 1 : 0, id]);
}

/** How much of this round is left, for the badge on the task. */
export async function progress(deliverableId: number): Promise<{ done: number; total: number }> {
  if (!(await revisionsReady())) return { done: 0, total: 0 };
  const rows = await query<{ is_done: number }>(
    "SELECT is_done FROM feedback_items WHERE deliverable_id = ?",
    [deliverableId]
  ).catch(() => []);
  return { done: rows.filter((r) => Number(r.is_done) === 1).length, total: rows.length };
}
