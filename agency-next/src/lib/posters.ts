/** Poster workflow queries (deliverables where video_type = 'Poster'). */
import "server-only";
import { query } from "./db";
import type { SessionUser } from "./auth";
import { DONE_STATUSES } from "./constants";

export type PosterRow = {
  id: number;
  title: string;
  status: string;
  edited_link: string | null;
  reject_reason: string | null;
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
    conds.push("c.status != 'churned'");
  }
  return query<PosterRow>(
    `SELECT d.id, d.title, d.status, d.edited_link, d.reject_reason, d.due_date,
            d.assigned_to, d.service, d.video_type, d.content_category,
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
