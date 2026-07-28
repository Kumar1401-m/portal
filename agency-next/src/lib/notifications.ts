/** Notification read queries. */
import "server-only";
import { query, queryOne } from "./db";

export type NotificationRow = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  is_read: number;
  created_at: string;
  /** Resolved from the linked task so the row can carry its service colour. */
  service: string | null;
  video_type: string | null;
};

/**
 * Notifications link to a task as `…/content/<id>` or `…/deliverables/<id>`.
 * Resolve that id back to its task so each row can be tinted with the service
 * colour — same colour language as the task lists.
 */
export async function getNotifications(userId: number, limit = 12): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `SELECT n.id, n.type, n.title, n.body, n.link, n.is_read, n.created_at,
            d.service, d.video_type
     FROM notifications n
     LEFT JOIN deliverables d
       ON n.link REGEXP '/(content|deliverables)/[0-9]+$'
      AND d.id = CAST(SUBSTRING_INDEX(n.link, '/', -1) AS UNSIGNED)
     WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ${Number(limit)}`,
    [userId]
  );
}

export async function getUnreadCount(userId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0",
    [userId]
  );
  return Number(row?.n ?? 0);
}
