"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_ROLES, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds, canAccessClient } from "@/lib/crm";
import { refreshInsights, insightsReady } from "@/lib/ai-insights";
import { ask } from "@/lib/brain";
import { setEngine, type EngineKey } from "@/lib/ai-engines";
import { recordRun } from "@/lib/automation-runs";

export type RefreshState = { ok: boolean; message: string };

/**
 * Re-run the analysis across every client this user can see.
 *
 * Several queries per client, so it is a button and a scheduled job rather
 * than something a page render triggers — a dashboard that recomputed two
 * months of history for twenty clients on every visit is a dashboard people
 * stop opening.
 */
export async function refreshInsightsAction(): Promise<RefreshState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  if (!(await insightsReady())) {
    return {
      ok: false,
      message: "The ai_insights table isn't in this database yet — apply the pending changes in Settings → Database.",
    };
  }

  const scope = await crmClientIds(user);
  const r = await refreshInsights(scope ?? undefined);
  await recordRun("ai_insights", true, `${r.found} findings across ${r.clients} clients`).catch(() => {});

  revalidatePath("/ai");
  return {
    ok: true,
    message:
      `Looked at ${r.clients} client${r.clients === 1 ? "" : "s"} — ${r.found} finding${r.found === 1 ? "" : "s"}` +
      (r.cleared ? `, and cleared ${r.cleared} that no longer apply.` : "."),
  };
}

export type AskState = { ok: boolean; text: string; narrated?: boolean };

/** Ask the Brain about one client. Scoped like every other client read. */
export async function askBrainAction(clientId: number, question: string): Promise<AskState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (!(await canAccessClient(user, clientId))) {
    return { ok: false, text: "That client isn't one of yours." };
  }
  const q = question.trim();
  if (!q) return { ok: false, text: "Ask something about this client's month." };

  const answer = await ask(clientId, q);
  if (!answer) return { ok: false, text: "No such client." };
  return { ok: true, text: answer.text, narrated: answer.narrated };
}

/** Switch one engine on or off. Super admin and admin only. */
export async function setEngineAction(key: EngineKey, on: boolean): Promise<RefreshState> {
  await requireUser(ADMIN_ROLES);
  await setEngine(key, on);
  revalidatePath("/ai");
  return { ok: true, message: on ? "Switched on." : "Switched off." };
}
