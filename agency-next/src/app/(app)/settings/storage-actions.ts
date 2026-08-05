"use server";

import { requireUser, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { checkStorage, type CheckStep } from "@/lib/storage-check";

export type StorageCheckState = {
  ran: boolean;
  ok?: boolean;
  steps?: CheckStep[];
  error?: string;
};

/**
 * Run the storage round trip and report which step failed.
 *
 * Super admin only: it writes to the bucket, and the diagnostics name which
 * credential is wrong — useful to whoever is fixing it, and a hint worth
 * withholding from everyone else.
 */
export async function testStorageAction(): Promise<StorageCheckState> {
  await requireUser(SUPER_ADMIN_ROLES);

  try {
    const result = await checkStorage();
    return { ran: true, ok: result.ok, steps: result.steps };
  } catch (err) {
    return {
      ran: true,
      ok: false,
      error: err instanceof Error ? err.message : "The check itself failed to run.",
    };
  }
}
