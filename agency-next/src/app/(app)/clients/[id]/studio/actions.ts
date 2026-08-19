"use server";

import { revalidatePath } from "next/cache";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { isEngineOn, modelConfigured } from "@/lib/ai-engines";
import {
  contentStrategy,
  contentIdeas,
  generateScript,
  regenerateSection,
  thumbnailConcepts,
  seoPack,
  saveScript,
  ideaToTask,
  posterContent,
  posterIdeas,
  posterToTask,
  renderPosterBrief,
  type Idea,
  type PosterIdea,
  type Script,
  type ScriptInput,
  type ScriptSection,
} from "@/lib/content-ai";

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * The gate every tool passes through.
 *
 * Three separate refusals rather than one "unavailable", because the fix is
 * different each time: a client you may not open, an engine somebody switched
 * off, or no model key on the whole install.
 */
async function allow(clientId: number, engine: Parameters<typeof isEngineOn>[0]) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (!(await canAccessClient(user, clientId))) {
    return { user: null, error: "That client isn't one of yours." };
  }
  if (!modelConfigured()) {
    return { user: null, error: "No model key is configured — add GEMINI_API_KEY to switch this on." };
  }
  if (!(await isEngineOn(engine))) {
    return { user: null, error: "That engine is switched off. Turn it back on from the AI page." };
  }
  return { user, error: null };
}

/** The same sentence everywhere the model declines to answer. */
const REFUSED = "The model didn't return anything usable. Try again — it is usually transient.";

export async function strategyAction(clientId: number, month: string): Promise<Result<unknown>> {
  const { error } = await allow(clientId, "strategist");
  if (error) return { ok: false, error };

  const data = await contentStrategy(clientId, month).catch(() => null);
  return data ? { ok: true, data } : { ok: false, error: REFUSED };
}

export async function ideasAction(clientId: number, count: number): Promise<Result<unknown>> {
  const { error } = await allow(clientId, "ideas");
  if (error) return { ok: false, error };

  const data = await contentIdeas(clientId, count).catch(() => null);
  return data?.length ? { ok: true, data } : { ok: false, error: REFUSED };
}

export async function scriptAction(clientId: number, input: ScriptInput): Promise<Result<unknown>> {
  const { error } = await allow(clientId, "scripts");
  if (error) return { ok: false, error };
  if (!input.topic?.trim()) return { ok: false, error: "What is the script about?" };

  const data = await generateScript(clientId, input).catch(() => null);
  return data ? { ok: true, data } : { ok: false, error: REFUSED };
}

export async function regenerateSectionAction(
  clientId: number,
  input: ScriptInput,
  current: Script,
  section: ScriptSection
): Promise<Result<string>> {
  const { error } = await allow(clientId, "scripts");
  if (error) return { ok: false, error };

  const text = await regenerateSection(clientId, input, current, section).catch(() => null);
  return text ? { ok: true, data: text } : { ok: false, error: REFUSED };
}

export async function saveScriptAction(
  clientId: number,
  title: string,
  body: string,
  platform?: string
): Promise<Result<number>> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (!(await canAccessClient(user, clientId))) {
    return { ok: false, error: "That client isn't one of yours." };
  }
  if (!body.trim()) return { ok: false, error: "Nothing to save." };

  const id = await saveScript({
    clientId,
    title: title.trim() || "Untitled script",
    body,
    platform,
    createdBy: user.id,
  });
  return id
    ? { ok: true, data: id }
    : { ok: false, error: "The scripts table isn't in this database yet." };
}

export async function thumbnailsAction(
  clientId: number,
  topic: string,
  platform?: string
): Promise<Result<unknown>> {
  const { error } = await allow(clientId, "thumbnails");
  if (error) return { ok: false, error };
  if (!topic.trim()) return { ok: false, error: "What is the thumbnail for?" };

  const data = await thumbnailConcepts(clientId, { topic, platform, count: 3 }).catch(() => null);
  return data?.length ? { ok: true, data } : { ok: false, error: REFUSED };
}

export async function seoAction(
  clientId: number,
  topic: string,
  city?: string
): Promise<Result<unknown>> {
  const { error } = await allow(clientId, "seo");
  if (error) return { ok: false, error };
  if (!topic.trim()) return { ok: false, error: "What subject should it rank for?" };

  const data = await seoPack(clientId, { topic, city: city || null }).catch(() => null);
  return data ? { ok: true, data } : { ok: false, error: REFUSED };
}

/**
 * An idea becomes a task on the board.
 *
 * The one action here that writes something a team will act on, so it goes
 * through the same access check as the rest and records who created it.
 */
export async function ideaToTaskAction(
  clientId: number,
  idea: Idea,
  dueDate?: string
): Promise<Result<number>> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (!(await canAccessClient(user, clientId))) {
    return { ok: false, error: "That client isn't one of yours." };
  }
  if (!idea?.topic?.trim()) return { ok: false, error: "That idea has no topic." };

  const id = await ideaToTask({ clientId, idea, dueDate: dueDate || null, createdBy: user.id });
  revalidatePath("/deliverables");
  revalidatePath(`/clients/${clientId}`);
  return id ? { ok: true, data: id } : { ok: false, error: "Couldn't create the task." };
}


/* ------------------------------ Posters ------------------------------ */

/**
 * The poster half of the studio.
 *
 * The same two steps the video side has — what to make, then what goes on
 * it — because a poster brief written on the way to the designer is where
 * the month's posters all end up saying the same thing.
 */
export async function posterIdeasAction(clientId: number, count: number): Promise<Result<unknown>> {
  const { error } = await allow(clientId, "posters");
  if (error) return { ok: false, error };

  const data = await posterIdeas(clientId, count).catch(() => null);
  return data?.length ? { ok: true, data } : { ok: false, error: REFUSED };
}

export async function posterCopyAction(
  clientId: number,
  input: { topic: string; kind?: string; occasion?: string }
): Promise<Result<unknown>> {
  const { error } = await allow(clientId, "posters");
  if (error) return { ok: false, error };
  if (!input.topic?.trim()) return { ok: false, error: "What is the poster about?" };

  const data = await posterContent(clientId, {
    topic: input.topic,
    kind: input.kind,
    occasion: input.occasion?.trim() || null,
  }).catch(() => null);
  return data
    ? { ok: true, data: { ...data, brief: renderPosterBrief(data) } }
    : { ok: false, error: REFUSED };
}

/** A poster idea onto the board, with its kind and its brief on it. */
export async function posterToTaskAction(
  clientId: number,
  idea: PosterIdea,
  brief?: string,
  dueDate?: string
): Promise<Result<number>> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  if (!(await canAccessClient(user, clientId))) {
    return { ok: false, error: "That client isn't one of yours." };
  }
  if (!idea?.topic?.trim()) return { ok: false, error: "That idea has no topic." };

  const id = await posterToTask({
    clientId,
    idea,
    brief: brief || null,
    dueDate: dueDate || null,
    createdBy: user.id,
  });
  revalidatePath("/poster");
  revalidatePath("/deliverables");
  return id ? { ok: true, data: id } : { ok: false, error: "Couldn't create the task." };
}
