/**
 * When footage may be attached to a task, and what attaching it changes.
 *
 * Its own module because four places need these two rules and one of them is
 * a client component: `lib/portal.ts`, where they used to live, is
 * `server-only`, and importing it into the task dialog would fail the build.
 * Same reason `roles.ts` is separate from `auth.ts`.
 *
 * Pure — no database, no request. Both rules are decisions about a status.
 */

/**
 * Statuses footage may still be attached to.
 *
 * `waiting_for_raw` is the case where we asked for it. `pending` is a slot on
 * the month's plan that nobody has asked about yet — and a client who already
 * has the footage should not have to wait to be asked before sending it.
 *
 * The client portal and the WhatsApp handler have always accepted both. The
 * agency's own form accepted only the first, so a link a client had already
 * sent could not be pasted in by the person it was sent to.
 */
export const ACCEPTS_RAW = ["waiting_for_raw", "pending"] as const;

export const acceptsRaw = (status: string): boolean =>
  (ACCEPTS_RAW as readonly string[]).includes(status);

/**
 * What arriving footage does to the task's status — usually nothing.
 *
 * Every path that took a link set `raw_uploaded`, including on a `pending`
 * task. That jumped the content gate: the brief was never written and never
 * approved, the piece vanished from the content desk, and an editor opened it
 * to find footage and no copy.
 *
 * Footage arriving early is a fact about the task, not a stage of it. A piece
 * we asked for footage on is ready to edit once it comes; a slot on the
 * month's plan is still waiting for somebody to write it, whatever the client
 * has already sent.
 *
 * Returns the status to move to, or null to leave it alone.
 */
export function rawUploadStatus(current: string): string | null {
  return current === "waiting_for_raw" ? "raw_uploaded" : null;
}
