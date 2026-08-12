"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { syncAllAds, adsReadiness } from "@/lib/ads";

export type SyncState = {
  ok: boolean;
  message?: string;
  /**
   * Per-client failures, named, each with what to do about it.
   *
   * Meta's own message is kept because it is precise and searchable, but on
   * its own it names the symptom: "#200 Ad account owner has NOT grant
   * ads_read" reads as "go and ask the client", when almost always the token
   * is simply the wrong kind and there is nobody to ask.
   */
  failures?: { client: string; error: string; hint?: string }[];
};

/**
 * Pull the last four weeks from Meta, now.
 *
 * The nightly job does this on its own; this is the button for when someone is
 * looking at the board and wants to be sure of what they are reading.
 *
 * Failures are reported per client rather than rolled into "sync failed",
 * because that is where the fix is: one client's ad account needs `ads_read`,
 * or their token has expired, and the other nine are fine.
 */
export async function syncAdsAction(): Promise<SyncState> {
  await requireUser(ADMIN_ROLES);

  const readiness = await adsReadiness();
  if (!readiness.ready) return { ok: false, message: readiness.reason };

  const r = await syncAllAds();
  revalidatePath("/ads");

  if (r.synced === 0 && r.failures.length === 0) {
    return { ok: true, message: "No client has a Meta ad account connected yet." };
  }
  return {
    ok: r.failures.length === 0,
    message:
      `Refreshed ${r.synced} client${r.synced === 1 ? "" : "s"}, ${r.rows} day` +
      `${r.rows === 1 ? "" : "s"} of data.`,
    failures: r.failures.length ? r.failures : undefined,
  };
}
