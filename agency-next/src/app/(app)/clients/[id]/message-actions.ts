"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { execute, hasColumn } from "@/lib/db";
import { MESSAGE_KINDS, type MessageKind } from "@/lib/client-messages";

export type PrefState = { ok?: boolean; error?: string; message?: string };

/**
 * Which kinds of message this client is sent.
 *
 * The client id comes from the browser, so access is checked against *that*
 * client rather than against whichever page the form was on — otherwise a crm
 * could silence another agency client by editing one hidden field.
 *
 * Columns that have not been applied yet are skipped rather than failed on, so
 * this screen works on a database mid-migration and simply saves less.
 */
export async function saveMessagePrefsAction(
  _prev: PrefState,
  formData: FormData
): Promise<PrefState> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);

  const clientId = Math.trunc(Number(formData.get("client_id")));
  if (!clientId) return { error: "No client to save." };
  if (!(await canAccessClient(user, clientId))) {
    return { error: "That isn't one of your clients." };
  }

  const on = MESSAGE_KINDS.map((k) => k.key).filter(
    (key) => formData.get(`m_${key}`) === "1"
  ) as MessageKind[];

  const sets: string[] = [];
  const values: number[] = [];
  const missing: string[] = [];
  for (const k of MESSAGE_KINDS) {
    if (!(await hasColumn("clients", k.column).catch(() => false))) {
      missing.push(k.label);
      continue;
    }
    sets.push(`${k.column} = ?`);
    values.push(on.includes(k.key) ? 1 : 0);
  }
  if (!sets.length) {
    return { error: "None of these are applied yet — Settings → Database → Apply." };
  }

  await execute(`UPDATE clients SET ${sets.join(", ")} WHERE id = ?`, [...values, clientId]);
  revalidatePath(`/clients/${clientId}`);

  /*
   * Said, not swallowed.
   *
   * Some of these switches are older than others, and a database that has not
   * had the newer columns applied saves the ones it has and silently drops the
   * rest — which then spring back to ticked on the next render, because a
   * missing column reads as "on". That is indistinguishable from a broken
   * save, and it was reported as exactly that.
   */
  if (missing.length) {
    return {
      error:
        `Saved what it could. ${missing.join(", ")} could not be saved and will ` +
        "stay on — those columns are not applied yet. Settings → Database → Apply.",
    };
  }

  /*
   * Said out loud when everything is off, because it is a real state and a
   * quiet one: the work carries on exactly as before and this client simply
   * hears nothing about it until somebody looks at this screen again.
   */
  return {
    ok: true,
    message: on.length
      ? `Saved — ${on.length} of ${MESSAGE_KINDS.length} on.`
      : "Saved — we now send this client nothing automatically.",
  };
}
