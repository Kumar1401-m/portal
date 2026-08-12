/** Team (staff user) reads for Settings → Team. */
import "server-only";
import { query, hasColumn } from "./db";
import { STAFF_ROLES, sqlRoleList } from "./roles";

export type TeamMember = {
  id: number;
  name: string;
  email: string;
  role: string;
  is_active: number;
  created_at: string;
  open_tasks: number;
  /** 0 when nobody has set one. Not a target of zero. */
  daily_target: number;
};

/**
 * Every staff account (clients live in the Clients module, not here).
 *
 * The role list used to be written out by hand, and it was written before
 * `video_editor` existed — so an editor never appeared on this page at all.
 * They could be created, they could be assigned work, they showed up on every
 * board, and there was no screen anywhere that could edit, deactivate or
 * delete them. "I removed them and they are still there" is what that looks
 * like from the outside.
 *
 * `STAFF_ROLES` is the definition of staff, so this asks for that rather than
 * keeping a copy that can fall behind it again.
 *
 * Inactive accounts are listed too, sorted after the active ones. Deactivating
 * is not deleting — the row is deliberately still here so it can be turned
 * back on, and so nobody wonders where a name went.
 */
export async function getTeam(): Promise<TeamMember[]> {
  // Feature-gated: the portal has to keep listing the team on a database the
  // migration has not reached.
  const hasTarget = await hasColumn("users", "daily_target");
  const rows = await query<TeamMember>(
    `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
       ${hasTarget ? "u.daily_target" : "0 AS daily_target"},
       COALESCE((SELECT COUNT(*) FROM deliverables d
                 WHERE d.assigned_to = u.id
                   AND d.status NOT IN ('posted','completed','cancelled','rejected')),0) AS open_tasks
     FROM users u
     WHERE u.role IN (${sqlRoleList(STAFF_ROLES)})
     ORDER BY u.is_active DESC,
              FIELD(u.role,'super_admin','admin','crm','video_editor','poster_designer'),
              u.name`
  );
  return rows.map((r) => ({
    ...r,
    open_tasks: Number(r.open_tasks ?? 0),
    daily_target: Number(r.daily_target ?? 0),
  }));
}
