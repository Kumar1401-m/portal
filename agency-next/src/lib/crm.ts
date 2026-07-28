/**
 * Scoped, per-client staff access for the "crm" role. A crm user only sees
 * (and can act on) the clients super_admin has explicitly assigned them —
 * assigned from each client's own edit page, not a separate ACL screen.
 */
import "server-only";
import { query, execute } from "./db";
import type { SessionUser } from "./auth";

/** Client ids a crm user can access, or null if unrestricted (any other role). */
export async function crmClientIds(user: SessionUser): Promise<number[] | null> {
  if (user.role !== "crm") return null;
  const rows = await query<{ client_id: number }>(
    "SELECT client_id FROM client_crm_access WHERE crm_user_id = ?",
    [user.id]
  );
  return rows.map((r) => r.client_id);
}

/** True if this user may access the given client (always true unless role is crm). */
export async function canAccessClient(user: SessionUser, clientId: number): Promise<boolean> {
  if (user.role !== "crm") return true;
  const ids = await crmClientIds(user);
  return Boolean(ids?.includes(clientId));
}

/**
 * SQL fragment + params for scoping a query by crm access. Spread the params
 * into your query's parameter array at the position the fragment appears.
 * Returns an always-false condition (not a broken `IN ()`) when a crm user
 * has zero assigned clients.
 */
export function crmScopeSql(
  clientIds: number[] | null,
  column = "client_id"
): { sql: string; params: number[] } {
  if (clientIds === null) return { sql: "1=1", params: [] };
  if (clientIds.length === 0) return { sql: "1=0", params: [] };
  return { sql: `${column} IN (${clientIds.map(() => "?").join(",")})`, params: clientIds };
}

export type CrmUserOption = { id: number; name: string };

/** Active crm-role users — for the assignment multi-select on a client's edit page. */
export async function getCrmUsers(): Promise<CrmUserOption[]> {
  return query<CrmUserOption>(
    "SELECT id, name FROM users WHERE role = 'crm' AND is_active = 1 ORDER BY name"
  );
}

/** Which crm users currently have access to a client (pre-checks the multi-select). */
export async function getClientCrmUserIds(clientId: number): Promise<number[]> {
  const rows = await query<{ crm_user_id: number }>(
    "SELECT crm_user_id FROM client_crm_access WHERE client_id = ?",
    [clientId]
  );
  return rows.map((r) => r.crm_user_id);
}

/** Replace a client's crm access list wholesale — used by the client edit form. */
export async function setClientCrmAccess(clientId: number, crmUserIds: number[]): Promise<void> {
  await execute("DELETE FROM client_crm_access WHERE client_id = ?", [clientId]);
  for (const uid of crmUserIds) {
    await execute(
      "INSERT IGNORE INTO client_crm_access (client_id, crm_user_id) VALUES (?, ?)",
      [clientId, uid]
    );
  }
}
