"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_ROLES, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { queryOne } from "@/lib/db";
import { syncAllAds, syncClientAds, adsReadiness } from "@/lib/ads";

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

/**
 * Pull one client's ads from Meta, now.
 *
 * The board's button refreshes everybody, which is what a board wants and the
 * wrong thing to offer from one client's page: it spends a Graph call per
 * client and reports nine other people's token problems to somebody who came
 * to look at one account.
 *
 * The same `syncClientAds` the nightly job and the whole-book refresh both
 * use, so there is no second idea of what refreshing means.
 */
export async function syncOneClientAction(clientId: number): Promise<SyncState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  // A crm may refresh their own clients and no others — the same gate the page
  // itself applies, applied again here, because a server action is reachable
  // without the page.
  if (!clientId || !(await canAccessClient(user, clientId))) {
    return { ok: false, message: "That client isn't yours." };
  }

  const readiness = await adsReadiness();
  if (!readiness.ready) return { ok: false, message: readiness.reason };

  const c = await queryOne<{ company_name: string }>(
    "SELECT company_name FROM clients WHERE id = ?",
    [clientId]
  );
  const r = await syncClientAds(clientId);

  revalidatePath(`/ads/${clientId}`);
  revalidatePath("/ads");

  if (!r.ok) {
    return {
      ok: false,
      message: r.error,
      // Named and hinted in the same shape the board uses, so the button can
      // render either result without knowing which page it is on.
      failures: [{ client: c?.company_name ?? "This client", error: r.error ?? "Refresh failed.", hint: r.hint }],
    };
  }
  return {
    ok: true,
    message: r.rows
      ? `${r.rows} day${r.rows === 1 ? "" : "s"} of data refreshed.`
      : "Meta had nothing new for the last four weeks.",
  };
}
