/** Team (staff user) reads for Settings → Team. */
import "server-only";
import { query } from "./db";

export type TeamMember = {
  id: number;
  name: string;
  email: string;
  role: string;
  is_active: number;
  created_at: string;
  open_tasks: number;
};

/** Staff accounts (clients live in the Clients module, not here). */
export async function getTeam(): Promise<TeamMember[]> {
  const rows = await query<TeamMember>(
    `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
       COALESCE((SELECT COUNT(*) FROM deliverables d
                 WHERE d.assigned_to = u.id
                   AND d.status NOT IN ('posted','completed','cancelled','rejected')),0) AS open_tasks
     FROM users u
     WHERE u.role IN ('super_admin','admin','poster_designer','crm')
     ORDER BY u.is_active DESC, FIELD(u.role,'super_admin','admin','crm','poster_designer'), u.name`
  );
  return rows.map((r) => ({ ...r, open_tasks: Number(r.open_tasks ?? 0) }));
}
