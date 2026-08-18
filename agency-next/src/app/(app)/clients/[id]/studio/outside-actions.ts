"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { isEngineOn, modelConfigured } from "@/lib/ai-engines";
import {
  listCompetitors,
  addCompetitor,
  removeCompetitor,
  refreshCompetitor,
  compareOne,
  findGaps,
} from "@/lib/competitors";
import { syncComments, classifyPending, getBoard, markHandled, themes } from "@/lib/sentiment";
import type { Comparison, Gap } from "@/lib/comment-kinds";
import type { SentimentBoard } from "@/lib/comment-kinds";

export type Res<T> = { ok: true; data: T } | { ok: false; error: string };

async function gate(clientId: number) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (!(await canAccessClient(user, clientId))) {
    return { user: null, error: "That client isn't one of yours." };
  }
  return { user, error: null };
}

/* ----------------------------- Competitors ----------------------------- */

export type RivalsView = { rows: (Comparison & { id: number })[] };

export async function rivalsAction(clientId: number): Promise<Res<RivalsView>> {
  const { error } = await gate(clientId);
  if (error) return { ok: false, error };

  const list = await listCompetitors(clientId);
  return { ok: true, data: { rows: list.map((c) => ({ id: c.id, ...compareOne(c) })) } };
}

export async function addRivalAction(
  clientId: number,
  handle: string,
  label: string
): Promise<Res<null>> {
  const { user, error } = await gate(clientId);
  if (error || !user) return { ok: false, error: error ?? "Not allowed." };

  const added = await addCompetitor(clientId, handle, label || null, user.id);
  if (!added.ok) return { ok: false, error: added.error ?? "Couldn't add it." };

  // Read straight away, so a handle that cannot be read says so now rather
  // than looking like a competitor who posts nothing.
  const list = await listCompetitors(clientId);
  const fresh = list.find((c) => c.handle === handle.trim().replace(/^@+/, "").toLowerCase());
  if (fresh) await refreshCompetitor(clientId, fresh.id).catch(() => undefined);

  revalidatePath(`/clients/${clientId}/studio`);
  return { ok: true, data: null };
}

export async function removeRivalAction(clientId: number, id: number): Promise<Res<null>> {
  const { error } = await gate(clientId);
  if (error) return { ok: false, error };
  await removeCompetitor(clientId, id);
  revalidatePath(`/clients/${clientId}/studio`);
  return { ok: true, data: null };
}

export async function refreshRivalsAction(clientId: number): Promise<Res<RivalsView>> {
  const { error } = await gate(clientId);
  if (error) return { ok: false, error };

  const list = await listCompetitors(clientId);
  for (const c of list) await refreshCompetitor(clientId, c.id).catch(() => undefined);

  const after = await listCompetitors(clientId);
  return { ok: true, data: { rows: after.map((c) => ({ id: c.id, ...compareOne(c) })) } };
}

export async function gapsAction(clientId: number): Promise<Res<Gap[]>> {
  const { error } = await gate(clientId);
  if (error) return { ok: false, error };
  if (!modelConfigured()) {
    return { ok: false, error: "No model key is configured — add GEMINI_API_KEY to switch this on." };
  }
  if (!(await isEngineOn("competitors"))) {
    return { ok: false, error: "That engine is switched off. Turn it back on from the AI page." };
  }

  const gaps = await findGaps(clientId).catch(() => null);
  return gaps
    ? { ok: true, data: gaps }
    : {
        ok: false,
        error:
          "Nothing to compare yet — add a competitor whose account can actually be read, then refresh them.",
      };
}

/* ------------------------------ Comments ------------------------------ */

export async function commentsAction(clientId: number): Promise<Res<SentimentBoard>> {
  const { error } = await gate(clientId);
  if (error) return { ok: false, error };
  return { ok: true, data: await getBoard(clientId) };
}

/**
 * Pull the newest comments and sort the unclassified ones.
 *
 * Two steps in one press, because separately they are a sequence nobody
 * remembers the order of — and the fetch alone leaves a board full of
 * comments marked "not classified", which reads like a broken feature.
 */
export async function readCommentsAction(clientId: number): Promise<Res<SentimentBoard & { added: number; classified: number }>> {
  const { error } = await gate(clientId);
  if (error) return { ok: false, error };
  if (!(await isEngineOn("sentiment"))) {
    return { ok: false, error: "That engine is switched off. Turn it back on from the AI page." };
  }

  const pulled = await syncComments(clientId).catch(() => ({ ok: false, added: 0, error: "Instagram wouldn't answer." }));
  if (!pulled.ok && pulled.added === 0) {
    return { ok: false, error: pulled.error ?? "Couldn't read the comments." };
  }

  const { classified } = modelConfigured()
    ? await classifyPending(clientId).catch(() => ({ classified: 0 }))
    : { classified: 0 };

  revalidatePath(`/clients/${clientId}/studio`);
  const board = await getBoard(clientId);
  return { ok: true, data: { ...board, added: pulled.added, classified } };
}

export async function handleCommentAction(
  clientId: number,
  id: number,
  handled: boolean
): Promise<Res<null>> {
  const { error } = await gate(clientId);
  if (error) return { ok: false, error };
  await markHandled(clientId, id, handled);
  return { ok: true, data: null };
}

export async function themesAction(clientId: number): Promise<Res<string[]>> {
  const { error } = await gate(clientId);
  if (error) return { ok: false, error };
  if (!modelConfigured()) return { ok: false, error: "No model key is configured." };

  const list = await themes(clientId).catch(() => null);
  return list
    ? { ok: true, data: list }
    : { ok: false, error: "Not enough classified comments yet to call anything a theme." };
}
