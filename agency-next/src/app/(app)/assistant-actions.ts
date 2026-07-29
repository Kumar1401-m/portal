"use server";

import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { answerQuestion } from "@/lib/assistant";

export type AssistantReply = { ok: boolean; text: string };

/**
 * Answer a question for whoever is signed in. The user is resolved from the
 * session here — never passed in from the browser — so the scope of the answer
 * can't be tampered with by the caller.
 */
export async function askAssistant(question: string): Promise<AssistantReply> {
  const user = await requireUser(STAFF_ROLES);
  const q = String(question || "").slice(0, 500);
  try {
    return { ok: true, text: await answerQuestion(user, q) };
  } catch {
    return { ok: false, text: "Sorry — I couldn't reach the data just now. Try again in a moment." };
  }
}
