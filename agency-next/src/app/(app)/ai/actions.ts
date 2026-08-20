"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_ROLES, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds, canAccessClient } from "@/lib/crm";
import { refreshInsights, insightsReady } from "@/lib/ai-insights";
import { ask } from "@/lib/brain";
import { setEngine, isEngineOn, type EngineKey } from "@/lib/ai-engines";
import { recordRun } from "@/lib/automation-runs";
import { advise } from "@/lib/business-advisor";
import { runDecisions } from "@/lib/decisions";

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

export type AdviseState = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * The agency's own month.
 *
 * Admins only, and not because of the model — this is revenue, outstanding
 * invoices and which clients are worth what. A crm is scoped to their own
 * clients everywhere else in the portal and has no business seeing the book.
 */
export async function adviseAction(): Promise<AdviseState> {
  await requireUser(ADMIN_ROLES);
  if (!(await isEngineOn("business_advisor"))) {
    return { ok: false, error: "That engine is switched off. Turn it back on below." };
  }
  const advice = await advise().catch(() => null);
  return advice ? { ok: true, data: advice } : { ok: false, error: "Couldn't read this month's figures." };
}


export type DecideState = { ok: boolean; message: string; sent: string[] };

/**
 * Run the night shift now, rather than waiting for the night.
 *
 * Super admin only, and deliberately: it writes to every admin's
 * notification bell, so it is not something a crm should be able to fire at
 * the whole office from a page they were browsing.
 */
export async function decideNowAction(): Promise<DecideState> {
  await requireUser(ADMIN_ROLES);

  const r = await runDecisions();
  await recordRun(
    "ai_decisions",
    true,
    `${r.sent.length} sent of ${r.considered} considered`
  ).catch(() => {});

  revalidatePath("/ai");
  if (!r.considered) {
    return { ok: true, message: "Nothing needs anybody today — every board is clear.", sent: [] };
  }
  if (!r.sent.length) {
    return {
      ok: true,
      message: `Looked at ${r.considered}, and all of it has already been said this week.`,
      sent: [],
    };
  }
  return {
    ok: true,
    message:
      `${r.sent.length} sent to the bell, out of ${r.considered} considered` +
      (r.skipped ? `, ${r.skipped} already said.` : "."),
    sent: r.sent.map((d) => d.title),
  };
}
