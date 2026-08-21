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

/**
 * Whether this kind of work waits on the client to send us anything.
 *
 * Only video editing does. A poster is drawn, an ad is bought, a caption is
 * typed — nobody is filming any of them. A poster handed to its designer sits
 * at `waiting_for_raw` because a poster and a video share one status column,
 * and every footage query read that as "blocked on the client": the chase went
 * out asking for rushes that were never going to exist, for a piece already
 * sitting with our own designer. `posterStageLabel` in constants.ts renames
 * that status for reports; this is the same fact, told to the queries.
 *
 * Poster-or-video is decided the way the client board decides it, so the
 * chase, the counts and the progress bars all draw one line. The difference:
 * this asks for video editing specifically, not merely "not a poster" — ads
 * and copywriting have no footage either.
 */
export function needsRawFootageSql(alias = "d"): string {
  const p = alias ? `${alias}.` : "";
  return `(COALESCE(NULLIF(${p}service,''),
    IF(LOWER(COALESCE(${p}video_type,'')) = 'poster','poster_designing','video_editing')) = 'video_editing')`;
}

/** The same question, asked of a row already in hand rather than in SQL. */
export function needsRawFootage(
  service: string | null | undefined,
  videoType?: string | null
): boolean {
  const s =
    service ||
    (String(videoType || "").toLowerCase() === "poster" ? "poster_designing" : "video_editing");
  return s === "video_editing";
}
