"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import { syncAllPosts, syncClientPosts, insightsReady } from "@/lib/analytics";

export type SyncState = { ok: boolean; message: string };

/**
 * Pull the numbers from Instagram, now.
 *
 * The nightly job keeps the board current; this is for the moment somebody is
 * looking at a figure with a client on the phone. One client when the board is
 * filtered to one — a full sweep is a Graph call per post per client and there
 * is no reason to spend it to answer a question about one account.
 */
export async function syncInsightsAction(clientId?: number): Promise<SyncState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  if (!(await insightsReady())) {
    return {
      ok: false,
      message: "Analytics needs one database change — a super admin can apply it in Settings → Database.",
    };
  }

  if (clientId) {
    // A crm may only refresh a client they have been assigned. Without this
    // the picker is scoped but the button is not, and any client id typed
    // into the URL would be fetched.
    const allowed = await crmClientIds(user);
    if (allowed && !allowed.includes(clientId)) {
      return { ok: false, message: "That client isn't one of yours." };
    }
    const r = await syncClientPosts(clientId);
    revalidatePath("/analytics");
    return r.ok
      ? { ok: true, message: `Updated ${r.posts} post${r.posts === 1 ? "" : "s"} from Instagram.` }
      : { ok: false, message: r.error ?? "Instagram wouldn't answer." };
  }

  const r = await syncAllPosts();
  revalidatePath("/analytics");
  return {
    ok: r.failed === 0,
    message:
      `Updated ${r.posts} post${r.posts === 1 ? "" : "s"} across ${r.clients} client${r.clients === 1 ? "" : "s"}.` +
      (r.failed ? ` ${r.failed} couldn't be read — check their Instagram token.` : ""),
  };
}
