"use server";

import { revalidatePath } from "next/cache";
import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { applyPendingColumns, schemaStatus, type SchemaColumnStatus } from "@/lib/schema-sync";

export type ApplyState = {
  added?: string[];
  failed?: { column: string; error: string }[];
  status?: SchemaColumnStatus[];
  error?: string;
};

/**
 * Add the columns this version of the portal expects. Super admin only — it
 * changes the shape of the database, even if only ever by adding.
 */
export async function applySchemaUpdates(): Promise<ApplyState> {
  await requireUser(SUPER_ADMIN_ROLES);
  try {
    const { added, failed } = await applyPendingColumns();
    // Every page that reads one of these columns behind a hasColumn check.
    for (const p of ["/reports", "/clients", "/deliverables", "/dashboard", "/settings"]) {
      revalidatePath(p);
    }
    return { added, failed, status: await schemaStatus() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not reach the database." };
  }
}
