/** Poster workflow queries (deliverables where video_type = 'Poster'). */
import "server-only";
import { onTheFloor } from "./client-status";
import { query } from "./db";
import type { SessionUser } from "./auth";
import { DONE_STATUSES } from "./constants";

export type PosterRow = {
  id: number;
  title: string;
  status: string;
  edited_link: string | null;
  reject_reason: string | null;
  /** What goes on the poster, written by the super admin before it was shared. */
  description: string | null;
  due_date: string | null;
  assigned_to: number | null;
  service: string | null;
  video_type: string | null;
  content_category: string | null;
  company_name: string;
  designer_name: string | null;
};

/**
 * Posters, scoped to the designer's own tasks (admins see all).
 * Matches on the service tag, with the legacy `video_type = 'Poster'` rule kept
 * as a fallback for rows created before the service taxonomy existed.
 */
export async function getPosters(user: SessionUser): Promise<PosterRow[]> {
  const conds = [
    "(d.service = 'poster_designing' OR (d.service IS NULL AND d.video_type = 'Poster'))",
  ];
  const params: (string | number)[] = [];
  if (user.role === "poster_designer") {
    conds.push("d.assigned_to = ?");
    params.push(user.id);
  } else {
    conds.push(onTheFloor());
  }
  return query<PosterRow>(
    `SELECT d.id, d.title, d.status, d.edited_link, d.reject_reason, d.due_date,
            d.assigned_to, d.service, d.video_type, d.content_category, d.description,
            c.company_name, u.name AS designer_name
     FROM deliverables d
     JOIN clients c ON c.id = d.client_id
     LEFT JOIN users u ON u.id = d.assigned_to
     WHERE ${conds.join(" AND ")}
     ORDER BY d.due_date IS NULL, d.due_date ASC, d.id DESC
     LIMIT 200`,
    params
  );
}

export const posterDone = (status: string) => DONE_STATUSES.includes(status as never);
export const posterInReview = (status: string) => ["caption_ready", "review"].includes(status);

/**
 * The content is still being written, or is with the client.
 *
 * Not the designer's yet. A poster starts as a brief the super admin writes
 * and the client approves; only then is there anything to design. The
 * designer's queue used to include these, so a poster appeared on their screen
 * before its copy existed — and designing from a blank brief means designing
 * twice.
 */
export const posterAwaitingContent = (status: string) =>
  ["pending", "content_review"].includes(status);

/**
 * The designer's turn: content approved, poster not yet submitted.
 *
 * `waiting_for_raw` is where the content gate leaves a task. On a video that
 * means "we need the footage"; on a poster there is no footage, so it simply
 * means the brief is signed off and the design can start.
 */
export const posterWithDesigner = (status: string) =>
  ["waiting_for_raw", "raw_uploaded", "editing", "changes_requested", "resolved"].includes(status);
