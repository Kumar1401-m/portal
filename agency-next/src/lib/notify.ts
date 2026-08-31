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

/**
 * Notify every active admin + super admin — in the bell.
 *
 * Email is off unless a caller asks for it, and that is the whole change.
 * Every one of these went out as mail as well, to every admin, for every
 * event the portal has: a post published, a poster submitted, a client
 * asking a question, footage arriving, each of the night shift's decisions.
 * An inbox that fills with things already sitting in the bell is an inbox
 * that stops being read, and the one message that did need answering — a
 * client's reel that failed to publish — arrived looking like all of them.
 *
 * `notifyClientById` below has always had this flag. Admins were the ones
 * with no way to turn it off.
 */
export async function notifyAdmins(
  type: string,
  title: string,
  body: string,
  link: string | null = null,
  /** True only for something that needs a person who is not looking at the portal. */
  mail = false
): Promise<void> {
  try {
    const admins = await query<{ id: number; email: string | null }>(
      "SELECT id, email FROM users WHERE role IN ('admin','super_admin') AND is_active = 1"
    );
    await Promise.all(
      admins.map((a) => notifyUser(a.id, type, title, body, link, mail ? a.email : null))
    );
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
  /*
   * Off, and this is the whole rule for client email now.
   *
   * Asked for directly: a client gets one email, when they are onboarded, and
   * after that the portal and WhatsApp carry everything. This defaulted to
   * true, so every portal notification — approvals, status changes, payments —
   * also became an email. That is the pile that made a client stop reading
   * them.
   *
   * Left as a parameter rather than removed: onboarding is a real exception,
   * and a caller that genuinely needs to mail somebody should have to say so
   * in its own line rather than inherit it.
   */
  mail = false
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
