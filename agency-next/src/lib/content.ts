/**
 * Naming a piece of work from the copy written for it.
 *
 * What is left of a much larger module. There used to be a content desk here
 * — a board for writing the month's copy, batching it into WhatsApp messages
 * and sending it to a client for sign-off — and it is gone: content is
 * settled inside the agency now, and only the finished video is put in front
 * of anybody.
 *
 * These two survive because they are not about approval at all. A task the
 * month generator created is called "Video 6" until somebody names it, and
 * both the upload path and anything else that learns what a piece is about
 * use these to replace that placeholder — and only ever a placeholder.
 */
import { callJSON } from "./ai";

export const isPlaceholderTitle = (title: string): boolean =>
  /^(video|poster|reel|post)\s*\d+$/i.test(String(title || "").trim());

/**
 * A short title for a piece, from the copy that was just written for it.
 *
 * Only ever replaces a placeholder — a title somebody typed is theirs, and
 * silently rewriting it would be the portal editing a person's work. Returns
 * null when there is no model, when the copy is too thin to name, or when the
 * model answers with something unusable; the caller keeps the old title in
 * every one of those cases rather than treating any of them as a failure.
 */
export async function suggestTitle(
  body: string,
  companyName?: string | null
): Promise<string | null> {
  const copy = String(body || "").trim();
  // Under a few words there is nothing to summarise, and a "title" derived
  // from three of them is just those three words again.
  if (copy.length < 25) return null;

  const { data } = await callJSON(
    [
      "You name social-media posts for a marketing agency's internal board.",
      "Given the copy for one post, reply with JSON: {\"title\":\"...\"}",
      "The title is read by the team, not the client. Make it say what the post is about.",
      "Three to six words. No quotes, no emoji, no hashtags, no full stop.",
      "Use the language of the copy's subject, but write the title in English.",
    ].join(" "),
    `${companyName ? `Client: ${companyName}\n` : ""}Copy:\n${copy.slice(0, 1500)}`
  );

  const raw = typeof data?.title === "string" ? data.title.trim() : "";
  if (!raw) return null;

  // Trimmed rather than trusted: models add quotes and trailing stops however
  // firmly they are asked not to, and a stray one ends up on the board.
  const title = raw.replace(/^["'“”\s]+|["'“”.\s]+$/g, "").slice(0, 120);
  // A model that echoes the placeholder back has told us nothing.
  if (!title || isPlaceholderTitle(title)) return null;
  return title;
}
