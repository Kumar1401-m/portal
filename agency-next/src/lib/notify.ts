/**
 * Notification writers (server-only). Insert in-app notifications and,
 * optionally, mirror by email. All fire-and-forget safe — never throw.
 */
import "server-only";
import { execute, query } from "./db";
import { sendNotificationEmail } from "./email";

export async function notifyUser(
  userId: number,
  type: string,
  title: string,
  body: string,
  link: string | null = null,
  email: string | null = null
): Promise<void> {
  try {
    await execute("INSERT INTO notifications (user_id, type, title, body, link) VALUES (?,?,?,?,?)", [
      userId,
      type,
      title,
      body,
      link,
    ]);
    if (email) sendNotificationEmail(email, title, body, link).catch(() => {});
  } catch (err) {
    console.warn("notifyUser failed:", err instanceof Error ? err.message : err);
  }
}

/** Notify every active admin + super admin. */
export async function notifyAdmins(
  type: string,
  title: string,
  body: string,
  link: string | null = null
): Promise<void> {
  try {
    const admins = await query<{ id: number; email: string | null }>(
      "SELECT id, email FROM users WHERE role IN ('admin','super_admin') AND is_active = 1"
    );
    await Promise.all(admins.map((a) => notifyUser(a.id, type, title, body, link, a.email)));
  } catch (err) {
    console.warn("notifyAdmins failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Notify the login user attached to a client. Pass mail=false when the caller
 * sends its own formal email, to avoid a duplicate generic copy.
 */
export async function notifyClientById(
  clientId: number,
  type: string,
  title: string,
  body: string,
  link: string | null = null,
  mail = true
): Promise<void> {
  try {
    const rows = await query<{ id: number; email: string | null }>(
      `SELECT u.id, u.email FROM clients c JOIN users u ON u.id = c.user_id
       WHERE c.id = ? AND u.is_active = 1`,
      [clientId]
    );
    if (rows.length) {
      await notifyUser(rows[0].id, type, title, body, link, mail ? rows[0].email : null);
    }
  } catch (err) {
    console.warn("notifyClientById failed:", err instanceof Error ? err.message : err);
  }
}
